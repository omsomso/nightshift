# Nightshift app

A macOS window and menu-bar view over the Nightshift CLI. It lists every plan in
`~/.nightshift/plans`, shows progress, blockers, limits, and the runner log, and
offers the controls: approve and start a draft, pause or resume, stop the running
turn, start or stop the background runner, retry after a blocker, open the worktree,
show the report, and approve and merge a finished plan (with confirmation). It sends
a notification when a plan newly needs you or is ready to merge. New Plan drafts a
plan from a document; nothing runs until you approve it.

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
mismatch). Copy the app to /Applications if you want it in Launchpad.

`NIGHTSHIFT_SNAPSHOT=<dir>` renders each plan's view to PNG and quits (a development
aid; native controls appear as placeholders in those images).

## Verified (2026-10-14)

Built with Swift 6.4 (Xcode toolchain) on macOS 26.6. Rendered against fixture plans
in the ready-to-merge, blocked, and draft states. Clicking through the controls in the
live window has not been verified by the developer; each control maps to a CLI command
covered by the Node test suite.
