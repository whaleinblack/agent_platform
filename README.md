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
