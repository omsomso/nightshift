# Implementation backlog

## M0 — Repository and controller foundation

- [x] Project brief, architecture, and agent instructions.
- [x] Persistent task state with a single-runner lock.
- [x] Dependency selection, bounded repair attempts, and blocked-task skipping.
- [x] Separate review step and conservative interrupted-run recovery.
- [x] Simulated end-to-end demo and behavioral tests.

## M1 — One real Codex task (next)

- [ ] Record the VM OS and install/authenticate a specific Codex version there.
- [ ] Generate its App Server schemas and document protocol compatibility.
- [ ] Implement local stdio initialization, thread start/resume, and turn streaming.
- [ ] Persist session IDs and correlate responses, errors, and approval requests.
- [ ] Exercise one harmless repository task and an evidence-based review/fix turn.
- [ ] Test disconnect, process failure, stale state, and permission blockers.

Exit: one real task and follow-up run through the adapter without desktop clicks.

## M2 — Durable unattended service

- [ ] SQLite migrations and append-only event log.
- [ ] Dispatch leases and provider reconciliation after restart.
- [ ] Resource caps, timeouts, bounded retries, and stagnation detection.
- [ ] Pause, interrupt, manual takeover, and controlled resume.
- [ ] OS-managed startup and a morning report.

## M3 — Remote workspace

- [ ] Responsive project/task board and conversation viewer.
- [ ] Live streamed output, file diffs, and verification results.
- [ ] Private authenticated remote access and reconnect/event replay.
- [ ] Approval inbox and explicit ownership when a human takes over.
- [ ] Verify that closing all viewers does not stop work.

## M4 — Claude and richer delegation

- [ ] Confirm Claude authentication/billing and implement its adapter.
- [ ] Cross-provider review using shared artifacts and explicit task context.
- [ ] Separate worktrees for concurrent tasks and controlled integration.
- [ ] Bounded research/ideation tasks with recorded decision evidence.

## Handoff

Start with M1. Do not build the full dashboard before proving session control.
The current scaffold uses only simulated workers: it has not connected to the
owner's VM, accessed their existing chats, or executed a live coding agent.
Run `npm test` and `npm run demo` to establish the bootstrap baseline.
