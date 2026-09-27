# Profile

Reference used to judge whether an offer matches the job being sought:
languages, frameworks, seniority, kind of role. Without this file, the fit
questions (`stackMatch`, `roleFit`) are removed from the JEV call — the rest of
the watch works identically.

**This whole folder is ignored by Git except this README and `extract.mjs`.**
A CV holds a name, a phone number, an address and a career history: it has no
place in a repository.

## Setup

Drop the CV as a PDF here, then:

```bash
node profile/extract.mjs
```

Two files are produced:

| File | Content | Leaves the machine? |
|---|---|---|
| `profile.cache.md` | full text extracted from the PDF | **no**, never |
| `profile.jev.md` | redacted, truncated digest | yes, it is the only one sent to the model |

Extraction only reruns when the PDF changed (fingerprint in the cache header).
`--force` redoes the work, `--show` prints the exact digest that would be sent.

A hand-written profile in `profile.md` takes precedence over the PDF. It is the
simplest option when `pdftotext` is not installed, or when the extracted CV
comes out badly split.

## What is removed from the digest

Email addresses, phone numbers, URLs, postal code and city, postal addresses.
Skills, technologies, job titles and durations are kept: they are what answers
the questions.

To remove other literals — name, former employer under NDA — create
`redact.local.txt`, one term per line, case-insensitive:

```text
# one line per term to remove
FIRSTNAME LASTNAME
Former Employer
```

Check before enabling JEV:

```bash
node profile/extract.mjs --show
```

## Dependency

`pdftotext` (poppler), shipped with Git for Windows, Homebrew and most
distributions. The project adds no npm dependency for this conversion; without
`pdftotext`, write `profile.md` by hand.
