# Agent Platform

Local-first coordination for coding agents. Node.js 22+, with a Chinese/Japanese/English browser UI.

- Project-scoped agent registration, file claims and heartbeat leases.
- Persistent messages, handoff notes and task history.
- Custom HTML/CSS roadmaps with responsible editors and revision protection.
- Separate owner/agent APIs and loopback-only HTTP.

## Quick Start

Windows is the primary desktop environment. No production npm dependencies are required.

```powershell
git clone https://github.com/whaleinblack/agent_platform.git
cd agent_platform
node server.mjs --open
```

Or double-click `Start-Agent-Coordinator.cmd`. The launcher opens an authorized
owner page at `http://localhost:8793/`. Create a project in the UI, then register
agents using [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).

在网页中创建项目后，Agent 使用真实 ID、任务和文件列表登记，并保持心跳。
项目中的“路线图”允许负责 Agent 提交自定义 HTML/CSS，管理员可指定负责人和恢复历史版本。

```powershell
node cli.mjs projects
node cli.mjs join --project PROJECT_ID --agent ACTUAL_AGENT_ID --task "Implement feature" --file src/example.js --watch
```

From another terminal:

```powershell
node cli.mjs update --session SESSION_ID --progress "Tests passed"
node cli.mjs inbox --session SESSION_ID
node cli.mjs done --session SESSION_ID --summary "Ready for review"
```

## Configuration

- `AGENT_COORD_PORT`: default 8793.
- `AGENT_COORD_DATA`: service state, default `.data/`.
- `AGENT_COORD_CLIENT_DATA`: optional agent credential directory override.
- `Start-Agent-Coordinator-Background.vbs`: optional Windows background launcher.
  Windows autostart requires manually creating a Startup shortcut; it is not installed automatically.
- `Set-Agents-Host.ps1`: optional administrator-run hosts setup. Use `http://agents:8793/`.
  Bare `http://agents/` additionally needs a separately configured local redirect service.
  The optional alias adapter does nothing without `.data/aliases.json`.

Browser aliases redirect to localhost for consistent cookies. Windows launchers
and automatic browser sign-in are Windows-specific; the backend and CLI use Node.js.

## Tests

```powershell
npm install
npm test
npx playwright install chromium
node tests/roadmap.browser.cjs
```

Set `PLAYWRIGHT_CHANNEL=msedge` to use an installed Edge browser instead.
Tests use temporary state and synthetic projects, never your live project data.

## Source Layout

- `lib/coordinator.mjs`: persistent state, leases and claims.
- `lib/http-server.mjs`: HTTP API and access checks.
- `lib/client.mjs`, `cli.mjs`: agent client and command line.
- `public/`: owner UI, multilingual interface and roadmap editor.
- `tests/`: unit, API and browser regression tests.

## Security and Data

This is a local, single-user coordination tool, not a multi-tenant security boundary.
Agent IDs are self-declared; claims are cooperative, not OS-enforced file locks.
Do not expose the service to the LAN or Internet.

Never publish `.data/`, custom state/credential directories, logs or screenshots.
They can contain credentials, private messages and project paths. Roadmap HTML is
sandboxed: scripts, forms, parent access and external resources are blocked.
Managed task cancellation covers the direct child only, not a whole process tree.

## License

MIT. Third-party icon notices are retained in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `public/icons.LICENSE`.

## Roadmap themes

Roadmap previews follow the platform's resolved light/dark/system setting and
update automatically on theme changes. Authors must use the `--roadmap-*`
semantic colors and starter in [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md#roadmap-theme-authoring-standard).
Existing saved HTML is preserved; hardcoded colors inside cards, SVGs or images
need migration to the variables. No filters or sandbox exceptions are used.
Run `node tests/roadmap-theme.browser.cjs` for the theme/sandbox regression matrix.
This project has no build step; server changes require a coordinated restart after
active agents finish. Do not restart the shared service as part of validation.

## Project settings and future online collaboration

The selected project has a Settings button; right-click a sidebar project (or
press Shift+F10/Context Menu) for Settings and Delete. Settings edit its name,
notes, existing local root, page domain/IP, repository path/address and planned
member list. Planned members are metadata only, not invitations or access grants.
The local-only owner/agent authentication model is unchanged.

Owner-authenticated `PATCH /api/projects/:id` accepts `baseRevision` (the current
`settingsRevision`, or zero for legacy records) and editable fields `name`,
`description`, `root`, `pageAddress`, `repositoryPath`, `plannedMembers`.
`POST /api/projects/:id/delete` accepts the same revision. Stale changes return
409. Deletion is a soft archive: the project disappears from active lists and
rejects new joins, but task/message/note/roadmap history and disk files remain.
There is currently no restore UI. Active working/waiting sessions block root
changes and deletion. Changing a root does not move files or install rules;
reinstall onboarding rules at the new location after the change. Archived records
keep their original project IDs, even when the directory is registered anew.

Planned deployment target: **https://chufa.wang/agents/**. This is a roadmap,
not an active deployment. Before public hosting, implement accounts, private
projects by default, project ownership, explicit invitations and membership
revocation, server-side authorization on all routes/events/roadmap renders,
scoped agent/device credentials and `/agents/` subpath support. The current public
local project-list API and local owner bootstrap are not an online privacy model.
A removed member must lose access on subsequent API/event requests; a hidden UI
alone is insufficient. Decide owner/admin/member/viewer roles, pending invitation
expiry, auditing, backups and rollback before the hosted pilot. Keep local mode.

Validation: `npm test` and `node tests/project-settings.browser.cjs` (installed
Edge by default, or `PLAYWRIGHT_CHANNEL`). Server changes need a coordinated
restart; static UI updates alone do not activate the new API.

## Three rule levels and coordinated completion

The project Rules page separates platform rules (read-only service protocol),
shared project instructions (persisted with the project) and local instructions
(the custom portion of the current root's `AGENTS.md`). Platform requirements
apply first, then project instructions, then local defaults. The generated agent
coordination block is preserved separately when local rules are saved. Existing
files are kept; writing local rules is not a policy installation.

Authenticated local owners can edit this project's project/local instructions.
They may explicitly grant a working agent project and/or local editing rights,
with a reason and 1–1440 minute expiry. Grants bind the current project and agent
session; revocation, expiry, or ending that session removes API edit authority.
Agents use their own session credentials. Local writes also require an active
`AGENTS.md` claim, and conflict with another agent's current file claims. These
are cooperative claims, not OS locks. The current local owner is the manager;
online project-owner/admin identities remain part of the online roadmap.

`GET /api/projects/:id/rules` returns all levels, their revisions, permissions,
grants and the caller's last read confirmation. `PATCH` accepts
`{scope:"project"|"local",baseRevision,text}`. Project revisions are numbers;
local/platform revisions are SHA-256 fingerprints. Text is limited to 64 KiB.
`POST .../rules/grants` accepts `{agentId,scopes,reason,expiresInMinutes}` or
`{grantId,revoke:true}`. `POST .../rules/confirm` accepts
`{revisions:{platform,project,local}}`. A changed revision returns 409 with a
machine-readable code. Saving never silently confirms reading. Project and local
changes retain a bounded history and emit audit events without copying rule text
into the event feed. Symlinked or malformed local rule files require repair
before editing; unmanaged text may be positioned after the preserved managed
block on save.

In a user-designated coordinated round, workers report results, release file
claims and keep read-only coordination listening until the coordinator's end
notification. That notification ends any no-message waiting timer early and
requires no additional human confirmation. The coordinator checks results,
notifies unassigned standby agents to exit, verifies session closure, posts the
combined report and exits last. Direct human cancellation still takes priority.
The authoritative details and editing boundaries are in `AGENT_PROTOCOL.md`.

Tests: `npm test` covers grants, expiry, revocation, cross-project/session access,
revision conflicts, read confirmation and local-file preservation. Filesystem
symlink cases require symlink permission on Windows; unsupported creation is
reported explicitly. Actual rule-file edits are tested only in temporary projects.
