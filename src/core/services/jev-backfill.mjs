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
import { loadCriteria, loadJev, loadPreferences, messageKey } from '../../../config/load.mjs';
import { reevaluate, buildState, fingerprint } from '../../../ingest/jev.mjs';
import { ingestRuns } from './ingestion.mjs';

/** @param {{root: string, configRoot?: string, dry?: boolean, stale?: boolean, sourceId?: string, limit?: number, logger?: import('../../adapters/logger.js').Logger}} options */
export async function backfillJev({ root, configRoot, dry = false, stale = false, sourceId = null, limit = 20, logger = globalThis.console }) {
if (!root) throw new Error('root est requis');
if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit doit être entre 1 et 200');
const console = logger;

const ROOT = path.resolve(root);
const MESSAGES = path.join(ROOT, 'data', 'messages.jsonl');
const JEV_LOG = path.join(ROOT, 'data', 'jev-runs.jsonl');

const DRY = dry;
const STALE = stale;

const readJsonl = (file) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];

const keyOf = (m) => m.key ?? messageKey(m.sourceId, m.id);

const jev = loadJev({ cliFlag: true, dry: DRY, root: configRoot, profileRoot: ROOT });
const criteria = loadCriteria({ root: configRoot });
const preferences = loadPreferences({ root: configRoot });

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
  return result;
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
await ingestRuns({ root: ROOT, configRoot, rebuildOnly: true, logger });

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
return result;
}
