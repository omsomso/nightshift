# Nightshift

A personal, local-first workspace that keeps coding agents moving while you are away.

**Status: supervisor core plus initial Codex and Claude adapters.**
Both adapters share one set of worker/reviewer prompts and are tested against
subprocess fixtures. Either provider can be the worker or the reviewer. Claude has
Both have completed live, read-only worker/reviewer runs, including Codex work reviewed by Claude.
Both are restricted to subscription billing (claude.ai, ChatGPT).
The web interface is not implemented.
The default demo is simulated and does not call a model or spend API credits.

## Why

The owner runs a Mac Studio 24/7 with a VM and currently uses remotely accessible
Codex and Claude desktop chats. Nightshift will own programmatic agent sessions,
give them a persistent project queue, verify results, and expose a remote-friendly
chat interface. Closing the interface must not stop the supervisor.

## Try it

Requires Node.js 22.13 or newer (for built-in SQLite). No dependency installation is needed.

```sh
npm test
npm run demo
npm run status
```

The demo seeds two tasks in `.nightshift/nightshift.db`, executes them with a simulated
adapter and reviewer, and prints their saved status. Repeating it does not duplicate
completed tasks. `node src/cli.js demo ./another-demo` uses a separate state directory.

## Run it as a service

`serve` keeps running: it dispatches ready tasks, then waits for more. Other commands
talk to it through the state database, so they work from another terminal while it runs.

```sh
node src/cli.js serve --agents simulated            # or claude, codex, codex:claude --repo /path
node src/cli.js add --id docs --title "Document setup" --acceptance "README lists the steps."
node src/cli.js pause                                # stops new dispatch at the next boundary
node src/cli.js resume
node src/cli.js retry <task-id>                      # requeue a blocked task you have reconciled
node src/cli.js report --since 2026-10-14T00:00Z     # Markdown morning report
```

`serve` pauses itself after `--max-dispatches` (default 20) and stays paused across
restarts until you resume. Ctrl-C or SIGTERM stops after the current step. See
`docs/SERVICE.md` for starting it automatically at boot.

The core supports dependency ordering, persisted attempt limits, independent review
before completion, continuing past blocked tasks, and conservative recovery of
interrupted work. State lives in SQLite with an append-only event log. One runner
holds an expiring lease, and every write checks it. Live provider runs are still
read-only inspections; workspace writes come later.

## Project map

- `docs/PROJECT.md`: product requirements and acceptance criteria.
- `docs/ARCHITECTURE.md`: session ownership, adapters, remote access, and persistence.
- `docs/ROADMAP.md`: ordered implementation backlog and next-agent handoff.
- `src/supervisor.js`: queue and verification state machine.
- `src/store.js`: SQLite state, append-only events, runner lease, and command queue.
- `src/cli.js`: demo, status, serve, add, pause, resume, retry, and report commands.
- `src/report.js`: morning report rendering.
- `src/providers.js`: version-checked provider setup shared by `serve` and `smoke`.
- `src/prompts.js`: provider-neutral worker/reviewer prompts and result schemas.
- `src/adapters/`: simulated, Codex, and Claude workers and reviewers (`agent.js` is shared).
- `src/codex/`: App Server JSONL transport, session management, and turn events.
- `src/claude/`: headless `claude -p` session, read-only flags, and stream events.
- `src/jsonl.js`: line framing shared by both transports.
- `src/smoke.js`: version-checked, read-only compatibility run for any provider pairing.
- `src/repair-check.js`: live check that a failed review resumes both saved sessions (`npm run repair:check`).
- `docs/CODEX_SETUP.md`, `docs/CLAUDE_SETUP.md`: setup, verified behavior, and recovery notes.
- `docs/SERVICE.md`: running `serve` under launchd (macOS) or systemd (Linux).
- `test/supervisor.test.js`: behavioral checks for unattended execution.
- `test/service.test.js`: store, lease, command, serve-loop, and report tests.
- `test/codex.test.js`, `test/claude.test.js`: subprocess protocol and persisted session tests.

## Next milestone

Run the live compatibility checks on the machine that will host Nightshift:
`npm run codex:smoke` (see `docs/CODEX_SETUP.md`), `npm run claude:smoke` (see
`docs/CLAUDE_SETUP.md`), and one mixed pairing such as `npm run smoke -- codex:claude`.
Resolve any protocol mismatch they reveal. Both adapters are read-only for now.
Live interrupt, workspace writes, and the authenticated responsive UI come after this
checkpoint.

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
