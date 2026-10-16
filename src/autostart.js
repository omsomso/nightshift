import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { home, readConfig } from './home.js';

// Runners do not survive a restart by themselves. With autostart on, a login item (a
// per-user LaunchAgent) runs `nightshift resume-runners` at login, which starts the runner
// of every plan whose runner was on and not stopped by the owner.
export const label = 'com.nightshift.runners';
const agentsDir = () => process.env.NIGHTSHIFT_LAUNCH_AGENTS ?? join(homedir(), 'Library', 'LaunchAgents');
export const plistPath = () => join(agentsDir(), `${label}.plist`);
const cliFile = fileURLToPath(new URL('./cli.js', import.meta.url));
// Tests set NIGHTSHIFT_LAUNCHD=0 so nothing is registered with the real launchd.
const launchctl = args => {
  if (process.env.NIGHTSHIFT_LAUNCHD === '0') return;
  try { execFileSync('/bin/launchctl', args, { stdio: 'ignore' }); } catch {}
};
const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function autostartStatus() {
  return { enabled: existsSync(plistPath()), plist: plistPath() };
}

export function setAutostart(enabled) {
  const uid = process.getuid();
  if (!enabled) {
    launchctl(['bootout', `gui/${uid}/${label}`]);
    rmSync(plistPath(), { force: true });
    return autostartStatus();
  }
  const node = readConfig().node ?? process.execPath;
  mkdirSync(agentsDir(), { recursive: true });
  mkdirSync(home(), { recursive: true });
  const args = [node, cliFile, 'resume-runners'].map(a => `    <string>${escape(a)}</string>`).join('\n');
  writeFileSync(plistPath(), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escape(process.env.PATH ?? '/usr/bin:/bin')}</string>
    <key>NIGHTSHIFT_HOME</key><string>${escape(home())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${escape(join(home(), 'autostart.log'))}</string>
  <key>StandardErrorPath</key><string>${escape(join(home(), 'autostart.log'))}</string>
</dict>
</plist>
`);
  launchctl(['bootout', `gui/${uid}/${label}`]);
  launchctl(['bootstrap', `gui/${uid}`, plistPath()]);
  return autostartStatus();
}
