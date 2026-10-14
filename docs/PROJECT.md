# Project brief

## Outcome

Given a clear brief, requirements, and a repository, Nightshift should autonomously
advance a bounded project queue, implement and verify changes, handle routine
reversible decisions, and leave reviewable results for its owner.

The owner should be able to sleep or disconnect all viewing devices without
repeatedly sending "continue". The Mac Studio and its VM remain online.

## Confirmed direction

- Local execution in the existing always-on environment; no cloud compute requirement.
- A supervisor coordinating agents and deciding what to do next.
- Codex and Claude support, beginning with Codex.
- Willingness to use CLI/SDK runtimes underneath a friendly app.
- Easy remote inspection, steering, pause, and manual takeover.
- Shared project context and tools, with controlled ownership of writable resources.
- A dedicated repository for the project.

## Proposed defaults (changeable)

- Working name: Nightshift.
- Node.js backend, responsive browser interface, optional desktop packaging later.
- One active worker per project initially; separate review pass.
- New managed sessions seeded from a project brief; desktop-history migration deferred.
- Private access and private Git hosting unless the owner chooses otherwise.

## User flow

1. Select a local repository and write or import a project brief.
2. Refine measurable acceptance criteria and a prioritized task queue.
3. Choose the agent, permitted actions, and resource limits.
4. Start unattended work; inspect live progress when desired.
5. Resolve decisions or take over a session from a phone or computer.
6. Review a morning report with diffs, checks, assumptions, blockers, and next steps.

For ideation, tasks should have concrete outputs: compare approaches, run a
feasibility experiment, prototype a candidate, or record a design decision.

## MVP acceptance criteria

- A real Codex task starts and receives follow-up instructions through a supported
  programmatic interface, without interacting with the desktop app.
- Closing the browser does not stop its backend session or supervisor.
- The queue advances only after recorded verification, with bounded repair attempts.
- A blocked task does not stop other independent ready tasks.
- Reconnection restores durable project state and conversation events.
- Restart reconciles in-flight work without duplicate dispatch or silent abandonment.
- Pause prevents new dispatch; interrupt and manual takeover have explicit ownership.
- Required approvals appear as blockers and remain subject to configured permissions.
- A second device can inspect and control the project through authenticated access.
- Reports identify simulated, unverified, failed, and verified results accurately.

## Deferred

Multi-user SaaS, public hosting, automatic deployment/merging, arbitrary desktop
chat control, full chat-history synchronization, and a large parallel agent fleet.

## Decisions needed before live deployment

VM operating system; actual repository locations; preferred remote-access path;
provider authentication and billing; nightly time/token/spend limits; and which
commands and repository writes may execute unattended. These do not block the
current simulated core.
