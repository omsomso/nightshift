# Codex compatibility checkpoint

The first live integration is a read-only repository inspection followed by a
separate Codex review. This checkpoint is intentionally small. It does not implement
unattended code editing, remote UI access, or a background daemon yet.

## Before running

1. Extract the repository on your always-on VM. Install Node.js 22 or newer.
2. Install Codex through its supported installation flow and sign in there.
3. Choose a non-sensitive test repository first. Confirm its Codex configuration,
   tools, hooks, and permissions match what you want available to the agent.
4. Run `npm test` from Nightshift. These tests do not contact OpenAI.
5. Check the installed version and generate the matching protocol schema:

```sh
codex --version
codex app-server generate-json-schema --out .nightshift/codex-schema
```

This implementation follows the documented App Server interface reviewed on
2026-10-14. No actual Codex version has been certified in this development workspace.
Keep the schema output and version together; compare fields before changing the pin.

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
Codex authentication. It never reads or prints authentication tokens. The run calls
the provider and may consume your plan allowance or incur API charges according to
your configured authentication. There is no monetary/token cap yet: this smoke test
limits dispatches to two worker attempts and sets a five-minute deadline per turn.

The adapter requests `readOnly` and `unlessTrusted` on sessions and turns. This is a
filesystem policy, not a complete restriction on external integrations: review your
configured MCP tools and hooks first. Prompts also prohibit edits and external changes.
Any incoming approval or input request is recorded as a blocker; the adapter does
not auto-approve it. Start with a minimal tool configuration.

## Expected results

- A worker inspects the project and returns cited evidence.
- A distinct reviewer conversation inspects that evidence against the repository.
- The controller marks the task done, requests a bounded repair, or records a blocker.
- `.nightshift/codex-smoke/state.json` (or `.nightshift/codex-claude-smoke/` for a mixed pairing) retains task status, thread/turn IDs, and events.
- A repeated command does not replay a completed or blocked task.

Exit codes: `0` means all tasks passed review, `2` means some tasks remain incomplete,
and `1` means setup or controller failure. A review pass is model-based evidence
assessment, not proof of software correctness. The inspection task does not require
running build/test commands: those are reported from project documentation.

## Recovery and diagnostics

If the process is interrupted, do not delete its state and rerun blindly. Inspect
the saved IDs and reconcile the provider thread first. Startup blocks in-flight work
whose outcome is unknown. The backend does not yet provide a reconciliation UI.

If `runner.lock` remains, read its `owner.json`, verify that the owning process is
no longer running, and only then remove that lock directory. Never remove a lock
from an active runner. A stale PID may have been reused; verify the process identity.

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
