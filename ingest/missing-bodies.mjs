#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingBodies } from '../src/core/services/missing-bodies.mjs';
const argv = process.argv.slice(2);
const option = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
try {
  console.log(JSON.stringify(missingBodies({
    root: process.env.MAILBOARD_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    sourceId: option('--source'), limit: Number(option('--limit') ?? 20),
  })));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
