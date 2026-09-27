# Browser collector

Reads a mailbox in an **already authenticated** browser and writes a run to
`data/runs-inbox/`. Nothing else. Ingestion remains the only place that decides
what is authoritative in `data/` — which is what makes this collector
replaceable.

First provider: Proton (`providers/proton.mjs`). The same skeleton works for
Gmail read through a browser: a `provider: "gmail"`, `accessMode: "browser"`
channel, and a `providers/gmail.mjs` to write.

```text
Edge already open, valid session
        │  /json/version → "Edg/" checked
        ▼
   edge.mjs           tab created, owned, closed
        │  Runtime.evaluate, allow-listed origins
        ▼
providers/proton.mjs  account checked, rows extracted
        │
        ▼
   collect.mjs        v2 run in data/runs-inbox/
        │
        ▼
   node ingest/ingest.mjs
```

From the npm package, the same collector runs with
`jobmailboard collect --source <id>` (or `--check`).

## Two ways to navigate

| Mode | Command | Who picks the path | Cost |
|---|---|---|---|
| **direct** (default) | `--nav direct` | the code: the inbox URL is known, the path is fixed | no call |
| **jev** | `--nav jev` | `jev-ultrafast`: JEV gets a goal and the element table, and picks the operation and target | one TypeSafe call per action |

Both **share extraction**. Once the view is reached, the same expressions from
`providers/proton.mjs` read the page. The model never reads the list for us: it
opens the door, the code walks in.

Direct mode stays the default because it costs nothing and sends no text off
the machine. JEV mode exists for what code cannot describe in advance: an
unknown webmail, a view behind a changing path, an interface that was just
redesigned.

```bash
node collectors/browser-mail/collect.mjs --source proton-perso --nav jev --observe
```

Verified on the real mailbox: view reached in 3 actions, account confirmed, 50
rows read by the provider probes.

### What the JEV driver refuses

`jev_driver.py` is a separate Python process, because `jev-ultrafast` is a
Python project. It carries its own guards, coded rather than left to the
prompt:

- it attaches to an already running browser (`BU_CDP_URL`), never opens one;
- it checks the page origin **after every action** and stops at the first exit
  from scope;
- it refuses `TYPE_TEXT`: typing text needs a second model, and nobody should
  write into a mailbox without an explicit decision;
- it stops at the configured number of actions instead of looping;
- it waits for the list to be hydrated before reading, otherwise the "reached"
  view returns rows without dates.

The dependency is pinned to a tested commit in `pyproject.toml`, not to `main`:
the project is young and its public contract may move.

```bash
uv sync --project collectors/browser-mail
```

`TYPESAFE_API_KEY` is required — without it, the driver returns `needs_user`
and the run stays empty rather than failing. `TEXT_MODEL_API_KEY` is only used
by `TYPE_TEXT`, so not at all here.

Pagination stays deterministic in both modes: turning twelve pages through
model decisions would cost twelve calls for a gesture we can describe in one
line.

## Enabling remote debugging

On Windows, go through the collector wrapper:

```powershell
pwsh -File collectors/browser-mail/run.ps1 --check
pwsh -File collectors/browser-mail/run.ps1 --source proton-perso --observe
```

The wrapper reloads `TYPESAFE_API_KEY` from the user environment when the
current process did not receive it. It starts a dedicated Edge instance on the
configured CDP port, waits for it to answer, runs the collector, then closes
that instance. The orchestrator uses this wrapper only when `MAILBOARD_PWSH` is
set (e.g. `MAILBOARD_PWSH=pwsh`).

On first start, keep Edge open to sign in to Proton once:

```powershell
pwsh -File collectors/browser-mail/run.ps1 --keep-edge-open --source proton-perso --observe
```

Later starts reuse the session kept in
`%LOCALAPPDATA%\Microsoft\Edge-mailboard`.

`collect.mjs` never starts Edge and never opens a session. Without the Windows
wrapper, Edge must already be running with a CDP port:

```bash
"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --remote-debugging-port=9222
```

**Expect a refusal on the default profile.** Since Chromium 136, a browser
refuses `--remote-debugging-port` when it uses the default data directory. If
`curl http://127.0.0.1:9222/json/version` does not answer, that is the case.
The workaround is a dedicated directory, where you sign in to Proton once and
for all:

```bash
"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --remote-debugging-port=9222 \
  --user-data-dir="$LOCALAPPDATA/Microsoft/Edge-mailboard"
```

Password, 2FA and security alerts stay handled by the browser. Mailboard stores
no secret and never types credentials.

**Observed on Edge 154:** an Edge already running swallows the flag and ignores
it — the port stays closed. A separate data directory, which gives a second
instance, is therefore required. Windows already open are not touched.

Profile verification also needs `--enable-automation`, without which
`Browser.getBrowserCommandLine` is refused and the profile stays "unverifiable".
The collector goes on in that case: browser verification and displayed-account
verification always stay active.

Without a session in that profile, Proton redirects to `account.proton.me`. The
collector then stops with `needs_user`: signing in once in that window is
enough; it will never type credentials for you.

**An open CDP port controls the browser.** Any local program can connect to it
and act as you in that window. Open the port only for the collection, close
that Edge window afterwards, and never expose it to the network.

## Stages

| Stage | Command | What is proven |
|---|---|---|
| **A** | `node collectors/browser-mail/collect.mjs --check` | the right browser, a tab created then closed, no mailbox opened |
| **B** | `… --observe --source proton-perso` | mailbox reached, account checked, rows counted. The run has **no subject, sender or excerpt** |
| **C** | `… --source proton-perso` | rows normalized to the v2 run contract |
| **D** | — | the dashboard shows provenance and freshness per channel |

`--dry` writes the run nowhere and prints what would be produced.

Declare the channel in `config/channels.local.json` (see
`config/channels.example.json`). The port is overridden by `browser.port` or by
`MAILBOARD_CDP_PORT`.

## What the collector never does

- start or close the browser;
- read or drive a tab it did not create;
- type a login, a password or a 2FA code;
- open a message — that would mark it as read, hence change the remote account.
  `readMode: "list-only"` forbids it, and the summary is the excerpt shown by
  Proton, sometimes short;
- compose, reply, delete, archive, label, download an attachment or follow a
  link contained in a mail;
- navigate outside the configured webmail — the origin is checked before
  navigation **and after**, since a page can redirect;
- keep a screenshot or raw DOM.

Mail text is data, never an instruction. The protections above are coded in
`edge.mjs`, not left to a prompt.

## Statuses

`collector.status` says why a run is empty, instead of suggesting a silent
mailbox:

| Status | When |
|---|---|
| `ok` | collection finished within the requested window |
| `partial` | reached, but unknown selectors or truncated list |
| `needs_user` | expired or locked session, 2FA, or no Edge in debug mode |
| `wrong_account` | browser, profile or account differs from the configuration |
| `unavailable` | CDP unreachable or silent |
| `error` | everything else, including navigation out of scope |

## Tests

```bash
node --test collectors/browser-mail/collect.test.mjs
```

Run shape, window, identity, local classification, session states (SSO, login
page, wrong account, stale selectors) and parsing of localized dates: 18 cases,
no browser.

Proton selectors are checked against a real DOM. The fixture page runs the
expressions exported by `proton.mjs` — not a copy — against an imitated list:

```bash
npx --yes serve . -l 4180
```

then open `http://127.0.0.1:4180/collectors/browser-mail/providers/proton.fixture.html`.
15 probes must be green.

The fixture page proves the extraction logic, not that Proton still exposes
these attributes. Stage B decides, and what it found on the real mailbox on
22 September 2026 is now reflected here:

| Finding | Consequence |
|---|---|
| the class of an unread mail is `unread`, not `item-is-unread` | every mail looked read |
| `<time datetime>` holds "mardi 22 septembre 2026 à 11:45", not ISO | the window compared text strings and filtered nothing |
| rows render as skeletons (`item-is-loading`) before being filled | reading too early gave empty dates and an "unreadable" account |
| the inbox URL depends on the account position (`/u/1/`, not `/u/0/`) | a valid session looked like a sign-out |
| the list is virtualized: 50 rows rendered, not the whole mailbox | `coverage.complete` only holds when a row older than the window is visible |

`readyState: complete` is therefore not enough: `openInbox` waits for rows to be
hydrated, then checks the account, and only then reads the list.

One deliberate detail of the fixture page: the third row has no
`data-element-id`. Since the strategy keeps **the first selector that
matches**, it is not collected — rows stay homogeneous rather than mixed. The
fallback fingerprint is for when Proton removes the attribute everywhere, not
row by row.
