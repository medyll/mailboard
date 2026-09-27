# Installation

Mailboard runs on a Windows machine with the Claude desktop app open: the
scheduled task collects Gmail through the connector, then starts the
orchestrator, which collects Proton in Edge and ingests everything.

To use only the CLI, API or MCP server, no clone is needed: see
[the package README](../README.md) (`npx @medyll/jobmailboard`).

## 1. Prerequisites

- Node.js 22.22.2 or later, with npm.
- Microsoft Edge for the Proton channel; PowerShell 7 (`pwsh`) to let the
  wrapper start Edge automatically.
- The Claude desktop app, with the Gmail connector enabled.

```bash
git clone https://github.com/medyll/mailboard.git
cd mailboard
npm ci
npm run build
npm test
```

## 2. Channels

Copy `config/channels.example.json` to `config/channels.local.json` (ignored by
Git), then keep only the channels you use enabled. For the standard watch:

- `gmail-primary`: `accessMode: "connector"`, collected by the scheduled task;
- `proton-perso`: `accessMode: "browser"`, collected by the orchestrator.

Put the real address in `accountHint`. No password or token in that file.

## 3. Edge profile (Proton channel)

First manual start, to open the dedicated profile and sign in to Proton:

```bash
pwsh -File collectors/browser-mail/run.ps1 --check --keep-edge-open
```

Sign in to Proton in the Edge window that opens, then close it. Details in
[collectors/browser-mail/README.md](../collectors/browser-mail/README.md).

For the orchestrator to go through this wrapper (and start/stop Edge itself),
set `MAILBOARD_PWSH=pwsh` in the user environment. Without it, the orchestrator
uses the Node collector, which expects Edge to be already running with its CDP
port open.

## 4. Scheduled task

In the Claude desktop app, create a local scheduled task whose working folder
is this repository:

- name: "Veille emploi — mailboard";
- schedule: `0 6,15 * * *` (local time);
- prompt: the content of [veille-emploi.prompt.md](veille-emploi.prompt.md),
  replacing `{{MAILBOARD_DIR}}` with the absolute path of the repository.

Run a first pass by hand ("Run now") and accept the requested permissions
(Gmail connector, `node`, `pwsh`). Then check that `data/cycle-state.json`
shows `ingest.status: "ok"`.

The task only runs while the app is open; a missed pass is caught up at the
next start, and runs left in `data/runs-inbox/` are picked up by the following
cycle.

## 5. Dashboard

Open `dashboard/index.html` with a double-click.

## Updating the prompt

The reference prompt is `install/veille-emploi.prompt.md`. After changing it,
copy the new version into the scheduled task.
