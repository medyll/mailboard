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
import { messageKey } from '../../../config/load.mjs';
import { readLabels, labelQuestions } from '../../../ingest/jev-labels.mjs';

/** @param {{root: string, configRoot?: string, reference?: string, logger?: import('../../adapters/logger.js').Logger}} options */
export function jevAgreement({ root, configRoot, reference = 'human', logger = globalThis.console }) {
const console = logger;

const ROOT = path.resolve(root);

// En dessous, un taux ne dit rien : on le montre, sans proposer de seuil.
const MIN_POSITIVES = 5;

const messageFile = path.join(ROOT, 'data', 'messages.jsonl');
const messages = (fs.existsSync(messageFile) ? fs.readFileSync(messageFile, 'utf8') : '')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
const byKey = new Map(messages.map((m) => [m.key ?? messageKey(m.sourceId, m.id), m]));

const { questionSet, questions } = labelQuestions(configRoot);
const { labels } = readLabels(ROOT, reference);
// Nom affiché de la référence : « humain », ou le relecteur (claude…).
const who = reference === 'human' ? 'humain' : reference;

// Paires (humain, JEV) comparables : même jeu de questions, décision JEV valide.
const pairs = Object.entries(labels)
  .filter(([, l]) => l.questionSet === questionSet)
  .map(([key, l]) => ({ key, human: l.answers, jev: byKey.get(key)?.jev }))
  .filter((p) => p.jev?.status === 'ok');

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)} %` : '—');
const report = { type: 'mailboard.jev-agreement.result', reference, questionSet, labeled: pairs.length, questions: {} };

console.log(`JEV vs ${who} — ${pairs.length} message(s) étiqueté(s), jeu ${questionSet}\n`);

// Une étiquette enregistrée sans rien toucher mesure les valeurs préremplies,
// pas le jugement humain. Au-delà d'un tiers, le rapport n'est pas fiable.
const untouched = pairs.filter((p) => labels[p.key].edited === false).length;
report.untouched = untouched;
if (reference === 'human' && pairs.length && untouched / pairs.length > 1 / 3) {
  console.log(
    `⚠ ${untouched}/${pairs.length} étiquettes enregistrées sans aucune modification : ` +
      `ce rapport reflète surtout les valeurs préremplies. Ne pas en tirer de seuil.\n`,
  );
}

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
      `${q.id} (oui/non) — ${rows.length} cas, ${pos.length} « oui » ${who}\n` +
        `  seuil 0,5 : ${base.tp} vrai(s) positif(s), ${base.fp} faux positif(s), ${base.fn} manqué(s)\n` +
        (s
          ? `  seuil proposé ${suggested} : 0 manqué, ${s.fp} faux positif(s), précision ${pct(s.tp, s.tp + s.fp)}`
          : `  seuil proposé : aucun (il faut au moins ${MIN_POSITIVES} « oui » ${who})`),
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
      const k = `${who} ${r.human} ← JEV ${r.jev.value}`;
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

// Un relecteur outillé ne vaut référence que s'il s'accorde avec vous : on le
// mesure sur les mails que vous avez étiquetés tous les deux.
if (reference !== 'human') {
  const mine = readLabels(ROOT, 'human').labels;
  const both = Object.keys(labels).filter((k) => mine[k]?.questionSet === questionSet && labels[k].questionSet === questionSet);
  const calibration = { overlap: both.length, questions: {} };
  if (both.length) console.log(`\n${who} vs humain — ${both.length} mail(s) étiqueté(s) des deux côtés`);
  for (const q of questions) {
    const rows = both
      .map((k) => ({ a: labels[k].answers[q.id], b: mine[k].answers[q.id] }))
      .filter((r) => r.a !== undefined && r.a !== null && r.b !== undefined && r.b !== null);
    if (!rows.length) continue;
    if (q.primitive === 'score') {
      const mae = rows.reduce((t, r) => t + Math.abs(r.a - r.b), 0) / rows.length;
      console.log(`  ${q.id} : écart moyen ${mae.toFixed(2)} niveau(x) sur ${rows.length}`);
      calibration.questions[q.id] = { n: rows.length, mae: Math.round(mae * 100) / 100 };
    } else {
      const same = rows.filter((r) => r.a === r.b).length;
      console.log(`  ${q.id} : accord ${pct(same, rows.length)} (${same}/${rows.length})`);
      calibration.questions[q.id] = { n: rows.length, agreement: same / rows.length };
    }
  }
  report.calibration = calibration;
}

if (!pairs.length) {
  console.log(
    reference === 'human'
      ? 'Aucune étiquette. Ouvrir dashboard/labeling-component/ via node settings/server.mjs.'
      : `Aucune étiquette ${who}. Lancer une relecture : outil MCP jev_review_queue puis jev_review_save.`,
  );
}
return report;
}
