import { mkdirSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// Each entry upgrades the schema by one version. Never edit an applied migration.
const migrations = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE tasks (id TEXT PRIMARY KEY, position INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
   CREATE TABLE events (seq INTEGER PRIMARY KEY, task_id TEXT, type TEXT NOT NULL, detail TEXT, at TEXT NOT NULL);
   CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
   CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
   CREATE TABLE lease (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, pid INTEGER NOT NULL,
     host TEXT NOT NULL, acquired_at TEXT NOT NULL, expires_at INTEGER NOT NULL);
   CREATE TABLE commands (seq INTEGER PRIMARY KEY, type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL, applied_at TEXT);`
];
const emptyState = () => ({ version: 1, paused: false, tasks: [], events: [] });

function open(file, { readOnly = false } = {}) {
  const db = new DatabaseSync(file, { readOnly, timeout: 5000 });
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    const { user_version: current } = db.prepare('PRAGMA user_version').get();
    if (current > migrations.length) { db.close(); throw new Error('State was written by a newer Nightshift; refusing to modify it.'); }
    for (let version = current; version < migrations.length; version++) {
      transaction(db, () => { db.exec(migrations[version]); db.exec(`PRAGMA user_version = ${version + 1}`); });
    }
  }
  return db;
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const value = work(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function load(db) {
  const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map(row => [row.key, JSON.parse(row.value)]));
  return {
    version: 1, paused: meta.paused ?? false, ...(meta.project ? { project: meta.project } : {}), ...(meta.plan ? { plan: meta.plan } : {}),
    tasks: db.prepare('SELECT data FROM tasks ORDER BY position').all().map(row => JSON.parse(row.data)),
    events: db.prepare('SELECT task_id, type, detail, at FROM events ORDER BY seq').all()
      .map(row => ({ taskId: row.task_id, type: row.type, detail: JSON.parse(row.detail), at: row.at }))
  };
}

// SQLite state with an append-only event log. One runner holds an expiring lease;
// every write checks that lease, so a runner that lost it cannot overwrite a successor.
export class Store {
  constructor(directory, { leaseMs = 60_000 } = {}) {
    this.directory = directory;
    this.file = join(directory, 'nightshift.db');
    this.legacyFile = join(directory, 'state.json');
    this.leaseMs = leaseMs;
    this.owner = null;
    this.db = null;
    this.persistedEvents = 0;
  }

  // Reads without a lease, for status and reports. Never creates or migrates anything.
  static inspect(directory) {
    const file = join(directory, 'nightshift.db');
    if (!existsSync(file)) {
      const legacy = join(directory, 'state.json');
      return existsSync(legacy) ? JSON.parse(readFileSync(legacy, 'utf8')) : emptyState();
    }
    const db = open(file, { readOnly: true });
    try {
      const pendingCommands = db.prepare('SELECT COUNT(*) AS n FROM commands WHERE applied_at IS NULL').get().n;
      return { ...load(db), pendingCommands };
    } finally { db.close(); }
  }

  // Queues a control command for the runner; safe while a runner holds the lease.
  static enqueue(directory, type, payload = null) {
    mkdirSync(directory, { recursive: true });
    const db = open(join(directory, 'nightshift.db'));
    try {
      db.prepare('INSERT INTO commands (type, payload, created_at) VALUES (?, ?, ?)')
        .run(type, JSON.stringify(payload), new Date().toISOString());
    } finally { db.close(); }
  }

  acquire() {
    mkdirSync(this.directory, { recursive: true });
    if (existsSync(join(this.directory, 'runner.lock'))) {
      throw new Error('A pre-SQLite runner.lock exists; verify its process has exited, then remove it.');
    }
    this.db = open(this.file);
    const owner = randomUUID();
    try {
      transaction(this.db, () => {
        const held = this.db.prepare('SELECT * FROM lease WHERE id = 1').get();
        if (held) {
          const sameHost = held.host === hostname();
          if (!sameHost || pidAlive(held.pid)) {
            const where = sameHost ? `process ${held.pid}` : `host ${held.host}`;
            throw new Error(Date.now() < held.expires_at
              ? `State is locked by ${where}; stop that runner first.`
              : `State lease expired, but ${where} may still be running; verify it has stopped before recovery.`);
          }
        }
        const now = new Date().toISOString();
        this.db.prepare('INSERT OR REPLACE INTO lease (id, owner, pid, host, acquired_at, expires_at) VALUES (1, ?, ?, ?, ?, ?)')
          .run(owner, process.pid, hostname(), now, Date.now() + this.leaseMs);
        if (held) {
          this.db.prepare('INSERT INTO events (task_id, type, detail, at) VALUES (NULL, ?, ?, ?)')
            .run('lease-recovered', JSON.stringify(`Previous runner ${held.pid} had exited.`), now);
        }
      });
      this.owner = owner;
      this.importLegacy();
    } catch (error) {
      if (this.owner) this.release();
      else { this.db.close(); this.db = null; }
      throw error;
    }
  }

  // One-time import of a JSON snapshot from Nightshift 0.3 or earlier.
  importLegacy() {
    if (!existsSync(this.legacyFile)) return;
    const legacy = JSON.parse(readFileSync(this.legacyFile, 'utf8'));
    if (legacy.version !== 1 || !Array.isArray(legacy.tasks) || !Array.isArray(legacy.events)) {
      throw new Error('Unsupported or invalid state.json; refusing to import it.');
    }
    if (this.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n) {
      throw new Error('Both state.json and SQLite tasks exist; reconcile them manually.');
    }
    this.save({ ...legacy, events: [...this.read().events, ...legacy.events] });
    renameSync(this.legacyFile, `${this.legacyFile}.imported`);
  }

  assertOwner() {
    if (!this.owner) throw new Error('Acquire the store lease first.');
  }

  holdsLease() {
    const held = this.db.prepare('SELECT owner FROM lease WHERE id = 1').get();
    if (held?.owner !== this.owner) throw new Error('Runner lease was lost; stop dispatching and restart.');
  }

  read() {
    this.assertOwner();
    const state = load(this.db);
    this.persistedEvents = state.events.length;
    return state;
  }

  save(state) {
    this.assertOwner();
    if (state.events.length < this.persistedEvents) throw new Error('Refusing to rewrite the append-only event log.');
    transaction(this.db, () => {
      this.holdsLease();
      const meta = this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
      meta.run('paused', JSON.stringify(Boolean(state.paused)));
      if (state.project) meta.run('project', JSON.stringify(state.project));
      if (state.plan) meta.run('plan', JSON.stringify(state.plan));
      const task = this.db.prepare('INSERT OR REPLACE INTO tasks (id, position, status, data) VALUES (?, ?, ?, ?)');
      state.tasks.forEach((item, index) => task.run(item.id, index, item.status, JSON.stringify(item)));
      const event = this.db.prepare('INSERT INTO events (task_id, type, detail, at) VALUES (?, ?, ?, ?)');
      for (const item of state.events.slice(this.persistedEvents)) {
        event.run(item.taskId ?? null, item.type, JSON.stringify(item.detail ?? null), item.at);
      }
    });
    this.persistedEvents = state.events.length;
  }

  heartbeat() {
    this.assertOwner();
    const { changes } = this.db.prepare('UPDATE lease SET expires_at = ? WHERE id = 1 AND owner = ?')
      .run(Date.now() + this.leaseMs, this.owner);
    if (!changes) throw new Error('Runner lease was lost; stop dispatching and restart.');
  }

  // Returns unapplied control commands in order and marks them applied.
  takeCommands() {
    this.assertOwner();
    return transaction(this.db, () => {
      this.holdsLease();
      const rows = this.db.prepare('SELECT seq, type, payload FROM commands WHERE applied_at IS NULL ORDER BY seq').all();
      const mark = this.db.prepare('UPDATE commands SET applied_at = ? WHERE seq = ?');
      for (const row of rows) mark.run(new Date().toISOString(), row.seq);
      return rows.map(row => ({ seq: row.seq, type: row.type, payload: JSON.parse(row.payload) }));
    });
  }

  release() {
    if (!this.db) return;
    if (this.owner) {
      try { this.db.prepare('DELETE FROM lease WHERE id = 1 AND owner = ?').run(this.owner); }
      finally { this.owner = null; }
    }
    this.db.close();
    this.db = null;
  }
}
