// Étiquettes humaines des décisions JEV : la vérité terrain qui manque pour
// calibrer les seuils (JEV_INTEGRATION.md, « Politique locale dérivée »).
//
// Stockage : data/jev-labels.json, jamais versionné (data/ est ignoré). Une
// étiquette décrit le message, pas la réponse de JEV : elle reste valable si
// le modèle change, tant que le jeu de questions est le même.

import fs from 'node:fs';
import path from 'node:path';
import { loadJev } from '../config/load.mjs';

export const labelsFile = (root) => path.join(root, 'data', 'jev-labels.json');

export function readLabels(root) {
  const file = labelsFile(root);
  if (!fs.existsSync(file)) return { schemaVersion: 1, labels: {} };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { schemaVersion: 1, labels: raw.labels ?? {} };
}

/** Questions telles que la page d'étiquetage doit les poser. */
export function labelQuestions() {
  const jev = loadJev({ dry: true });
  return {
    questionSet: jev.questionSet,
    questions: (jev.raw.questions ?? [])
      .filter((q) => q.enabled !== false)
      .map((q) => ({
        id: q.id,
        primitive: q.primitive,
        text: q.text,
        options: q.options ?? null,
        levels: q.levels ?? null,
        requiresProfile: Boolean(q.requiresProfile),
      })),
  };
}

/**
 * Valide une réponse humaine. `null` est toujours accepté : « je ne sais pas »
 * ou « sans objet » vaut mieux qu'une réponse forcée.
 */
export function validateLabel(answers, questions) {
  const errors = [];
  if (!answers || typeof answers !== 'object') return ['answers manquant'];
  for (const [id, value] of Object.entries(answers)) {
    const q = questions.find((x) => x.id === id);
    if (!q) {
      errors.push(`question inconnue : ${id}`);
      continue;
    }
    if (value === null) continue;
    if (q.primitive === 'noul' && typeof value !== 'boolean') errors.push(`${id} : booléen attendu`);
    if (q.primitive === 'choice') {
      const allowed = Array.isArray(q.options) ? q.options : Object.keys(q.options ?? {});
      if (!allowed.includes(value)) errors.push(`${id} : option hors contrat`);
    }
    if (q.primitive === 'score') {
      const max = (q.levels?.length ?? 1) - 1;
      if (!Number.isInteger(value) || value < 0 || value > max) errors.push(`${id} : entier 0..${max} attendu`);
    }
  }
  return errors;
}

/** Écrit ou retire une étiquette. Écriture atomique : un fichier à moitié écrit perdrait tout le travail. */
export function saveLabel(root, { key, answers }) {
  if (typeof key !== 'string' || !key.includes(':')) return { ok: false, status: 422, errors: ['key invalide'] };
  const { questionSet, questions } = labelQuestions();
  const store = readLabels(root);

  if (answers === null) {
    delete store.labels[key];
  } else {
    const errors = validateLabel(answers, questions);
    if (errors.length) return { ok: false, status: 422, errors };
    store.labels[key] = { questionSet, labeledAt: new Date().toISOString(), answers };
  }

  const file = labelsFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store, null, 2) + '\n');
  fs.renameSync(temp, file);
  return { ok: true, status: 200, count: Object.keys(store.labels).length };
}
