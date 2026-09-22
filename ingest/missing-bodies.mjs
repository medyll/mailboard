#!/usr/bin/env node
// Liste les messages d'un canal dont le corps n'est pas stocké, du plus récent
// au plus ancien. Sert au rattrapage : l'agent récupère ces corps puis dépose
// un run `kind: "backfill"` (ingest/schema.md).
//
// Usage :
//   node ingest/missing-bodies.mjs --source gmail-primary --limit 20
//
// Sortie : une ligne JSON { type, sourceId, missing, total, items: [{ id, date, subject }] }.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { messageKey } from '../config/load.mjs';

const ROOT = process.env.MAILBOARD_ROOT
  ? path.resolve(process.env.MAILBOARD_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MESSAGES = path.join(ROOT, 'data', 'messages.jsonl');
const BODIES = path.join(ROOT, 'data', 'bodies.jsonl');

const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : null;
};

const sourceId = option('--source');
const limit = Number(option('--limit') ?? 20) || 20;
if (!sourceId) {
  console.error('--source <sourceId> est requis.');
  process.exit(1);
}

const readJsonl = (file) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        })
    : [];

// bodies.jsonl fait foi : hasBody peut manquer sur des lignes anciennes.
const withBody = new Set(readJsonl(BODIES).filter((b) => b.text).map((b) => b.key ?? messageKey(b.sourceId, b.id)));
const messages = readJsonl(MESSAGES).filter((m) => (m.sourceId ?? 'gmail-legacy') === sourceId);
const missing = messages
  .filter((m) => !withBody.has(m.key ?? messageKey(m.sourceId, m.id)))
  .sort((a, b) => (a.date < b.date ? 1 : -1));

console.log(
  JSON.stringify({
    type: 'mailboard.missing-bodies',
    sourceId,
    missing: missing.length,
    total: messages.length,
    items: missing.slice(0, limit).map(({ id, date, subject }) => ({ id, date, subject })),
  }),
);
