# Codex compatibility checkpoint

The first live integration is a read-only repository inspection followed by a
separate Codex review. This checkpoint is intentionally small. It does not implement
unattended code editing, remote UI access, or a background daemon yet.

## Before running

1. Extract the repository on your always-on VM. Install Node.js 22.13 or newer.
2. Install Codex through its supported installation flow and sign in there.
3. Choose a non-sensitive test repository first. Confirm its Codex configuration,
   tools, hooks, and permissions match what you want available to the agent.
4. Run `npm test` from Nightshift. These tests do not contact OpenAI.
5. Check the installed version and generate the matching protocol schema:

```sh
codex --version
codex app-server generate-json-schema --out .nightshift/codex-schema
```

Keep the schema output and version together; compare fields before changing the pin.

### Schema comparison: codex-cli 0.162.1 (2026-10-14, macOS, Homebrew cask)

All methods Nightshift uses exist: `initialize`, `initialized`, `account/read`,
`thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`, and the notifications
`item/agentMessage/delta`, `item/completed`, `turn/completed`, and `error`. Turn, item,
thread-status, and error shapes match the adapter. Two values did not match and were fixed:

| Field | Was sending | Schema expects |
| --- | --- | --- |
| `thread/start` / `thread/resume` `sandbox` | `readOnly` | `read-only` (turn-level `sandboxPolicy.type` stays `readOnly`) |
| `approvalPolicy` | `unlessTrusted` | one of `untrusted`, `on-request`, `never`; Nightshift uses `never` (see below) |

## Run on the VM

From the Nightshift directory, set the expected version to the exact output printed
above. The example below deliberately requires you to supply that value:

```sh
export NIGHTSHIFT_CODEX_VERSION='paste the exact codex --version output here'
npm run codex:smoke -- /absolute/path/to/test-repository
```

Optional settings:

| Setting | Purpose |
| --- | --- |
| `NIGHTSHIFT_CODEX_BIN` | Absolute path to the Codex executable if it is not on PATH |
| `NIGHTSHIFT_CODEX_MODEL` | An available model identifier; omitted uses the runtime default |
| Second positional argument | A separate directory for smoke-test state |

The command verifies the executable version and repository path, then uses existing
Codex authentication. It never reads or prints authentication tokens. The run draws on
your ChatGPT plan's usage. This smoke test limits dispatches to two worker attempts and
sets a five-minute deadline per turn.

## Billing: ChatGPT plan only

Nightshift runs Codex only on a ChatGPT sign-in. Four guards stop API-key billing:

1. **Stripped environment.** `OPENAI_*`, `AZURE_OPENAI_*`, and `CODEX_API_KEY` never reach
   `codex`, for sessions or the startup check.
2. **Codex enforces it too.** The App Server starts with `-c forced_login_method="chatgpt"`.
3. **Startup check.** `smoke` and `serve` refuse to start unless `codex login status`
   reports `Logged in using ChatGPT`. The status line is never echoed, because an
   API-key line contains part of the key.
4. **Per-session check, before any thread exists.** `account/read` must return
   `type: "chatgpt"`, and `thread/start` must report `modelProvider: "openai"`
   (Nightshift also requests it). Otherwise a `BillingGuardError` blocks the task and
   pauses the queue. Only account type and plan type are recorded, never the email.

There is no setting to turn these off. Verified live on 2026-10-14: account `chatgpt`,
plan `prolite`, provider `openai`, default model `gpt-6-astra`.

## Sandbox and approvals

The adapter requests a `read-only` sandbox and approval policy `never` on sessions and
turns; Codex reports the sandbox as `{"type":"readOnly","networkAccess":false}`.
`never` means Codex never asks: commands run inside the read-only sandbox, and anything
needing a write or network access fails there and is reported back to the model.
Nightshift approves nothing. This mirrors the Claude adapter's `dontAsk` mode.

The first live run used `untrusted` instead. Codex reads files by running shell commands
and asked for approval on the first one outside its built-in safe list; Nightshift
correctly recorded that as a blocker, so the inspection could not proceed. Any request
that still arrives (for example from an MCP tool) is recorded with its command and blocks
the task.

The sandbox is a filesystem and network policy, not a complete restriction on external integrations:
review your configured MCP tools and hooks first. Prompts also prohibit edits and external changes.
Any incoming approval or input request is recorded as a blocker; the adapter does
not auto-approve it. Start with a minimal tool configuration.

## What was verified (2026-10-14, codex-cli 0.162.1, macOS, ChatGPT prolite)

- `codex:codex`: the worker inspected this repository with 5 read-only shell commands
  (`rg`, `cat`, `sed`); a separate Codex reviewer re-checked with 6 more and passed it
  on attempt 1. No approval requests arrived under `never`.
- `codex:claude`: Codex worker, Claude reviewer; passed on attempt 1.
- The App Server streamed output as `item/agentMessage/delta` and finished with
  `item/completed` (agentMessage) and `turn/completed`, as the adapter expects.

Repair loop, verified live 2026-10-14 (`npm run repair:check -- codex <repo>` harness,
first review replaced by a labelled forced failure with one extra requirement): attempt 2
resumed the same saved worker thread, addressed the requirement, and the reviewer resumed
its own thread and passed it.

Usage: each `thread/tokenUsage/updated` notification's `last` covers one model request;
Nightshift sums them per turn into a `usage` event (`requests`, `tokens` with input,
cached input, output, and reasoning output) and keeps the thread `total`. Verified live:
on a new thread the per-request sum equals Codex's total exactly (worker: 4 requests,
97,063 input tokens, 61,056 cached, 1,140 output). Codex reports no cost; it draws on the
ChatGPT plan. Streamed text is merged before saving (per 4 KB, 5 seconds, or item
boundary): 8 output events for that run instead of about 938.

Not yet verified: turn interrupt and timeout behavior. A sandboxed agent shell may block
OpenAI's servers (`workspace routing discovery timed out`); run live checks from a normal terminal.

## Expected results

- A worker inspects the project and returns cited evidence.
- A distinct reviewer conversation inspects that evidence against the repository.
- The controller marks the task done, requests a bounded repair, or records a blocker.
- `.nightshift/codex-smoke/nightshift.db` (or `.nightshift/codex-claude-smoke/` for a mixed pairing) retains task status, thread/turn IDs, and events. Read it with `node src/cli.js report --state .nightshift/codex-smoke`.
- A repeated command does not replay a completed or blocked task.

Exit codes: `0` means all tasks passed review, `2` means some tasks remain incomplete,
and `1` means setup or controller failure. A review pass is model-based evidence
assessment, not proof of software correctness. The inspection task does not require
running build/test commands: those are reported from project documentation.

## Recovery and diagnostics

If the process is interrupted, do not delete its state and rerun blindly. Inspect
the saved IDs and reconcile the provider thread first. Startup blocks in-flight work
whose outcome is unknown. After reconciling, `node src/cli.js retry <task-id> --state <dir>`
requeues it. The backend does not yet provide a reconciliation UI.

A lease left by a crashed runner is taken over automatically once its PID has exited.
If the PID is still running (a hung runner, or a reused PID), the next runner refuses
to start; verify that process and stop it yourself. A `runner.lock` directory from
Nightshift 0.3 or earlier blocks startup until you confirm its process exited and remove it.

An approval event is historical evidence, not a currently answerable inbox entry.
The connection has closed; a future interaction must obtain a current request.
Interrupt requests and child termination do not guarantee that every tool process
has exited or that external side effects were undone.

State files may contain repository content and command output. Keep them private;
they are excluded from Git and release archives. Provider stderr is drained rather
than retained to reduce accidental credential logging.

## Evidence to bring back

Share the installed version, operating system, whether both sessions completed,
and any redacted protocol/error messages. Do not share credentials or full traces
containing private code. That evidence determines the next adapter corrections.

Official reference: https://developers.openai.com/codex/app-server
