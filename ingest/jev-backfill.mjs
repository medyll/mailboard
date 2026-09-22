#!/usr/bin/env node
// Rattrapage JEV : évalue des messages déjà ingérés, par petits lots.
//
// L'ingestion n'enrichit que les nouveaux messages ; tout l'historique écrit
// avant l'activation de JEV reste donc `skipped` ou sans bloc `jev`. Cette
// commande est la « réévaluation séparée » prévue par JEV_INTEGRATION.md.
//
// Lancer la commande vaut opt-in : elle appelle JEV même si config/jev.json
// porte `enabled: false`. La clé reste obligatoire, et --dry n'appelle jamais.
//
// Usage :
//   node ingest/jev-backfill.mjs --limit 20            les 20 plus récents sans décision
//   node ingest/jev-backfill.mjs --source gmail-primary
//   node ingest/jev-backfill.mjs --stale               inclut les décisions périmées
//   node ingest/jev-backfill.mjs --dry                 liste les candidats, aucun appel
//
// Sélection par défaut : pas de bloc `jev`, ou statut `skipped` / `error`.
// --stale ajoute les décisions `ok` dont le questionSet ou l'empreinte d'entrée
// ne correspond plus. Dernière ligne : un objet `mailboard.jev-backfill.result`.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCriteria, loadJev, loadPreferences, messageKey } from '../config/load.mjs';
import { reevaluate, buildState, fingerprint } from './jev.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.MAILBOARD_ROOT ? path.resolve(process.env.MAILBOARD_ROOT) : path.resolve(HERE, '..');
const MESSAGES = path.join(ROOT, 'data', 'messages.jsonl');
const JEV_LOG = path.join(ROOT, 'data', 'jev-runs.jsonl');

const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : null;
};
const DRY = argv.includes('--dry');
const STALE = argv.includes('--stale');
const sourceId = option('--source');
// Borne dure : chaque appel est facturé, un oubli de --limit ne doit pas vider le quota.
const limit = Math.min(Number(option('--limit') ?? 20) || 20, 200);

const readJsonl = (file) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];

const keyOf = (m) => m.key ?? messageKey(m.sourceId, m.id);

const jev = loadJev({ cliFlag: true, dry: DRY });
const criteria = loadCriteria();
const preferences = loadPreferences();

function needsEvaluation(m) {
  const j = m.jev;
  if (!j) return true;
  // Aucune question ne s'applique à cette catégorie : la réévaluer coûterait zéro
  // mais la resélectionnerait à chaque passage.
  if (j.status === 'skipped') return j.reason !== 'no-question-for-category';
  if (j.status === 'error') return true;
  if (!STALE) return false;
  return j.questionSet !== jev.questionSet || j.inputFingerprint !== fingerprint(buildState(m));
}

const messages = readJsonl(MESSAGES);
const eligible = messages
  .filter((m) => !sourceId || (m.sourceId ?? 'gmail-legacy') === sourceId)
  .filter(needsEvaluation)
  .sort((a, b) => (a.date < b.date ? 1 : -1));

// On évalue des copies : le fichier n'est réécrit qu'après tous les appels.
const batch = eligible.slice(0, limit).map((m) => ({ ...m, category: criteria.resolveCategory(m.category) }));

const result = {
  type: 'mailboard.jev-backfill.result',
  status: jev.status,
  model: jev.model,
  questionSet: jev.questionSet,
  eligible: eligible.length,
  selected: batch.length,
  called: 0,
  ok: 0,
  errors: 0,
  byCode: {},
  tokens: 0,
  remaining: eligible.length,
};

if (DRY || !jev.enabled) {
  for (const m of batch) console.log(`  ? ${m.date} ${keyOf(m)} — ${m.subject}`);
  if (!jev.enabled && !DRY) console.log(`JEV non appelé : ${jev.status}`);
  console.log(JSON.stringify(result));
  process.exit(jev.enabled || DRY ? 0 : 1);
}

const metrics = [];
const stats = await reevaluate(batch, jev, {
  criteria,
  preferences: preferences.entries.length ? preferences.digest() : null,
  onMetric: (m) => metrics.push({ ...m, backfill: true, at: new Date().toISOString() }),
});

// Relecture juste avant l'écriture : une ingestion a pu passer pendant les
// appels. On ne fusionne que les blocs `jev`, par clé, sur l'état le plus frais.
const decisions = new Map(batch.map((m) => [keyOf(m), m.jev]));
const fresh = readJsonl(MESSAGES);
let written = 0;
for (const m of fresh) {
  const next = decisions.get(keyOf(m));
  if (!next) continue;
  // Une panne ne remplace jamais une décision valide déjà acquise (cas --stale).
  if (next.status !== 'ok' && m.jev?.status === 'ok') continue;
  m.jev = next;
  written++;
}
fs.writeFileSync(MESSAGES, fresh.map((r) => JSON.stringify(r)).join('\n') + (fresh.length ? '\n' : ''));
if (metrics.length) fs.appendFileSync(JEV_LOG, metrics.map((r) => JSON.stringify(r)).join('\n') + '\n');

// Le dashboard est une projection de messages.jsonl : on la régénère ici pour
// ne pas laisser data.js en retard sur ce qui vient d'être écrit.
execFileSync(process.execPath, [path.join(HERE, 'ingest.mjs'), '--rebuild'], {
  env: process.env,
  stdio: ['ignore', 'inherit', 'inherit'],
});

Object.assign(result, {
  called: stats.called,
  ok: stats.ok,
  errors: stats.errors,
  byCode: stats.byCode,
  tokens: stats.inputTokens + stats.outputTokens,
  written,
  remaining: eligible.length - batch.filter((m) => m.jev?.status === 'ok').length,
});
console.log(
  `JEV ${jev.model} — ${stats.ok}/${stats.called} ok, ${result.tokens} token(s), ${result.remaining} restant(s).`,
);
console.log(JSON.stringify(result));
