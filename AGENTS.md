# jobmailboard — job-mail watch

Local tracking of job-related mail spotted by the "Veille emploi" scheduled task.
The source repository needs no server: JSONL on disk plus a static dashboard.
The npm package (`@medyll/jobmailboard`) wraps the same logic in a CLI, an API
and an MCP server — see [README.md](README.md).

## Agent role during a run

1. Run one Gmail search **per enabled criterion** in
   [config/criteria.json](config/criteria.json), over the window defined there
   (12 h by default). Never rewrite the queries here: they live in that file,
   with `{windowHours}` substituted at run time.
2. For each kept mail, fetch the **body** (`get_message`) and put it in `body`.
   Without it, the mail is neither readable nor searchable in the dashboard.
3. Write **one single file** per channel in `data/runs-inbox/`, following
   [ingest/schema.md](ingest/schema.md). Write the file even when no mail is
   found (`"messages": []`) — an empty run documents coverage. Each message's
   `category` must be the `id` of a criterion in `config/criteria.json`.
3b. Backfill up to 20 missing bodies per pass: list them with
   `node ingest/missing-bodies.mjs --source gmail-primary --limit 20`, fetch
   each body, drop a `kind: "backfill"` run (see
   [ingest/schema.md](ingest/schema.md)).
4. Then run `node orchestrator/run-cycle.mjs`. It collects the browser
   channels, ingests once and writes a `mailboard.cycle.result` object as its
   last line.
5. Read that object. Notify **only** when `notify` is `true`, using the text in
   `message`. Duplicates trigger nothing: id-based deduplication is the source
   of truth, not the time window.

## Orchestration cycle

[orchestrator/run-cycle.mjs](orchestrator/run-cycle.mjs) owns this cycle; no
collector calls the ingester. Details in
[orchestrator/README.md](orchestrator/README.md).

1. **Prepare**: load enabled channels and set a common window.
2. **Collect**: run each channel separately. Browser channels run in series
   (they share one Edge profile) through the Node collector
   `collectors/browser-mail/collect.mjs --source <sourceId>`; on Windows,
   `MAILBOARD_PWSH=pwsh` routes them through
   `pwsh -File collectors/browser-mail/run.ps1 --source <sourceId>`, which starts
   and stops the dedicated Edge instance.
3. **Check**: wait for each attempt to finish. A failing channel still writes
   its v2 run with `messages: []` and an explicit `collector.status`; if it could
   not write anything (Edge missing, silent CDP port, timeout), the orchestrator
   writes that run in its place. The cycle goes on with the other channels.
4. **Ingest**: run a single `node ingest/ingest.mjs --json` after all attempts.
5. **Notify**: decide from the `mailboard.ingest.result` object, never from the
   number of collected results. The orchestrator reports the decision in
   `mailboard.cycle.result.notify`.

`node orchestrator/run-cycle.mjs --retry-failed` reruns only the browser
channels that failed in the previous cycle (`data/cycle-state.json`).

If the cycle stops before ingestion, runs stay in `data/runs-inbox/` and the
next cycle picks them up. If ingestion stops before archiving, it also keeps the
files in the inbox. A `runId` already present in `data/runs.jsonl` is only
archived on the next pass, without creating a second canonical run.

## Invariants

- Deduplication uses `sourceId` + external `id` (`key`), never subject or
  sender. A run without `source` is attached to `gmail-legacy`.
- `config/criteria.json` says what we look for, `config/preferences.json` what
  we want. A blocker preference flags a message, it never deletes it: the
  decision stays human.
- Sorting criteria, channels and JEV questions live in `config/`. Adding a
  criterion = edit `config/criteria.json` then `--rebuild`; no code to touch,
  neither in the ingester nor in the dashboard.
- The CV in `profile/` never leaves the machine: only the redacted
  `profile/profile.jev.md` is sent to a model.
- `data/messages.jsonl` is append-only in practice; it is rewritten in full only
  to update `lastSeenAt` / `seenCount` / `hasBody`, or the `jev` blocks via
  `node ingest/jev-backfill.mjs`. Never edit it by hand.
- `dashboard/data.js` and `dashboard/bodies.js` are **generated**. Any manual
  change is overwritten on the next run.
- Bodies are stored in `data/bodies.jsonl`, apart from the index:
  `messages.jsonl` stays light and readable even with a year of history. A body
  already stored is never overwritten by a later run.
- The "processed" state lives in the browser's localStorage, not in `data/`. It
  does not survive a browser change — accepted, it avoids writing from the page.
