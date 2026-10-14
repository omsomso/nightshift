# Nightshift

A personal, local-first workspace that keeps coding agents moving while you are away.

**Status: supervisor core plus initial Codex and Claude adapters.**
Both adapters share one set of worker/reviewer prompts and are tested against
subprocess fixtures. Either provider can be the worker or the reviewer. Neither has
completed a live signed-in run yet. The web interface is not implemented.
The default demo is simulated and does not call a model or spend API credits.

## Why

The owner runs a Mac Studio 24/7 with a VM and currently uses remotely accessible
Codex and Claude desktop chats. Nightshift will own programmatic agent sessions,
give them a persistent project queue, verify results, and expose a remote-friendly
chat interface. Closing the interface must not stop the supervisor.

## Run the first milestone

Requires Node.js 22 or newer. No dependency installation is needed.

```sh
npm test
npm run demo
npm run status
```

The demo seeds two tasks in `.nightshift/state.json`, executes them with a simulated
adapter and reviewer, and prints their saved status. Repeating it does not duplicate
completed tasks. To create a separate demo state:

```sh
node src/cli.js demo ./another-demo
```

The core already supports dependency ordering, persisted attempt limits, independent
review before completion, continuing past blocked tasks, and conservative recovery
of interrupted work. Each runner exclusively locks its state directory. State writes
use temporary files and atomic rename. This is a single-process bootstrap, not a
production database or a live-agent daemon.

## Project map

- `docs/PROJECT.md`: product requirements and acceptance criteria.
- `docs/ARCHITECTURE.md`: session ownership, adapters, remote access, and persistence.
- `docs/ROADMAP.md`: ordered implementation backlog and next-agent handoff.
- `src/supervisor.js`: queue and verification state machine.
- `src/store.js`: local state and exclusive runner lock.
- `src/prompts.js`: provider-neutral worker/reviewer prompts and result schemas.
- `src/adapters/`: simulated, Codex, and Claude workers and reviewers (`agent.js` is shared).
- `src/codex/`: App Server JSONL transport, session management, and turn events.
- `src/claude/`: headless `claude -p` session, read-only flags, and stream events.
- `src/jsonl.js`: line framing shared by both transports.
- `src/smoke.js`: version-checked, read-only compatibility run for any provider pairing.
- `docs/CODEX_SETUP.md`, `docs/CLAUDE_SETUP.md`: setup, verified behavior, and recovery notes.
- `test/supervisor.test.js`: behavioral checks for unattended execution.
- `test/codex.test.js`, `test/claude.test.js`: subprocess protocol and persisted session tests.

## Next milestone

Run the live compatibility checks on the machine that will host Nightshift:
`npm run codex:smoke` (see `docs/CODEX_SETUP.md`), `npm run claude:smoke` (see
`docs/CLAUDE_SETUP.md`), and one mixed pairing such as `npm run smoke -- codex:claude`.
Resolve any protocol mismatch they reveal. Both adapters are read-only for now.
Workspace writes, daemon management, and the authenticated responsive UI come after
this checkpoint.

## Git and remote setup

This directory is a Git repository on branch `main`. No hosting provider, remote,
or open-source license has been selected. The portable archive includes its initial
Git history. After extracting it, a GitHub CLI user can create a private repository:

```sh
gh repo create nightshift --private --source=. --remote=origin --push
```

Run that command from this directory only after authenticating to the intended
GitHub account. Alternatively, create an empty repository in your preferred Git
host, add its URL as `origin`, and push `main`.
