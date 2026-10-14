import { mkdirSync, openSync, writeFileSync, readFileSync, renameSync, closeSync, fsyncSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.file = join(directory, 'state.json');
    this.lock = join(directory, 'runner.lock');
    this.owned = false;
  }

  acquire() {
    mkdirSync(this.directory, { recursive: true });
    try { mkdirSync(this.lock); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('State is locked; check runner.lock before attempting recovery.');
      throw error;
    }
    this.owned = true;
    try { writeFileSync(join(this.lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); }
    catch (error) { this.release(); throw error; }
  }

  assertOwner() {
    if (!this.owned) throw new Error('Acquire the store lock first.');
  }

  read() {
    this.assertOwner();
    let text;
    try { text = readFileSync(this.file, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 1, paused: false, tasks: [], events: [] };
      throw error;
    }
    const state = JSON.parse(text);
    if (state.version !== 1 || !Array.isArray(state.tasks) || !Array.isArray(state.events)) {
      throw new Error('Unsupported or invalid state file; refusing to overwrite it.');
    }
    return state;
  }

  save(state) {
    this.assertOwner();
    const temporary = `${this.file}.${process.pid}.tmp`;
    const fd = openSync(temporary, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(state, null, 2) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { renameSync(temporary, this.file); }
    catch (error) { unlinkSync(temporary); throw error; }
  }

  release() {
    if (this.owned) {
      rmSync(this.lock, { recursive: true });
      this.owned = false;
    }
  }
}
