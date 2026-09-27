#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backfillJev } from '../src/core/services/jev-backfill.mjs';
const argv = process.argv.slice(2);
const option = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const result = await backfillJev({
  root: process.env.MAILBOARD_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  dry: argv.includes('--dry'), stale: argv.includes('--stale'), sourceId: option('--source'),
  limit: Math.min(Number(option('--limit') ?? 20) || 20, 200),
});
console.log(JSON.stringify(result));
if (!argv.includes('--dry') && result.status !== 'ok') process.exitCode = 1;
