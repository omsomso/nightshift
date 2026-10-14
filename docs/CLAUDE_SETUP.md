# Claude compatibility checkpoint

The Claude adapter runs the Claude Code CLI in headless mode (`claude -p`) as a
local child process, one process per turn. It mirrors the Codex checkpoint: a
read-only repository inspection followed by a separate review conversation.
Like Codex, it does not implement unattended editing, remote access, or a daemon.

## Before running

1. Install Node.js 22.13 or newer and the Claude Code CLI on the machine that runs Nightshift.
2. Sign the CLI in: `claude auth login` (subscription) or set `ANTHROPIC_API_KEY`
   (pay-per-token API billing). `claude auth status` shows which one is active.
   The desktop app's sign-in does not carry over to the CLI.
3. Choose a non-sensitive test repository first.
4. Run `npm test`. These tests use a stand-in CLI and do not contact Anthropic.
5. Check the installed version: `claude --version`.

## Run

```sh
export NIGHTSHIFT_CLAUDE_VERSION='paste the exact claude --version output here'
npm run claude:smoke -- /absolute/path/to/test-repository
```

Mixed pairings run one provider as worker and the other as reviewer. Both versions
must be pinned:

```sh
npm run smoke -- codex:claude /absolute/path/to/test-repository
npm run smoke -- claude:codex /absolute/path/to/test-repository
```

| Setting | Purpose |
| --- | --- |
| `NIGHTSHIFT_CLAUDE_BIN` | Absolute path to the `claude` executable if it is not on PATH |
| `NIGHTSHIFT_CLAUDE_MODEL` | A model alias or full ID; omitted uses the CLI default |
| `NIGHTSHIFT_CLAUDE_MAX_BUDGET_USD` | Per-turn spending cap passed to `--max-budget-usd` (default `2`) |
| Third positional argument | A separate directory for smoke-test state |

Default state lives in `.nightshift/<worker>-smoke` or `.nightshift/<worker>-<reviewer>-smoke`.
A state directory is tied to one repository, pairing, and set of pinned versions.

## Read-only policy

Each turn passes these flags (checked against `claude --help` for 2.1.296):

- `--tools Read,Grep,Glob` and `--allowedTools Read,Grep,Glob`: no shell, edit, or web tools exist.
- `--permission-mode dontAsk --permission-prompts none`: anything that would ask is denied.
- `--restricted`: file tools stay inside the repository; settings-file hooks are not loaded.
- `--strict-mcp-config` with no MCP config: no MCP servers.
- `--session-id` for a new conversation, `--resume` for a saved one. Nightshift picks the
  ID and saves it before the process starts.

The prompt goes over stdin, not the command line. Any denied tool request is recorded
as an `approval-required` event and blocks the task; nothing is approved automatically.

## What was verified (2026-10-14, claude 2.1.296, macOS)

- The CLI accepts the full flag set above, reports only `Glob, Grep, Read` plus its
  structured-output tool, and loads no MCP servers.
- The init message carries the chosen `session_id`, a `uuid`, and `apiKeySource`.
- Without sign-in, the result is `subtype: "success"` with `is_error: true`; the adapter
  reports this as `Claude turn error: Not logged in`.

First signed-in run (`claude:claude` on the Nightshift repository itself, claude.ai Max
sign-in, model `claude-opus-5-5`):

- Worker and reviewer ran as separate sessions; the task passed review on attempt 1.
- Tools used: Read, Grep, Glob, and `StructuredOutput` (the CLI's `--json-schema`
  tool) only. No permission was denied and nothing prompted.
- The structured result arrived as a JSON object; the reviewer independently re-checked
  the worker's cited files and noted which checks were not run.
- Reported notional cost: about $0.23 (15 model turns) for the worker and $0.15
  (10 turns) for the reviewer. On a subscription this counts against plan limits.
- `apiKeySource` in the init message reads `"none"` under a subscription sign-in, so it
  does not show who pays. `buildAgents` records `claude auth status` instead, keeping
  only method and plan (for example `claude.ai max`) as `project.claudeAuth`.

Still unverified: resume of a saved session (needs a review failure and repair turn),
the `--max-budget-usd` cap being hit, a denial on a real run, and timeout behavior.

## Billing

The CLI uses whatever it is signed in with. A subscription sign-in draws on that
plan's usage limits; an API key is billed per token, and `--max-budget-usd` caps each
turn. The development Mac is signed in with a claude.ai Max plan. Decide which account
Nightshift should use before unattended runs.

## Recovery

As with Codex, an interrupted run is blocked on restart rather than replayed. The
saved session ID can be inspected with `claude --resume <id>` from the repository
directory. Terminating the process does not undo earlier effects.

Official reference: https://code.claude.com/docs/en/headless
