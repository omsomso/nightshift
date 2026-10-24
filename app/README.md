# Nightshift app

The macOS entry point to Nightshift: a window, a menu-bar icon, and notifications.

- **Plan Studio** (New Plan): paste your quick notes and press Start Interview. Claude
  (read-only) works out which project in your workspace they are about, reads the code
  and the project's rules, asks a few multiple-choice questions (click the options, or
  answer in your own words), and writes the complete roadmap in the right-hand pane,
  where you can edit it. Save and Draft Plan writes it into the project and drafts the
  plan. Choose who works and who reviews (Codex is listed even when turned off). Open an
  Existing Document… drafts from a file you already have.
- **Drafts** can switch who works and who reviews before Approve and Start.
- **Plans**: every plan in `~/.nightshift/plans` with progress, blockers, limits, project
  rules, and the runner log; Approve and Start, Pause/Resume, Stop Turn, Start/Stop
  Runner, Retry, Open Worktree, Report, and Approve and Merge (with confirmation).
- **Plan view**: a colored next-step panel with the buttons that matter now. Ready plans:
  Review Changes (per-task diffs, verdicts, checks) and Approve (merge locally or open a
  pull request; the arrow offers the other). Blocked plans: Retry, Fix with Claude (opens
  Claude in Terminal in the worktree, already briefed; the brief is also on the clipboard),
  Accept Fix, and More (skip, start or stop the runner). Drafts: Approve and Start, Check
  Readiness, Edit (tasks, checks, allowed paths), and Add to Queue. Running plans show a
  live Activity card. Plans waiting at a usage limit say when they continue.
- **Queue**: queued plans show "Queued #n"; the sidebar's Queue bar starts the queue.
- **Settings** (⌘,): **Accounts** (versions, sign-ins, on/off, setup, effort); **Runs**
  (usage limits: wait or stop; sandboxed checks and network; approval: merge or pull
  request; start runners again at login); **Usage** (tokens per day and per plan).
- Notifications when a plan newly needs you or is ready to merge.

The app does no orchestration itself: every action runs `node src/cli.js …`, using the
paths that `node src/cli.js setup` records in `~/.nightshift/config.json`. Run setup
first.

## Build

```sh
app/build.sh                 # builds app/build/Nightshift.app (ad-hoc signed, local use)
open app/build/Nightshift.app
```

Requires macOS 14 or newer. The script uses Xcode's toolchain when Xcode is installed,
because the Command Line Tools' `swift-package` on this Mac failed to load (a library
mismatch). Copy the app to /Applications if you want it in Launchpad. The icon is drawn by
`app/icon/make_icon.swift`; run `app/icon/make-icns.sh` to rebuild `Resources/AppIcon.icns`.

Development aids: `NIGHTSHIFT_OPEN_SHEET=review|edit` opens that sheet for the plan
selected with `NIGHTSHIFT_SELECT=<id>`; `NIGHTSHIFT_SETTINGS_TAB=runs|usage` with
`NIGHTSHIFT_OPEN_SETTINGS=1` opens that tab; `NIGHTSHIFT_SNAPSHOT=<dir>` renders each plan's view to PNG and quits
(native controls appear as placeholders); `NIGHTSHIFT_OPEN_STUDIO=1` opens Plan Studio at
launch, and `NIGHTSHIFT_STUDIO_DEMO=1` fills it with a sample conversation (`=busy` shows
the typing state).

## Verified

2026-10-14: built with Swift 6.4 (Xcode toolchain) on macOS 26.6; plan views rendered
against fixture plans. 2026-10-15: Plan Studio, Accounts, and the icon build cleanly;
the CLI commands behind them (`chat`, `providers`, `login`, `enable`/`disable`,
`setup`, `draft`) are covered by the Node tests, and a live plan-chat turn returned
project rules correctly. The owner checked Plan Studio and Accounts on screen. 2026-10-15 (later): the notes-first
Plan Studio was screenshotted in both phases (intake, and a sample interview with question
chips and the roadmap pane); a live interview turn picked the right project from the
workspace and returned four structured questions. 2026-10-15 (evening): Plan Studio
shows questions one at a time as option rows (explanation, Recommended badge, number keys,
Back/Next), animates messages, shows a typing indicator, has a Stop button (⌘.) that ends
Claude's turn, and a "Starts from" branch picker. The demo and busy states were
screenshotted (`NIGHTSHIFT_STUDIO_DEMO=1` or `=busy`); Stop and the picker against a live
turn were not clicked through on screen. Drafts show work the plan leaves out and have a
Check Readiness button (`check --plan <id> --json`, stoppable) that shows each check's
result and the tail of a failing one; Plan Studio lists left-out work under Starts from.
The draft view was rendered offscreen and the check's JSON decoded by the app's types; the
button was not clicked on screen. 2026-10-16: any plan can be deleted from the app
(Delete… in the plan view, right-click in the sidebar, or the Delete key), with a
confirmation that says what is lost; it runs `stop` if needed, then `discard --yes`. The
button was screenshotted and its command run on a fixture plan; the confirmation dialog
was not clicked on screen. 2026-10-16 (later): the plan view is organized in sections: a
header (status pill and a ⋯ menu with Open Worktree, Open Repository, Show Report, Delete),
a colored "next step" panel that says what the plan needs and holds its main buttons,
then Before you start (drafts), Overview, Tasks (progress bar, current task highlighted),
Limits, and a collapsed Runner log. Plan Studio's roadmap shows its revision, who changed
it and when, lines added and removed, flashes on each change, notes it in the chat, and
offers Restore Previous; edits you make go to Claude with your next message. Draft,
ready-to-merge, and Studio views were screenshotted; the blocked and running panels were
not (no such plan was available).
2026-10-16 (evening): review sheet, draft editor, Activity card, queue bar, waiting and
pull-request states, Fix with Claude, Accept Fix, and the Runs and Usage settings tabs were
screenshotted against fixture plans (ready, blocked, waiting at a usage limit, pull request
open, queued draft). Not clicked through on screen: Fix with Claude (it opens Terminal and a
real Claude session), the merge/pull-request confirmations, and saving an edited draft from
the sheet (the `edit` command behind it is tested).
2026-10-20: merged plans move to a collapsible Archive in the sidebar (the app runs
`nightshift sync` at launch and every two minutes, so merges on GitHub or by hand are noticed);
pull requests use GitHub's colours (open green, merged purple); the Limits card has
Change… (all limits, applied at once, also to the turn in progress); a paused plan says
who paused it and why; long panel texts fold with Show more. Screenshotted against the
owner's real plans (archive, merged panel, limits editor).
2026-10-24: a task's facts are one row of badges (difficulty, which opens a chooser on
drafts and shows the planner's reason on hover; effort; attempts; skipped or fixed by
you); Settings › Accounts has a Models section; Overview shows the model the agents ran
on; Plan Studio's placeholder and demo are generic. Screenshotted against demo plans.
