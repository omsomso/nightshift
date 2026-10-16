# Implementation backlog

## M0 — Repository and controller foundation

- [x] Project brief, architecture, and agent instructions.
- [x] Persistent task state with a single-runner lock (now a SQLite lease, M2).
- [x] Dependency selection, bounded repair attempts, and blocked-task skipping.
- [x] Separate review step and conservative interrupted-run recovery.
- [x] Simulated end-to-end demo and behavioral tests.

## M1 — One real task per provider (next)

- [ ] Record the VM OS and install/authenticate a specific Codex version there.
- [x] Generate App Server schemas for codex-cli 0.162.1 and fix mismatches (dev Mac; see docs/CODEX_SETUP.md).
- [x] Implement local stdio initialization, thread start/resume, and turn streaming (fixture-tested).
- [x] Persist session IDs and correlate responses, errors, and approval requests (fixture-tested).
- [x] Exercise one harmless repository task with an evidence-based review (codex:codex passed, dev Mac).
- [x] Exercise a review failure and resumed repair turn on a real run (Claude and Codex; `npm run repair:check`).
- [x] Test disconnect, process failure, stale state, and permission blockers against protocol fixtures.
- [ ] Repeat compatibility/failure checks against the installed Codex build on the VM.
- [x] Claude headless-CLI adapter with the same session, event, and blocker handling (fixture-tested).
- [x] Real `claude` 2.1.296 accepts the read-only flag set and stream shape (unsigned probe only).
- [x] Sign the Claude CLI in and run `npm run claude:smoke` once (2026-10-14, dev Mac, passed).
- [x] Subscription-only Claude billing guard: stripped env, startup sign-in check, per-turn kill (live-checked).
- [x] ChatGPT-only Codex billing guard: stripped env, forced ChatGPT login, startup and per-session account checks (live-checked).
- [x] Run one mixed pairing (`npm run smoke -- codex:claude`, passed on the dev Mac).
- [x] Record Codex token usage per turn and merge streamed output events (live-checked).

Exit: one real task and follow-up run through each adapter without desktop clicks.

## M2 — Durable unattended service

- [x] SQLite migrations and append-only event log (built-in `node:sqlite`; JSON import).
- [x] Runner lease with heartbeat, write fencing, and safe takeover from an exited runner.
- [ ] Provider reconciliation after restart (inspect a saved thread before retrying).
- [x] Dispatch cap that persists as a pause; per-turn timeouts; bounded attempts.
- [ ] Token/spend caps across a night and stagnation detection.
- [x] Pause, resume, and manual retry from other processes via a command queue.
- [x] Live interrupt of a running turn as explicit manual takeover (`interrupt`; live-checked with Codex).
- [x] Long-running `serve` loop with clean shutdown; launchd/systemd examples (not installed).
- [x] Markdown morning report (`report --since`).

## M3 — Remote workspace

- [x] One-command run from a document (`run`), plan drafts, background runner, `list`, `merge`.
- [x] SwiftUI macOS app over the CLI: plans, progress, controls, notifications (`app/`).
- [x] Side-by-side comparison with a plain agent session (docs/COMPARISON.md).
- [x] Per-provider on/off switch (`disable`/`enable`); Codex is off on the dev Mac for now.
- [x] Project rules (AGENTS.md, CLAUDE.md, local and parent files) passed to every agent with Nightshift-wins precedence; expected git denials no longer block (live-checked with the plan chat).
- [x] `nightshift` command and skill for Claude Code and Codex, installed by `setup` (live-checked: a fresh session in VSTS found it).
- [x] App as entry point: Plan Studio, Accounts (status, sign-in, on/off, setup), icon (checked on screen by the owner).
- [x] Notes-first interview: Claude picks the project from the workspace, asks multiple-choice questions, writes the roadmap; worker/reviewer pickers; Codex listed when off (live-checked).
- [x] Effort: planner rates task difficulty; worker effort starts there and rises per retry; fixed reviewer and planner levels; owner bounds (Claude live-checked; Codex fixture-only).
- [x] Planner reads project rules (AGENTS.md, CLAUDE.md) and includes the files they require in allowed paths (prompt-level; not yet re-run live).
- [x] Final review judges only what the plan allows; a failed final phase becomes one bounded fix-up task (fixture-tested).

- [ ] Responsive project/task board and conversation viewer.
- [ ] Live streamed output, file diffs, and verification results.
- [ ] Private authenticated remote access and reconnect/event replay.
- [ ] Approval inbox and explicit ownership when a human takes over.
- [ ] Verify that closing all viewers does not stop work.

## M4 — Richer delegation

- [ ] Confirm which Claude account pays for unattended runs (subscription or API key).
- [x] Cross-provider review with shared prompts (fixture-tested; `smoke.js` pairings).
- [ ] Cross-provider review using shared artifacts and explicit task context.
- [x] Edit mode: one worktree per plan, Nightshift-run checks and gates, Nightshift commits, owner merges (docs/EDIT_MODE.md).
- [x] OS sandboxes for edit-mode workers (Claude bash sandbox, Codex workspace-write; no network) — live-probed.
- [x] Plans start from the fetched main branch (or `--base`), not the current checkout; planning reads a snapshot of that commit; merge targets that branch.
- [x] `check`: readiness before drafting or starting (left-out work, checks at the start commit); Check Readiness in the app.
- [x] Run project checks in a sandbox too (a VSTS cmake step wrote outside the worktree): `src/sandbox.js`.
- [x] Wait for subscription usage-limit resets instead of failing; queue plans; restart runners at login.
- [x] Review screen, draft editing, live activity, usage view, owner fixes (Fix with Claude, accept), pull-request approval.
- [ ] Check a real Claude/Codex usage-limit message against `src/limits.js` (only fixture shapes are tested).
- [ ] Concurrent tasks within one plan and controlled integration between plans.
- [ ] Bounded research/ideation tasks with recorded decision evidence.

## Handoff

Finish M1 using docs/CODEX_SETUP.md and docs/CLAUDE_SETUP.md. Do not build the full
dashboard before proving live session control. Both adapters implement documented
protocol subsets. On the development Mac, codex:codex, claude:claude, and codex:claude
read-only runs have all passed review (see the setup docs). Edit mode completed two live
plans on a toy project (claude:codex and codex:claude; see docs/EDIT_MODE.md).
Neither adapter has run on the owner's VM or accessed existing chats. Commands run from
an agent sandbox may lack network access to OpenAI; run live checks from a normal terminal.
Run `npm test` (139 tests) and `npm run demo` for the offline baseline. The live smoke
commands are separate and can consume provider usage. Their version pins are operator
checks, not declarations that a specific release has been certified.
