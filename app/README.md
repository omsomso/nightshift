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
- **Accounts** (Settings, ⌘,): installed and pinned versions, sign-in status with a Sign In
  button (subscription only; opens the browser), on/off per provider, and Run Setup.
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

Development aids: `NIGHTSHIFT_SNAPSHOT=<dir>` renders each plan's view to PNG and quits
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
turn were not clicked through on screen.
