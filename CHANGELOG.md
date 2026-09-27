# Changelog

## [0.1.5] - 2026-09-27
**Features:**
- optional mail body excerpt in the JEV state
- tooled blind reviewer to measure JEV against mail bodies

**Tests:**
- expect the 11 MCP tools

**Chores:**
- sync npm lockfile [skip ci]



## [0.1.4] - 2026-09-27
**Documentation:**
- prove cold Edge cycle and wire it into the scheduled task

**Chores:**
- sync npm lockfile [skip ci]



## [0.1.3] - 2026-09-27
**Features:**
- navigate with jev-ultrafast by default
- read mail bodies in readMode full

**Chores:**
- sync npm lockfile [skip ci]



## [0.1.2] - 2026-09-27
**Features:**
- translate dashboard, settings, labeling, CLI and MCP texts to English

**Documentation:**
- translate main documentation to English and realign with package

**Chores:**
- sync npm lockfile [skip ci]



## [0.1.1] - 2026-09-27
**Features:**
- add release workflow and configuration for automated npm publishing
- add JEV agreement and backfill services, enhance mailboard functionality
- track edits in JEV labeling process and update related reports
- add blind JEV labeling page and agreement report
- enable JEV enrichment on ingestion
- add JEV backfill for already-ingested messages
- backfill missing mail bodies
- add cycle orchestrator

**Documentation:**
- add install guide and scheduled task prompt

**Tests:**
- widen JEV adapter timeout to avoid cold-runner flake
- cover ingest resume path and add CI

**Chores:**
- initialize privacy-safe mailboard


