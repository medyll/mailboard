# Configuration

Everything that changes from one machine, account or job search to another
lives here. No code has to change to add a sorting criterion, a mailbox or a
provider.

| File | Versioned | Role |
|---|---|---|
| `criteria.json` | yes | **sorting criteria**: what we look for, what it is called, which color it gets |
| `preferences.json` | yes | **pros / cons**: what we want, what we refuse |
| `channels.example.json` | yes | channel registry template, without personal data |
| `channels.local.json` | **no** | channels actually enabled on this machine |
| `jev.json` | yes | JEV question set, thresholds, model |
| `load.mjs` | yes | single loader — the ingester and the collectors go through it |

In an npm workspace (`jobmailboard init`), the same files live in
`<workspace>/config/`, seeded with generic defaults.

The adapter that talks to TypeSafe is [`ingest/jev.mjs`](../ingest/jev.mjs): it
translates the `jev.json` vocabulary (primitive, text, options, levels) into
`POST /v1/systemone`. Switching provider should only touch that file.

## Adding or changing a sorting criterion

Edit `criteria.json`, then `node ingest/ingest.mjs --rebuild` (or
`jobmailboard rebuild`). The dashboard picks up label, color and filter with no
code or CSS change.

```json
{
  "id": "tech-watch",
  "label": "Tech watch",
  "enabled": true,
  "color": { "light": "#7048e8", "dark": "#b197fc" },
  "profileMatch": false,
  "queries": {
    "gmail": "newer_than:{windowHours}h (newsletter OR conference)",
    "keywords": ["newsletter", "conference"]
  }
}
```

- `{windowHours}` is substituted at run time: the window is set in one place.
- `queries.<provider>`: one query per provider, in **its** syntax. A provider
  with no entry is simply skipped for that criterion.
- `queries.keywords` serves collectors that have no search engine (extraction
  from a list).
- `profileMatch: true` enables the CV-fit questions for this criterion.
- `enabled: false` removes the criterion without losing its wording.

**Rename rather than break.** A deleted criterion leaves messages already
classified under the old name. An entry in `aliases` maps them to the current
criterion without rewriting `data/messages.jsonl`:

```json
"aliases": { "candidatures": "emploi", "recruteurs": "emploi" }
```

## Adding a pro or a con

`criteria.json` says **what we look for**. The CV says **what we can do**.
`preferences.json` says **what we want** — a different question: a language
can appear in the career history without us wanting to go back to it.

One entry is enough, then `node ingest/ingest.mjs --rebuild`:

```json
{
  "id": "rust",
  "kind": "pro",
  "strength": "mild",
  "label": "Rust",
  "match": { "keywords": ["rust", "tokio"] }
}
```

- `kind`: `pro` attracts, `con` repels.
- `strength`: `blocker` (4 points), `strong` (2), `mild` (1).
- `blocker` **flags**, it does not delete. The dashboard offers "hide
  blockers"; it is a box you tick, not a decision made for you. A badly worded
  preference must not make an offer silently disappear.
- Scoring is local and deterministic: no call, no cost. Keywords are compared
  in lower case against sender, subject and summary.

Preferences are re-evaluated **on every `--rebuild`**, over the whole history.
Editing the file is enough to reclassify a year of messages, without rewriting
a line of `data/`.

They also go with the business JEV call, as two lists of labels (`wants`,
`avoids`). Without them, `roleFit` would rate a Java offer at the top, since the
career history contains Java.

A script, a skill or an MCP server can write this file: it is flat JSON, with no
dependency, and the only constraint is to keep `id`s unique.

## Declaring a channel

Copy `channels.example.json` to `channels.local.json` and adapt it. Three
independent axes describe a source:

- `channelKind` — `mailbox`, `feed`, `messaging`, `file`
- `accessMode` — `connector`, `api`, `browser`, `drop`
- `provider` — `gmail`, `proton`, `outlook`, `rss`…

They are orthogonal: `gmail` + `connector` and `gmail` + `browser` are two valid
channels for the same provider. Each channel carries a stable `sourceId`, used
as the prefix of the deduplication key — two different mailboxes exposing the
same external id are never confused.

`linkTemplate` (optional) rebuilds a message link when the collector provides
none: `"https://mail.proton.me/u/0/inbox/{id}"`.

## Environment variables

No secret is stored in configuration files. A value of the form `"env:NAME"` is
replaced at load time by `process.env.NAME`.

| Variable | Default | Role |
|---|---|---|
| `TYPESAFE_API_KEY` | — | JEV key. Missing = `jev.status: skipped`, ingestion goes on |
| `MAILBOARD_JEV` | value from `jev.json` | `1` enables enrichment, `0` disables it |
| `MAILBOARD_JEV_MODEL` | `jev.json` | pin a model version |
| `MAILBOARD_JEV_TIMEOUT_MS` | `8000` | timeout of one call |
| `MAILBOARD_JEV_CONCURRENCY` | `4` | concurrent calls |
| `MAILBOARD_JEV_CONFIG` | `config/jev.json` | other question set |
| `MAILBOARD_JEV_ENDPOINT` | `jev.json` | other System One URL (local stub, gateway) |
| `MAILBOARD_ROOT` | user workspace | data root |
| `MAILBOARD_CONFIG_DIR` | `config/` | move the whole configuration folder |
| `MAILBOARD_CRITERIA` | `config/criteria.json` | other criteria file |
| `MAILBOARD_PREFERENCES` | `config/preferences.json` | other preference set |
| `MAILBOARD_CHANNELS` | `config/channels.local.json` | other channel registry |
| `MAILBOARD_PROFILE` | `profile/profile.jev.md` | other profile digest |
| `MAILBOARD_PROFILE_SOURCE` | first PDF in `profile/` | source CV to extract |
| `MAILBOARD_PROFILE_MAX_CHARS` | `4000` | size of the digest sent |
| `MAILBOARD_WINDOW_HOURS` | `criteria.json` | collection window of a run |
| `MAILBOARD_CDP_PORT` | `browser.port` of the channel | CDP port of the browser collector |
| `MAILBOARD_PWSH` | unset | Windows: route browser channels through `run.ps1` |
| `MAILBOARD_CHANNEL_TIMEOUT_MS` | `300000` | max duration per browser channel |

The prefix stays `MAILBOARD_`: it is the runtime name (`window.MAILBOARD` in
the dashboard). `jobmailboard` is the package name.

## Precedence

For JEV activation, the most explicit wins:

```text
--dry            disables everything, unconditionally, even with --jev
--jev            enables for this run
MAILBOARD_JEV    enables or disables for the environment
jev.json         repository default
```

A missing key brings the status back to `skipped:no-key`: never a run error.
