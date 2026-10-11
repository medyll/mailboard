# Proton Mail Bridge

The Proton mailbox is collected locally over IMAP with mandatory STARTTLS.
SMTP settings are retained for future sending; collection does not send mail.

In the user's `config/channels.local.json`, keep the existing `sourceId` and
set `accessMode` to `imap`. Add `bridge: { "envFile": ".env.proton-bridge",
"allowSelfSigned": true }`. The certificate exception applies only to the
loopback Bridge connection. The collector refuses remote hosts.

Create `.env.proton-bridge` in the user workspace (excluded from Git):

```dotenv
PROTON_BRIDGE_IMAP_HOST=127.0.0.1
PROTON_BRIDGE_IMAP_PORT=1143
PROTON_BRIDGE_USERNAME=your-address@proton.me
PROTON_BRIDGE_PASSWORD=your-bridge-password
```

Bridge must be running and signed in. Test authentication with
`node collectors/proton-bridge/collect.mjs --source proton-perso --check`.
The CLI/API/MCP `collect` entry point and orchestrator route IMAP channels here.
`--dry` and `--observe` do not write runs; `--check` only authenticates.

The collector scans the configured folders (read-only), applies the precise
hour window to IMAP internal dates, and uses the existing local criterion
classifier on sender, subject and decoded body. Proton search queries are
recorded for traceability; this collector uses local classification rather
than translating Proton's web search syntax into IMAP syntax.
Each collection writes one v2 run, including empty and failed attempts.
Limits are reported as partial coverage. Only the orchestrator ingests runs.

Stable RFC Message-ID is preferred; the fallback is folder + UIDVALIDITY + UID.
Existing browser IDs are preserved in history. Browser and IMAP identities
cannot be equated safely without a provider identity mapping, so overlap at
the switch may produce a new entry. No subject/sender deduplication is used.
