# QuotaCraft

**Save your quota for work that matters.** A local-first, deadline-aware quota orchestrator for Codex, with a Web dashboard, CLI and stdio MCP server.

[中文文档](README.md) · [Architecture](docs/ARCHITECTURE.md) · [Forecast model](docs/FORECAST.md) · [Security](SECURITY.md)

![Dashboard with explicitly labelled synthetic demo data](docs/assets/dashboard-desktop.png)

## Run

Node.js **22.13+** is required. For real subscription usage, install Codex CLI and sign in with ChatGPT using `codex login`.

```bash
npm ci
npm run build
npm start
```

Visit **http://127.0.0.1:4318**. For an isolated offline demonstration, run `npm run start:demo`. The dashboard is currently Chinese; documentation is available in both languages.

## Features

- Prioritize must-do work, then deadlines and conservative cost intervals.
- Allocate a separate finishing/verification reserve to every task.
- Enforce each provider-reported window; missing, expired or stale observations do not admit work.
- Opt-in serial `codex exec` queue with explicit model/effort selection and `workspace-write` sandboxing.
- Stop owned process trees at quota reserves or runtime limits, retain a bounded assistant summary, and require review before recording completion.
- Separate scheduled refills, public announcements, banked resets and observed account restoration.
- Optional official X API ingestion and separately labelled community forecasts.
- Conditional historical reset estimates that remain unavailable when evidence is insufficient.
- Persist tasks, checkpoints, quota metadata, notifications and audit records in SQLite.
- No OpenAI API key, auth-file reads, account rotation, reset purchases or hidden OS background jobs.

Manual quota entry supports planning only; execution requires fresh real Codex observations. To enable execution, set `QUOTACRAFT_ALLOW_EXEC=1`, populate each task's absolute workspace and prompt, then enable automatic queue progression or start tasks individually.

```powershell
$env:QUOTACRAFT_ALLOW_EXEC='1'
npm start
```

Run one Web service per data directory. `QUOTACRAFT_DATA_DIR` defaults to `~/.quotacraft`. Demo and real state use separate files. This app does not load `.env` automatically.

## MCP

```toml
[mcp_servers.quotacraft]
command = "node"
args = ["/absolute/path/quotacraft/dist/cli.js", "mcp"]
```

Tools: `quota_status`, `task_create`, `task_preflight`, `task_checkpoint`, `task_resume`, `task_complete`, `schedule_plan`.

Create → preflight before expensive work → honor ready/wait → checkpoint → resume and recheck → explicitly record acceptance. MCP admission is advisory and depends on the host; it cannot constrain other devices or interrupt an in-flight generation.

## Verification

```bash
npm run check
npm run test:e2e
```

E2E uses Edge locally and Chromium in CI. No model calls are needed by the automated test suite. Tests cover scheduler boundaries, quota interpretation, process lifecycle, a real stdio MCP handshake, HTTP origin/host controls, desktop/mobile workflows, reduced motion and keyboard focus.

## Honest scope

v0.1.1 is an MVP. Task costs are user estimates in quota percentage points, not tokens. Account-wide changes during execution are not exact task attribution. Forecasts are experimental, uncalibrated and never authorize mandatory work on speculative future capacity. Resumption uses a fresh session plus checkpoint, rather than claiming lossless conversation continuity. Notifications require the browser page to remain open. Official X API access is optional and may incur provider fees.

MIT. Independently developed; not affiliated with OpenAI.
