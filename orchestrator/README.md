# orchestrator

Runs the full cycle described in [AGENTS.md](../AGENTS.md): collect, check,
ingest once, decide on notification. The package exposes the same cycle as
`jobmailboard cycle` and as the `run_cycle` MCP tool.

```text
agent (scheduled task): Gmail collection via connector → data/runs-inbox/
node orchestrator/run-cycle.mjs
  ├─ browser channels, in series (shared Edge profile)
  │    → collect.mjs --source <id>   (or run.ps1 --source <id> with MAILBOARD_PWSH)
  ├─ channel with no run after its attempt → failure run written by the orchestrator
  ├─ connector channels: only checks that their run arrived
  ├─ node ingest/ingest.mjs --json (once)
  └─ last line: mailboard.cycle.result
```

## Usage

| Command | Effect |
|---|---|
| `node orchestrator/run-cycle.mjs` | full cycle |
| `node orchestrator/run-cycle.mjs --retry-failed` | reruns only the browser channels that failed in the previous cycle, then ingests |
| `node orchestrator/run-cycle.mjs --skip-collect` | ingests what waits in the inbox, without collecting |

Exit code: `0` when ingestion succeeded, even if a channel failed (the failure
is recorded in a run and in the result). `1` when ingestion failed; runs then
stay in the inbox for the next cycle.

## Result

```json
{
  "type": "mailboard.cycle.result",
  "ok": true,
  "notify": true,
  "added": 3,
  "message": "Mailboard: 3 new message(s) — failed channel(s): proton-perso (error)",
  "channels": { "proton-perso": "error", "gmail-primary": "delegated" },
  "ingest": { "type": "mailboard.ingest.result", "added": 3, "…": "…" }
}
```

Notify **only** when `notify` is `true`; `message` is the text ready to send.
Channel statuses: those of `collector.status`
([ingest/schema.md](../ingest/schema.md)), plus `delegated` (connector run
present) and `missing` (connector run absent).

## State

`data/cycle-state.json` is rewritten at each step: an interrupted cycle shows
where it stopped. `--retry-failed` reads it back to choose which channels to
rerun.

## Environment variables

- `MAILBOARD_CHANNEL_TIMEOUT_MS`: max duration per browser channel (10 min by
  default).
- `MAILBOARD_PWSH`: Windows only. When set (e.g. `pwsh`), browser channels go
  through `collectors/browser-mail/run.ps1`, which starts the dedicated Edge
  instance. Unset: the Node collector is called directly and expects a browser
  already listening on the CDP port.
- `MAILBOARD_ROOT`: data root.
- `MAILBOARD_CONFIG_DIR`: configuration folder.

## Tests

`node --test orchestrator/run-cycle.test.mjs` — simulated collector, real
ingester in a temporary directory.
