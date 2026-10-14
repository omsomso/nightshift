# Implementation backlog

## M0 — Repository and controller foundation

- [x] Project brief, architecture, and agent instructions.
- [x] Persistent task state with a single-runner lock (now a SQLite lease, M2).
- [x] Dependency selection, bounded repair attempts, and blocked-task skipping.
- [x] Separate review step and conservative interrupted-run recovery.
- [x] Simulated end-to-end demo and behavioral tests.

## M1 — One real task per provider (next)

- [ ] Record the VM OS and install/authenticate a specific Codex version there.
- [ ] Generate its App Server schemas and document protocol compatibility.
- [x] Implement local stdio initialization, thread start/resume, and turn streaming (fixture-tested).
- [x] Persist session IDs and correlate responses, errors, and approval requests (fixture-tested).
- [ ] Exercise one harmless repository task and an evidence-based review/fix turn.
- [x] Test disconnect, process failure, stale state, and permission blockers against protocol fixtures.
- [ ] Repeat compatibility/failure checks against the installed Codex build on the VM.
- [x] Claude headless-CLI adapter with the same session, event, and blocker handling (fixture-tested).
- [x] Real `claude` 2.1.296 accepts the read-only flag set and stream shape (unsigned probe only).
- [x] Sign the Claude CLI in and run `npm run claude:smoke` once (2026-10-14, dev Mac, passed).
- [ ] Exercise a Claude review failure and resumed repair turn on a real run.
- [ ] Run one mixed pairing (`npm run smoke -- codex:claude`).

Exit: one real task and follow-up run through each adapter without desktop clicks.

## M2 — Durable unattended service

- [x] SQLite migrations and append-only event log (built-in `node:sqlite`; JSON import).
- [x] Runner lease with heartbeat, write fencing, and safe takeover from an exited runner.
- [ ] Provider reconciliation after restart (inspect a saved thread before retrying).
- [x] Dispatch cap that persists as a pause; per-turn timeouts; bounded attempts.
- [ ] Token/spend caps across a night and stagnation detection.
- [x] Pause, resume, and manual retry from other processes via a command queue.
- [ ] Live interrupt of a running turn and explicit manual takeover.
- [x] Long-running `serve` loop with clean shutdown; launchd/systemd examples (not installed).
- [x] Markdown morning report (`report --since`).

## M3 — Remote workspace

- [ ] Responsive project/task board and conversation viewer.
- [ ] Live streamed output, file diffs, and verification results.
- [ ] Private authenticated remote access and reconnect/event replay.
- [ ] Approval inbox and explicit ownership when a human takes over.
- [ ] Verify that closing all viewers does not stop work.

## M4 — Richer delegation

- [ ] Confirm which Claude account pays for unattended runs (subscription or API key).
- [x] Cross-provider review with shared prompts (fixture-tested; `smoke.js` pairings).
- [ ] Cross-provider review using shared artifacts and explicit task context.
- [ ] Separate worktrees for concurrent tasks and controlled integration.
- [ ] Bounded research/ideation tasks with recorded decision evidence.

## Handoff

Finish M1 using docs/CODEX_SETUP.md and docs/CLAUDE_SETUP.md. Do not build the full
dashboard before proving live session control. Both adapters implement documented
protocol subsets. No Codex executable is installed in the development workspace.
The Claude adapter completed one signed-in, read-only worker/reviewer run on the
development Mac (see docs/CLAUDE_SETUP.md); it has not edited files. Neither adapter
has run on the owner's VM or accessed existing chats.
Run `npm test` (59 tests) and `npm run demo` for the offline baseline. The live smoke
commands are separate and can consume provider usage. Their version pins are operator
checks, not declarations that a specific release has been certified.
