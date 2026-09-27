# Run output contract

Each collector writes **one JSON file per run** in `data/runs-inbox/`.
Ingestion (`node ingest/ingest.mjs`, `jobmailboard ingest` or the `ingest_runs`
MCP tool) consumes it, then moves it to `data/runs-archive/`.

```text
run-<YYYYMMDD-HHmm>.json                      single source (legacy)
run-<YYYYMMDD-HHmm>--<sourceId>.json          multi-channel
```

The file name is the `runId`. Two collectors running over the same window
therefore write two files, each with its own coverage.

## Version 2 — multi-channel

```json
{
  "schemaVersion": 2,
  "runAt": "2026-09-22T19:00:00.000Z",
  "windowHours": 12,
  "source": {
    "sourceId": "proton-perso",
    "channelKind": "mailbox",
    "accessMode": "browser",
    "provider": "proton"
  },
  "collector": {
    "name": "edge-mail-jev",
    "version": "0.1.0",
    "status": "ok"
  },
  "coverage": {
    "folder": "inbox",
    "from": "2026-09-22T07:00:00.000Z",
    "to": "2026-09-22T19:00:00.000Z",
    "complete": true,
    "itemsInspected": 24
  },
  "queries": {
    "emploi": "candidature OR poste OR entretien",
    "france-travail": "France Travail OR Pôle emploi"
  },
  "messages": [
    {
      "id": "provider-message-id",
      "identityQuality": "provider-id",
      "category": "emploi",
      "date": "2026-09-22T16:42:00.000Z",
      "from": "ACME Recruiting <user-07@example.test>",
      "subject": "Your application - Front-end developer",
      "summary": "Video interview invitation on 25/09 at 2 pm.",
      "body": "Hello,\n\nFollowing your application…",
      "link": "https://mail.proton.me/u/0/inbox/…"
    }
  ]
}
```

## Rules

- **Deduplication key: `sourceId` + `id`.** An external id is only unique
  within its channel; two different mailboxes may expose the same one.
  Ingestion computes `key = "<sourceId>:<id>"`.
- Missing `source` → the run is treated as `gmail-legacy`, which preserves the
  identity of messages ingested before multi-channel support.
- `category` must be the `id` of a criterion in `config/criteria.json`. An
  unknown category goes through `aliases`, then falls back to `autre` — it is
  never lost.
- `identityQuality` ∈ `provider-id` | `conversation-id` | `fingerprint`. A DOM
  element number or a position in a list is never an `id`.
- `collector.status` ∈ `ok` | `partial` | `needs_user` | `wrong_account` |
  `unavailable` | `error`. A failed run keeps `messages: []` and still
  documents its coverage.
- `summary`: 1 to 2 factual sentences, no interpretation.
- `body`: plain text preferred, HTML accepted (converted at ingestion). Stored
  in `data/bodies.jsonl`, **not** in `messages.jsonl`, truncated to 12,000
  characters. Without it, only subject, sender and summary are searchable.
- A `body` may arrive in a later run; a body already stored is never
  overwritten.
- `messages: []` is valid — an empty run proves the watch ran, and the
  dashboard shows coverage gaps.
- Optional: `threadId`, `link`, `summary`, `body`, `queries`, `coverage`,
  `collector`, `jev`.

## Body backfill run

A v2 run with `"kind": "backfill"` only brings bodies for messages **already
known** on the same channel. It creates no message, touches neither `seenCount`
nor `lastSeenAt`, does not enter `runs.jsonl` (it is not an observation of the
mailbox) and is archived like the others. An unknown `id` is skipped with a
warning.

```json
{
  "schemaVersion": 2,
  "kind": "backfill",
  "runAt": "2026-09-22T19:00:00.000Z",
  "source": { "sourceId": "gmail-primary", "channelKind": "mailbox", "accessMode": "connector", "provider": "gmail" },
  "collector": { "name": "scheduled-task", "status": "ok" },
  "messages": [{ "id": "provider-message-id", "body": "Hello,\n\n…" }]
}
```

Suggested name: `backfill-<YYYYMMDD-HHmm>--<sourceId>.json`. Messages to
backfill are listed with
`node ingest/missing-bodies.mjs --source <sourceId> --limit 20` (or
`jobmailboard missing-bodies`), newest first.

## Version 1 — still accepted

A run with neither `schemaVersion` nor `source` stays valid: it is the original
Gmail format, attached to the `gmail-legacy` channel.

```json
{
  "runAt": "2026-09-22T07:00:00+02:00",
  "windowHours": 12,
  "queries": { "emploi": "newer_than:12h (candidature OR poste)" },
  "messages": [{ "id": "18f2c9a1b3d4e5f6", "category": "emploi", "…": "…" }]
}
```

## Fields added by ingestion

| Field | Meaning |
|---|---|
| `key` | `<sourceId>:<id>` — canonical identity, deduplication key |
| `sourceId` | originating channel (`gmail-legacy` by default) |
| `provider` | provider declared by the run |
| `firstSeenAt` | timestamp of the run that discovered the message |
| `lastSeenAt` | timestamp of the last run where it reappeared |
| `seenCount` | number of runs that returned it |
| `runId` | discovery run |
| `hasBody` | a body is stored for this message |

## `jev` block (optional)

A message may carry a `jev` object produced by the enrichment described in
[JEV_INTEGRATION.md](../JEV_INTEGRATION.md): `status`, `questionSet`, `model`,
`evaluatedAt`, `inputFingerprint`, `answers`. It is copied as-is and affects
neither deduplication nor retention of a message.
