#!/usr/bin/env node
// Prints the Gmail queries of the enabled criteria, with {windowHours} substituted,
// plus the run timestamps: the scheduled task needs no inline `node -e`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = process.env.MAILBOARD_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config/criteria.json'), 'utf8'));
  const windowHours = config.defaults?.windowHours ?? 12;
  const queries = {};
  for (const criterion of config.criteria ?? []) {
    const query = criterion.queries?.gmail;
    if (criterion.enabled !== false && query) queries[criterion.id] = query.replaceAll('{windowHours}', windowHours);
  }
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  console.log(JSON.stringify({
    windowHours,
    queries,
    runAt: `${local}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`,
    stamp: `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`,
  }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
