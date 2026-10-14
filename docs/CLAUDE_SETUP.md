# Claude compatibility checkpoint

The Claude adapter runs the Claude Code CLI in headless mode (`claude -p`) as a
local child process, one process per turn. It mirrors the Codex checkpoint: a
read-only repository inspection followed by a separate review conversation.
Like Codex, it does not implement unattended editing, remote access, or a daemon.

## Before running

1. Install Node.js 22.13 or newer and the Claude Code CLI on the machine that runs Nightshift.
2. Sign the CLI in with your claude.ai account: `claude auth login`. `claude auth status`
   should report `claude.ai`. API keys are refused (see Billing below). The desktop
   app's sign-in does not carry over to the CLI.
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

## Billing: subscription only

Nightshift runs Claude only on a claude.ai subscription sign-in (Pro, Max, Team, or
Enterprise). In headless mode an `ANTHROPIC_API_KEY` would silently outrank that
sign-in, so three guards stop pay-per-token billing:

1. **Stripped environment.** Every `ANTHROPIC_*` variable (API key, auth token, base
   URL, profile, federation) and every `CLAUDE_CODE_USE_*` cloud-provider switch is
   removed before `claude` starts, for both turns and the startup check.
2. **Startup check.** `smoke` and `serve` run `claude auth status` with that same
   environment and refuse to start unless it reports `authMethod: "claude.ai"`.
3. **Per-turn check.** If a turn's init message reports any `apiKeySource` other than
   `"none"` (for example an `apiKeyHelper` from managed settings), the process is killed
   at once, the task is blocked, and the whole queue pauses with a `billing-guard` event.

There is deliberately no setting to turn these off. Changing that requires a code
change, so an agent cannot enable API billing by editing configuration.
`--restricted` also keeps user, project, and local settings files (where an
`apiKeyHelper` could live) out of each turn.

Verified 2026-10-14: the startup check reads `claude.ai max` on the development Mac,
and a real turn with the stripped environment completed with `apiKeySource: "none"`.
Not verified: whether the init message always arrives before the first model request.
Guard 3 is a backstop; guards 1 and 2 are the main protection.

Outside Nightshift, set these on your account; no agent run by Nightshift can change them:

- claude.ai → Settings → Usage → **Usage credits**: leave off, or set a monthly limit.
  Without credits, reaching the plan limit pauses work instead of charging.
- If you have a Claude Console (API) account, set a spend limit there or keep no keys.

Unattended runs share the plan's usage limits with your interactive use. A run that
hits the limit fails and blocks its task. `--max-budget-usd` (default 2) stays as a
per-turn cap in case the guards are ever bypassed.

## Recovery

As with Codex, an interrupted run is blocked on restart rather than replayed. The
saved session ID can be inspected with `claude --resume <id>` from the repository
directory. Terminating the process does not undo earlier effects.

Official reference: https://code.claude.com/docs/en/headless
