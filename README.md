# Nightshift

A personal, local-first workspace that keeps coding agents moving while you are away.

**Status: repository bootstrap, with a tested supervisor core and simulated worker.**
No live Codex/Claude adapter or web interface is implemented yet. The demo does not
call a model, modify a target repository, or spend API credits.

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
- `src/adapters/simulated.js`: explicitly simulated integration for development.
- `test/supervisor.test.js`: behavioral checks for unattended execution.

## Next milestone

Implement a version-pinned Codex App Server adapter and prove one real task can be
started, observed, reviewed, and continued from persisted session IDs. Then add the
background service and authenticated responsive UI. Claude follows through its own
adapter once authentication and billing requirements are confirmed.

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
