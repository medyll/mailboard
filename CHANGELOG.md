# Changelog

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


