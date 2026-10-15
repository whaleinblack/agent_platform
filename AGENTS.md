# Agent coordinator development

- This service is local-only. Preserve loopback binding and the owner/agent API distinction.
- The user creates projects. Agents declare their own IDs, tasks and intended write paths.
- A waiting or expired session has no write claim. Never describe claims as operating-system file locks.
- Preserve persistent messages, notes and completed task history; exclude .data and credentials from Git.
- Heartbeat renews presence only. Progress updates renew activity. Completion and idle release claims.
- Tests use temporary state and synthetic projects, never other repositories or development boards.
- Use Node.js built-ins and browser modules. Keep protocol, transport, client and UI separate.
