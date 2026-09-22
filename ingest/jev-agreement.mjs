#!/usr/bin/env node
// Compare les décisions JEV aux étiquettes humaines (data/jev-labels.json) et
// propose des seuils. N'écrit rien : recopier un seuil dans config/jev.json
// reste une décision humaine.
//
// Usage :
//   node ingest/jev-agreement.mjs          rapport lisible + dernière ligne JSON
//
// Pour les questions oui/non, le seuil proposé est le plus haut qui ne rate
// aucun « oui » humain : JEV_INTEGRATION.md donne la priorité aux faux
// négatifs (invitations, échéances, demandes de réponse).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { messageKey } from '../config/load.mjs';
import { readLabels, labelQuestions } from './jev-labels.mjs';

const ROOT = process.env.MAILBOARD_ROOT
  ? path.resolve(process.env.MAILBOARD_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// En dessous, un taux ne dit rien : on le montre, sans proposer de seuil.
const MIN_POSITIVES = 5;

const messages = fs
  .readFileSync(path.join(ROOT, 'data', 'messages.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
const byKey = new Map(messages.map((m) => [m.key ?? messageKey(m.sourceId, m.id), m]));

const { questionSet, questions } = labelQuestions();
const { labels } = readLabels(ROOT);

// Paires (humain, JEV) comparables : même jeu de questions, décision JEV valide.
const pairs = Object.entries(labels)
  .filter(([, l]) => l.questionSet === questionSet)
  .map(([key, l]) => ({ key, human: l.answers, jev: byKey.get(key)?.jev }))
  .filter((p) => p.jev?.status === 'ok');

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)} %` : '—');
const report = { type: 'mailboard.jev-agreement.result', questionSet, labeled: pairs.length, questions: {} };

console.log(`JEV vs humain — ${pairs.length} message(s) étiqueté(s), jeu ${questionSet}\n`);

for (const q of questions) {
  const rows = pairs
    .filter((p) => p.human[q.id] !== undefined && p.human[q.id] !== null && p.jev.answers?.[q.id])
    .map((p) => ({ key: p.key, human: p.human[q.id], jev: p.jev.answers[q.id] }));
  if (!rows.length) continue;

  if (q.primitive === 'noul') {
    const pos = rows.filter((r) => r.human === true);
    const at = (t) => {
      const tp = rows.filter((r) => r.human && r.jev.probability >= t).length;
      const fp = rows.filter((r) => !r.human && r.jev.probability >= t).length;
      return { t, tp, fp, fn: pos.length - tp, precision: tp + fp ? tp / (tp + fp) : null };
    };
    const base = at(0.5);
    // Plus haut seuil sans faux négatif = le plus sélectif qui ne rate rien.
    const minPos = pos.length ? Math.min(...pos.map((r) => r.jev.probability)) : null;
    const suggested = pos.length >= MIN_POSITIVES ? Math.floor(minPos * 100) / 100 : null;
    const s = suggested !== null ? at(suggested) : null;
    console.log(
      `${q.id} (oui/non) — ${rows.length} cas, ${pos.length} « oui » humain(s)\n` +
        `  seuil 0,5 : ${base.tp} vrai(s) positif(s), ${base.fp} faux positif(s), ${base.fn} manqué(s)\n` +
        (s
          ? `  seuil proposé ${suggested} : 0 manqué, ${s.fp} faux positif(s), précision ${pct(s.tp, s.tp + s.fp)}`
          : `  seuil proposé : aucun (il faut au moins ${MIN_POSITIVES} « oui » humains)`),
    );
    report.questions[q.id] = { n: rows.length, positives: pos.length, at05: base, suggested, atSuggested: s };
  } else if (q.primitive === 'choice') {
    const ok = rows.filter((r) => r.human === r.jev.value);
    const wrong = rows.filter((r) => r.human !== r.jev.value);
    // Une erreur sûre d'elle ne se rattrape pas par un seuil de confiance.
    const confidentWrong = wrong.filter((r) => (r.jev.confidence ?? 0) >= 0.9);
    console.log(`${q.id} (choix) — accord ${pct(ok.length, rows.length)} (${ok.length}/${rows.length})`);
    const confusions = {};
    for (const r of wrong) {
      const k = `humain ${r.human} ← JEV ${r.jev.value}`;
      confusions[k] = (confusions[k] ?? 0) + 1;
    }
    for (const [k, n] of Object.entries(confusions).sort((a, b) => b[1] - a[1])) console.log(`  ${n} × ${k}`);
    if (confidentWrong.length) console.log(`  dont ${confidentWrong.length} erreur(s) avec une confiance ≥ 0,9`);
    report.questions[q.id] = { n: rows.length, agreement: ok.length / rows.length, confusions, confidentWrong: confidentWrong.length };
  } else {
    const errs = rows.map((r) => Math.abs(r.jev.value - r.human));
    const mae = errs.reduce((a, b) => a + b, 0) / errs.length;
    const close = errs.filter((e) => e < 1).length;
    console.log(`${q.id} (score) — écart moyen ${mae.toFixed(2)} niveau(x), ${pct(close, rows.length)} à moins d'un niveau`);
    report.questions[q.id] = { n: rows.length, mae: Math.round(mae * 100) / 100, withinOne: close / rows.length };
  }
}

if (!pairs.length) console.log('Aucune étiquette. Ouvrir dashboard/labeling-component/ via node settings/server.mjs.');
console.log(`\n${JSON.stringify(report)}`);
