#!/usr/bin/env node
// Relecture outillée des décisions JEV (JEV_INTEGRATION.md, « Relecture outillée »).
//
//   node ingest/jev-review.mjs [--limit 10] [--order recent|uncertain] [--reviewer claude]
//       prochain lot à l'aveugle : mails, corps et questions, sans réponse JEV
//   node ingest/jev-review.mjs --save <fichier.json | -> [--reviewer claude]
//       enregistre { model?, labels: [{ key, answers }] } ; « - » lit l'entrée standard
//
// Sortie : une ligne JSON.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewQueue, saveReview } from '../src/core/services/jev-review.mjs';

const root = process.env.MAILBOARD_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const reviewer = option('--reviewer') ?? 'claude';

try {
  const file = option('--save');
  if (file) {
    const raw = JSON.parse(fs.readFileSync(file === '-' ? 0 : file, 'utf8'));
    const labels = Array.isArray(raw) ? raw : raw.labels;
    console.log(JSON.stringify(saveReview({ root, reviewer, model: raw.model, labels })));
  } else {
    console.log(
      JSON.stringify(
        reviewQueue({
          root,
          configRoot: root,
          reviewer,
          limit: Number(option('--limit') ?? 10),
          order: option('--order') ?? 'recent',
        }),
      ),
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
