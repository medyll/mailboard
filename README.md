# @medyll/jobmailboard

Local tracking of job-related mail: JSONL storage, a static dashboard, a CLI and
an MCP server. Published on npm as
[`@medyll/jobmailboard`](https://www.npmjs.com/package/@medyll/jobmailboard).

## Quick start

```sh
npx @medyll/jobmailboard
npx @medyll/jobmailboard --help
npx @medyll/jobmailboard --version
```

Without a command the CLI prints its help. Node 22.22.2 or later is required;
CI tests the Node 22 and 24 LTS lines on Windows, Linux and macOS.

## CLI

```sh
npx @medyll/jobmailboard init
npx @medyll/jobmailboard queries --provider gmail --window 12
npx @medyll/jobmailboard ingest --json
npx @medyll/jobmailboard cycle --skip-collect --json
npx @medyll/jobmailboard cycle --retry-failed --json
npx @medyll/jobmailboard collect --check
npx @medyll/jobmailboard collect --source proton-perso --observe
npx @medyll/jobmailboard missing-bodies --source gmail-primary --limit 20
npx @medyll/jobmailboard messages --query interview
npx @medyll/jobmailboard message --source gmail-primary --id EXTERNAL_ID
npx @medyll/jobmailboard rebuild
npx @medyll/jobmailboard jev-backfill --limit 20 --dry
npx @medyll/jobmailboard jev-agreement
npx @medyll/jobmailboard serve --port 4177
```

| Command | Options | Effect |
| --- | --- | --- |
| `init` | | Create the user workspace (keeps existing files) and build the dashboard |
| `ingest` | `--dry`, `--jev` | Ingest runs waiting in `data/runs-inbox/` |
| `rebuild` | | Regenerate the dashboard from storage and current criteria |
| `cycle` | `--skip-collect`, `--retry-failed` | Collect browser channels, ingest once, decide on notification |
| `collect` | `--check` or `--source ID`, `--observe`, `--dry`, `--nav direct\|jev`, `--window H`, `--max N` | Run the browser collector for one channel |
| `missing-bodies` | `--source ID` (required), `--limit N` | List messages whose body still has to be fetched |
| `messages` | `--source`, `--category`, `--query`, `--limit` | Search local messages, bodies included |
| `message` | `--source ID --id ID` (required) | Read one message and its body |
| `queries` | `--provider gmail`, `--window H` | Queries of enabled criteria, window substituted |
| `jev-backfill` | `--source`, `--limit`, `--dry`, `--stale` | Re-evaluate already-ingested messages with JEV |
| `jev-agreement` | | Compare JEV answers with human labels |
| `serve` | `--port 4177` | Serve dashboard and settings editor on `127.0.0.1` |
| `mcp` | | MCP server over stdio |

Global options: `--root <dir>`, `--json`, `--help` (`-h`), `--version` (`-v`).
`--limit` is capped at 200 and `--window` at 720 hours.

`serve` exposes the dashboard and settings on `127.0.0.1`. The dashboard can
also be opened directly from `dashboard/index.html` in the workspace.
`--root <dir>` selects the workspace; `MAILBOARD_ROOT` does the same.
CLI results go to stdout, business logs to stderr; `--json` prints the result as
a single JSON line.

Default workspace locations:

| System | Persistent workspace |
| --- | --- |
| Windows | `%LOCALAPPDATA%/jobmailboard` |
| Linux | `$XDG_DATA_HOME/jobmailboard` or `~/.local/share/jobmailboard` |
| macOS | `~/Library/Application Support/jobmailboard` |

The workspace holds `config/`, `data/`, `dashboard/` and `profile/`. The package
refuses to use its own npm install directory as a workspace. Initialization
keeps existing files; the starter criteria are generic, with no account or
personal preference. JEV and profile upload are disabled by default.

To take over the history of this repository, copy its `config/`, `data/` and
`profile/` folders into a workspace outside the package, then run
`rebuild --root <that workspace>`. Generated dashboard files are rebuilt from
the JSONL files. The run contract is described in
[ingest/schema.md](ingest/schema.md). The CLI does not fetch Gmail by itself:
the agent or a connector drops runs, bodies included, before the cycle.

Browser collection uses the Node collector and a CDP-capable browser already
running on the configured port. On Windows, `MAILBOARD_PWSH=pwsh` switches to
the PowerShell wrapper that starts a dedicated Edge instance; PowerShell is
otherwise optional. JEV navigation in the collector is an opt-in that needs
`uv`, Python and a TypeSafe key; see the
[collector documentation](collectors/browser-mail/README.md).

## MCP

```sh
npx @medyll/jobmailboard mcp
```

Transport is `stdio`: stdout carries only the MCP protocol, logs go to stderr.
Client configuration example:

```json
{
  "mcpServers": {
    "jobmailboard": {
      "command": "npx",
      "args": ["-y", "@medyll/jobmailboard", "mcp"],
      "env": { "MAILBOARD_ROOT": "/path/to/workspace" }
    }
  }
}
```

Adapt the path to your system. On Windows, some clients that call `spawn`
without a shell cannot start a `.cmd` directly. Use their shell option, or
`command: "cmd"` with `args: ["/d", "/s", "/c", "npx -y @medyll/jobmailboard mcp"]`.
A local install also lets you run `node` with the path to `bin/jobmailboard.js`.
Renaming the command to `npx.cmd` is not enough for every client.

| Tool | Read-only | Arguments |
| --- | --- | --- |
| `list_messages` | yes | `sourceId?`, `category?`, `query?`, `limit?` (1–200) |
| `get_message` | yes | `sourceId`, `id` |
| `missing_bodies` | yes | `sourceId`, `limit?` |
| `collection_queries` | yes | `provider?`, `windowHours?` (1–720) |
| `ingest_runs` | no | `dry?`, `jev?` |
| `rebuild_dashboard` | no | — |
| `run_cycle` | no | `skipCollect?`, `retryFailed?` |
| `jev_backfill` | no | `sourceId?`, `limit?`, `dry?`, `stale?` |

The `jobmailboard://settings` resource returns raw settings (criteria,
preferences, JEV questions) without resolving `env:...` values. Calling
`jev_backfill` is an opt-in to potentially billable network calls;
`dry: true` avoids them.

The server uses the official
[MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)
(`@modelcontextprotocol/server` 2.x) with Zod input validation. MCP handlers and
CLI commands call `Mailboard` directly; neither goes through the other.

## JavaScript / TypeScript API

```ts
import { Mailboard } from '@medyll/jobmailboard';

const board = new Mailboard({ root: '/path/to/workspace' });
await board.ingest();
const messages = board.listMessages({ query: 'interview', limit: 20 });
```

Public exports are limited to `Mailboard`, `userWorkspace` and the option/message
types. JavaScript and declarations ship in the package; TypeScript is not needed
on the consumer side. Mutations on a single instance are queued. Do not run two
writing processes on the same workspace at the same time.

## Development and validation

```sh
npm ci
npm run typecheck
npm run build
npm test
npm pack
npm run smoke
node bin/jobmailboard.js --help
```

`npm run smoke` inspects the package contents, installs it in a temporary
directory with `--omit=dev`, then checks the bin, `npm exec` (the path used by
npx), the API and MCP over stdio. CI repeats these steps on every OS/Node
combination. The real-browser labeling test is kept; it is skipped when Edge is
missing. Other tests need no mailbox, no JEV network and no browser.

Inside this repository, `npx @medyll/jobmailboard` resolves the local package
(same name) instead of the registry one; use `node bin/jobmailboard.js`, or run
npx from another directory.

The license is provisionally `UNLICENSED`.

## Publishing with GitHub Actions

The `Release` workflow runs on every push to `main`, or manually from `main`.
It reuses the full CI (Windows/Linux/macOS × Node 22/24: typecheck, build,
tests, pack and smoke test); a failing validation blocks publication. Other
branches and pull requests run CI without publishing.

The release job uses `@medyll/idae-pnpm-release@1.0.47`, like the idae and
acp-team projects: version bump, changelog, commit and tag, then npm publish.
The publish build runs through `prepack` after the version bump. pnpm is
installed only for the release helper; the repository keeps npm and
`package-lock.json` for its own installs and checks. The lockfile is then
synced and committed if needed. Commits that only touch the version, changelog
or lockfile do not trigger a new release.

Configure an Actions secret `NPM_TOKEN` allowed to publish the `@medyll` scope,
or `NPM_TOKEN_2026` as a fallback. `GITHUB_TOKEN` is provided by GitHub. `main`
must allow the bot to push release commits and tags; if a protection rule
forbids it, the helper fails before publishing. No token is stored in the
repository.

## Source repository layout

The scripts below remain usable from the source repository.

```
jobmailboard/
├── AGENTS.md                 contract of the scheduled task
├── bin/, src/                npm package: CLI, API, MCP server
├── install/                  installation and scheduled-task prompt
├── orchestrator/             full cycle: collect, ingest, notify
├── config/                   sorting criteria, preferences, channels, JEV — see config/README.md
├── collectors/browser-mail/  browser collection (Proton, Edge) — see its README
├── profile/                  CV and anonymized digest (ignored by Git)
├── JEV_INTEGRATION.md        optional JEV enrichment (design, French)
├── COLLECTE_MULTICANAL.md    multi-source Gmail/Proton collection (design, French)
├── ingest/
│   ├── ingest.mjs            deduplication + dashboard generation
│   └── schema.md             run file contract
├── data/
│   ├── runs-inbox/           drop runs here (consumed, then emptied)
│   ├── runs-archive/         already-ingested runs
│   ├── messages.jsonl        index: one mail per line, without body
│   ├── bodies.jsonl          mail bodies, one per line
│   └── runs.jsonl            one run per line
├── settings/                 local editor for configuration files
└── dashboard/
    ├── index.html            open with a double-click
    ├── app.js
    ├── style.css
    ├── data.js               generated — index
    └── bodies.js             generated — bodies, loaded on demand
```

Design notes (`ARCHITECTURE.md`, `COLLECTE_MULTICANAL.md`, `JEV_INTEGRATION.md`,
`AUDIT.md`, `IMPLEMENTATION.md`) are dated records written in French; the
documents linked from this README are the current reference.

## Storage

No database: three JSONL files on disk act as storage. Append-only, readable,
greppable, versionable.

The index (`messages.jsonl`) and the bodies (`bodies.jsonl`) are kept apart on
purpose: the dashboard loads the index at startup and only pulls `bodies.js` on
the first expanded mail or the first search. A year of history still opens
instantly.

Bodies arrive through an injected `<script>` tag, not `fetch` — that is what
lets `index.html` open from `file://` without a server, since `fetch` is
blocked on that protocol.

## Installation (scheduled task)

See [install/README.md](install/README.md): channels, Edge profile, scheduled
task.

## Usage from the source repository

The scheduled task drops the Gmail run, then starts the cycle:

```bash
node orchestrator/run-cycle.mjs
```

The last line holds `mailboard.cycle.result`; its `notify` field decides
whether to notify. See [orchestrator/README.md](orchestrator/README.md).

To ingest by hand whatever waits in `data/runs-inbox/`:

```bash
node ingest/ingest.mjs --json
```

Then open `dashboard/index.html`. To regenerate only the dashboard:

```bash
node ingest/ingest.mjs --rebuild
```

### Editing settings from the UI

The dashboard opened by double-click is read-only. To edit criteria,
preferences and JEV objects, start the temporary local process:

```bash
node settings/server.mjs
```

(`jobmailboard serve` does the same for a workspace.) Open the printed address
(`http://127.0.0.1:4177/` by default) and click **Settings**. The editor:

- validates the three objects before any write;
- exposes no API key, no CV and no `channels.local.json`;
- writes `criteria.json`, `preferences.json` and `jev.json`, then rebuilds;
- restores the previous versions if the rebuild fails.

The service listens on `127.0.0.1` only, protects its API with a token created
at startup, and stops with `Ctrl+C`.

To see what would be ingested without writing anything:

```bash
node ingest/ingest.mjs --dry
```

To evaluate new messages with JEV (shadow mode — decisions are stored, nothing
displays them yet):

```bash
node ingest/ingest.mjs --jev
```

`TYPESAFE_API_KEY` must be set. Without a key, ingestion runs identically and
each message gets `jev.status: "skipped"`. `--dry` disables calls even with
`--jev`: a simulation costs nothing.

To evaluate already-ingested history in batches (newest first):

```bash
node ingest/jev-backfill.mjs --dry --source gmail-primary --limit 20
node ingest/jev-backfill.mjs --source gmail-primary --limit 20
```

Running the command counts as opt-in, even when `config/jev.json` has
`enabled: false`. It picks messages with no `jev` block, or in `skipped` /
`error`; `--stale` adds decisions whose question set or input changed.
`--limit` is capped at 200. An error never replaces an `ok` decision, and the
dashboard is regenerated at the end.

To compare JEV with your own judgement (required before setting thresholds in
`config/jev.json`):

```bash
node settings/server.mjs
```

then open http://127.0.0.1:4177/labeling-component/labeling-component.html
(the "Label JEV" link in the dashboard). Each mail is shown without JEV's
answer; prefilled values are neutral ("no", `information`, 0), so a routine
alert is confirmed with Enter. `S` skips, `?` records "don't know". JEV's
answer only appears after saving. Cases JEV considers rare come first. Labels
go to `data/jev-labels.json`.

After ~60 labels:

```bash
node ingest/jev-agreement.mjs
```

The report gives agreement per question, confusions, confident errors, and for
each yes/no question the highest threshold that misses no human "yes". It
writes nothing: copying a threshold stays your decision.

Tests:

```bash
npm test
```

## What the dashboard shows

- **KPIs**: 7-day volume, split by category, items left to process.
- **Run coverage**: one bar per run. Grey = the run found nothing new. A gap in
  the series means the watch did not run.
- **Messages**: filterable by source, category and full-text search — subject,
  sender, summary **and mail body**. Hits inside the body appear as a
  highlighted excerpt.
- **Detail**: clicking the subject expands the full mail body in the page.

## Known limitations

- A mail without `body` in its run stays listed and searchable on
  subject/sender/summary, but shows "body not captured". A later run can fill
  the gap.
- Bodies are truncated to 12,000 characters at ingestion (`BODY_MAX`).
- The "processed" state lives in the browser (localStorage). Changing browsers
  or clearing site data resets it.
- Opened directly (`file://`), the dashboard cannot write. Editing needs the
  local `settings/server.mjs` (or `jobmailboard serve`), started on purpose and
  stopped after use.
