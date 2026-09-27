#!/usr/bin/env node
// Entrée historique conservée pour les tâches planifiées.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestRuns } from '../src/core/services/ingestion.mjs';

const argv = new Set(process.argv.slice(2));
const result = await ingestRuns({
  root: process.env.MAILBOARD_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  dry: argv.has('--dry'), rebuildOnly: argv.has('--rebuild'), jev: argv.has('--jev'),
});
if (argv.has('--json')) console.log(JSON.stringify(result));
