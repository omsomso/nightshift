# Plan: CLI and store polish (comparison run)

Ten small improvements to Nightshift, used to compare a plain agent session with a
Nightshift run on the same starting commit. Each step must come with tests, and
`npm test` must pass after every step. Do not change behavior outside each step.

1. **`logs` command.** `node src/cli.js logs <id> [--lines n]` prints the last `n`
   lines (default 40) of the plan's `serve.log` in `~/.nightshift/plans/<id>`. An
   unknown plan id exits with code 1 and a clear message.

2. **`discard` command.** `node src/cli.js discard <id> --yes` removes a plan:
   for a draft, its directory; for a started plan that is not merged, its worktree,
   its `nightshift/<id>` branch, and its directory. Without `--yes` it exits 1 and
   explains what would be removed. It refuses while the plan's runner is alive and
   refuses merged plans (exit 1).

3. **Validate limit names early.** `node src/cli.js limit <name> <value>` exits 1
   with the list of valid limit names when `<name>` is not a known limit, instead
   of queuing a command that the runner rejects later.

4. **Forbid history-changing checks.** Plan validation rejects any check command
   containing `git push`, `git commit`, `git reset`, or `git rebase`, naming the
   offending check.

5. **Show the current task in `list`.** In text mode, `list` prints a second line
   `now: <task title>` for a plan whose task is running or in review.

6. **Per-task detail in the report.** The plan section of `report` lists every task
   with its attempt count and the result of its most recent checks
   (`checks passed`, `checks failed`, or `no checks yet`).

7. **Index the event log.** A second store migration adds an index on
   `events(task_id)`. Existing version-1 databases upgrade to version 2 on open,
   keeping all events.

8. **Choose the base commit.** `draft` and `run` accept `--base <ref>`; the plan
   records it and its worktree starts from that commit instead of `HEAD`.

9. **One plan as JSON.** `node src/cli.js report --plan <id> --json` prints that
   plan's summary object (the same shape as one entry of `list --json`).

10. **Document the new commands.** The README's command overview describes `logs`,
    `discard`, `--base`, and `report --json`.
