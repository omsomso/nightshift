# Plain agent session vs Nightshift (2026-10-15)

Same task, same starting commit (`e6388a5`): the ten steps in
`docs/PLAN_COMPARISON.md` (small CLI and store improvements to Nightshift itself,
each with tests). Development Mac, claude 2.1.296 (Opus 5.5, Max plan), codex-cli
0.162.1 (ChatGPT plan). Both ran with no network and writes confined to their
worktree.

- **A, plain session:** one headless `claude -p` told to implement all ten steps,
  run `npm test` after each, and commit each step.
- **B, Nightshift:** `node src/cli.js run docs/PLAN_COMPARISON.md --agents claude:codex --yes`
  (Claude works, Codex reviews; planner drafted the tasks from the document).

## Results

| | A: plain Claude | B: Nightshift (claude:codex) |
| --- | --- | --- |
| Wall-clock | 6 min | 23 min |
| Steps committed | 10/10 | 10/10 |
| Tests at the end (verified independently) | 108 pass, 0 fail | 110 pass, 0 fail |
| Change size | 365+ / 15− in 10 files | 358+ / 25− in 10 files |
| Tokens | 3.76 M (Claude only; list price $1.97) | 3.56 M Claude (list price $3.75) + 1.22 M Codex |
| Repair loops | none visible | 2 (`discard`, per-task report) |
| Ended as | "all done", with an honest list of caveats | **blocked** by the final review |
| Owner action needed | review and merge | fix or override the final review, then merge |

Edge cases probed on both branches with a throwaway home:

| Probe | A | B |
| --- | --- | --- |
| `logs ..`, `logs ../outside` | exit 1 (unknown plan) | exit 0; `../outside` **printed a file outside the plans folder** |
| `discard ..`, `discard ../outside --yes` | exit 1 | exit 1 |
| `discard <draft>` without / with `--yes` | refuses / removes | refuses / removes |
| `limit bogus 5` | exit 1, lists valid names | exit 1, lists valid names |
| `report --json` without `--plan` | exit 1 | exit 1 |
| Checks `git push`, `git  commit`, `npm test && git reset --hard` | rejected | rejected |
| Check `git -C . push origin` | accepted (A's agent disclosed this gap) | accepted |

## What happened inside Nightshift

- The Codex reviewer rejected Claude's first `discard`: it treated any existing
  directory as a draft, so `discard .. --yes` could have deleted the whole Nightshift
  home. The second attempt fixed it with regression tests. (A's `discard` never had
  this problem: it requires an existing plan or draft.)
- The final review rejected the finished plan for two reasons: the real `logs ..`
  path-traversal bug above, and missing roadmap/test-count updates that the project's
  AGENTS.md asks for, but that the plan's allowed paths (`src/`, `test/`, `README.md`)
  made impossible.

## Conclusions

- For a short, well-specified plan like this, the plain session was about four times
  faster, used about half the total tokens, and produced the slightly better result.
- Nightshift's independent reviewer earned its keep twice: it stopped a dangerous first
  version of `discard`, and it refused to call the plan done while `logs` could read
  outside its folder. A plain session has no such second opinion; here it happened not
  to need one.
- Nightshift has two clear flaws, both now on the roadmap: the final review can demand
  work outside the plan's allowed paths (the planner should read project rules such as
  AGENTS.md and include the files they require, and the final review should judge only
  what the plan allows), and a failed final review just blocks instead of turning its
  findings into one bounded fix-up task.
- Practical guidance: use a plain session for short plans you will look at soon; use
  Nightshift for long or overnight plans, risky changes, or when you want a second
  model to check the work before you see it.

Follow-up (same day): branch A was merged into `main`, and both Nightshift flaws were
addressed: the planner now reads project rules, reviews judge only within the plan's
allowed paths, and a failed final phase becomes one bounded fix-up task. These fixes
are covered by fixture tests; the comparison itself has not been re-run.

Branches: A is `compare/plain` (worktree `.nightshift/compare/plain`); B is
`nightshift/cli-store-polish` (plan `cli-store-polish`, blocked; not merged).
