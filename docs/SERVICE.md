# Running Nightshift as a service

`node src/cli.js serve` is the long-running process. Run exactly one per state
directory; a second one refuses to start while the first holds the lease. These
unit files are examples and have not been installed or tested on the VM. Replace
every path, and pick the agents spec only after its smoke check has passed.

Closing a terminal or browser never stops a service started this way. Stop it
through the service manager; it finishes the current step, then exits.

## macOS (launchd)

Save as `~/Library/LaunchAgents/local.nightshift.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.nightshift</string>
  <key>WorkingDirectory</key><string>/ABSOLUTE/PATH/TO/nightshift</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>src/cli.js</string>
    <string>serve</string>
    <string>--agents</string><string>simulated</string>
    <string>--state</string><string>/ABSOLUTE/PATH/TO/state</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardErrorPath</key><string>/ABSOLUTE/PATH/TO/state/serve.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.nightshift.plist
launchctl kickstart -k gui/$(id -u)/local.nightshift     # restart
launchctl bootout gui/$(id -u)/local.nightshift          # stop
```

A LaunchAgent runs only while you are logged in, which matches CLI sign-ins
stored in your login keychain. `KeepAlive` restarts it after a crash but not
after a clean stop.

## Linux (systemd, user service)

Save as `~/.config/systemd/user/nightshift.service`:

```ini
[Unit]
Description=Nightshift supervisor

[Service]
WorkingDirectory=/ABSOLUTE/PATH/TO/nightshift
ExecStart=/usr/bin/node src/cli.js serve --agents simulated --state /ABSOLUTE/PATH/TO/state
Restart=on-failure
KillSignal=SIGTERM
TimeoutStopSec=330

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now nightshift
loginctl enable-linger "$USER"   # keep running after logout
journalctl --user -u nightshift -f
```

`TimeoutStopSec` should exceed the per-turn timeout (five minutes) so a stop waits
for the current turn instead of killing it. A killed turn is blocked on restart.

## Live agents

For `--agents codex`, `claude`, or a pairing, add `--repo /path` and the matching
`NIGHTSHIFT_*_VERSION` (and optional `NIGHTSHIFT_*_BIN`) variables to the unit's
environment. The service account must already be signed in to that CLI. Claude
requires a claude.ai subscription sign-in; `ANTHROPIC_*` variables in the unit are
removed before each turn and never used. The adapters are still read-only
inspections; see the setup docs for each provider.

## Daily use

```sh
node src/cli.js report --state /path/to/state --since "$(date -v-1d +%Y-%m-%dT%H:%M)"   # macOS
node src/cli.js report --state /path/to/state --since "$(date -d yesterday -Iminutes)"   # Linux
```
