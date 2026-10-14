# Working on Nightshift

Read README.md and docs/ROADMAP.md before implementing a milestone.

- Preserve the local-first Mac Studio/VM deployment and remote-friendly UI direction.
- Keep orchestration state separate from model conversation history.
- Use provider session IDs and structured events. Do not automate desktop chat clicks.
- Keep simulated behavior visibly labeled; never present it as a live integration.
- Worker completion is not verified task completion. Retain an independent review step.
- Never automatically retry work whose external effects are uncertain after a crash.
- Respect provider permissions. Record approval blockers; do not silently approve them.
- Keep authentication secrets and runtime state out of Git.
- Billing is subscription-only. Do not add API-key support, an opt-out setting, or weaken
  the Claude billing guard (docs/CLAUDE_SETUP.md) unless the owner explicitly asks.
  Never run `claude auth login --console`, `claude setup-token`, or set API-key variables.
- Do not add autonomous merge, deployment, purchase, or outbound messaging by default.
- Prefer small, reviewable milestones. Run `npm test` for state-machine changes.
- Update the roadmap and document what was verified and what remains untested.
- No remote repository or application deployment is configured yet.
