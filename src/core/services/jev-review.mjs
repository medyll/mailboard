// Relecture des décisions JEV par un relecteur outillé (Claude, via le serveur
// MCP ou la CLI) : il lit le corps du mail et répond aux mêmes questions que
// JEV, sans voir les réponses de JEV. Ses étiquettes vont dans leur propre
// fichier (data/jev-labels.<relecteur>.json) ; le rapport d'accord compare
// ensuite JEV à ce relecteur, et ce relecteur à vos étiquettes humaines.
//
// Le corps ne quitte pas la machine par ce chemin : c'est l'agent local qui le
// lit, pas un service distant.

import fs from 'node:fs';
import path from 'node:path';
import { messageKey } from '../../../config/load.mjs';
import { readLabels, labelQuestions, saveLabel } from '../../../ingest/jev-labels.mjs';

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

// Distance à l'hésitation : 0 quand JEV répond 0,5 à une question oui/non.
const certainty = (jev) => {
  const probs = Object.values(jev?.answers ?? {})
    .map((a) => a?.probability)
    .filter((p) => typeof p === 'number');
  return probs.length ? Math.min(...probs.map((p) => Math.abs(p - 0.5))) : 1;
};

/**
 * Prochain lot à relire, à l'aveugle. Ordre : d'abord les mails que vous avez
 * étiquetés (ils mesurent la fiabilité du relecteur), puis selon `order` :
 * - `recent` (défaut) : les plus récents — échantillon représentatif ;
 * - `uncertain` : ceux où JEV hésite le plus sur une question oui/non. C'est
 *   là qu'une relecture apprend le plus, mais l'échantillon n'est plus
 *   représentatif : les taux du rapport d'accord s'en trouvent biaisés.
 * Le lot ne contient jamais les réponses de JEV, seulement l'ordre en dépend.
 * Seuls les mails avec un corps stocké et une décision JEV valide entrent.
 */
export function reviewQueue({ root, configRoot, reviewer = 'claude', limit = 10, maxChars = 4000, order = 'recent' }) {
  if (!['recent', 'uncertain'].includes(order)) throw new Error('order attend recent ou uncertain');
  if (reviewer === 'human') throw new Error('la relecture humaine passe par la page d’étiquetage');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit doit être entre 1 et 50');
  const ROOT = path.resolve(root);
  const bodies = new Map(
    readJsonl(path.join(ROOT, 'data', 'bodies.jsonl'))
      .filter((b) => b.text)
      .map((b) => [b.key ?? messageKey(b.sourceId, b.id), b]),
  );
  const done = readLabels(ROOT, reviewer).labels;
  const human = readLabels(ROOT, 'human').labels;
  const { questionSet, questions } = labelQuestions(configRoot);

  const candidates = readJsonl(path.join(ROOT, 'data', 'messages.jsonl'))
    .map((m) => ({ ...m, key: m.key ?? messageKey(m.sourceId, m.id) }))
    .filter((m) => bodies.has(m.key) && m.jev?.status === 'ok' && done[m.key]?.questionSet !== questionSet)
    .sort(
      (a, b) =>
        Number(Boolean(human[b.key])) - Number(Boolean(human[a.key])) ||
        (order === 'uncertain' ? certainty(a.jev) - certainty(b.jev) : 0) ||
        (a.date < b.date ? 1 : -1),
    );

  return {
    type: 'mailboard.jev-review.queue',
    reviewer,
    order,
    questionSet,
    questions,
    remaining: candidates.length,
    instructions:
      'Répondre à chaque question depuis le mail seul (objet, expéditeur, corps). null si la question est sans objet ou indécidable. ' +
      'Ne pas chercher à deviner ce que JEV a répondu.',
    items: candidates.slice(0, limit).map((m) => {
      const text = bodies.get(m.key).text;
      return {
        key: m.key,
        date: m.date,
        from: m.from,
        subject: m.subject,
        category: m.category,
        body: text.length > maxChars ? text.slice(0, maxChars) : text,
        truncated: text.length > maxChars,
      };
    }),
  };
}

/**
 * Enregistre un lot d'étiquettes du relecteur ; une étiquette invalide n'arrête pas les autres.
 * @param {{root: string, reviewer?: string, model?: string, labels: {key: string, answers: Record<string, unknown> | null}[]}} options
 */
export function saveReview({ root, reviewer = 'claude', model, labels }) {
  if (reviewer === 'human') throw new Error('la relecture humaine passe par la page d’étiquetage');
  if (!Array.isArray(labels) || !labels.length) throw new Error('labels : tableau non vide attendu');
  const ROOT = path.resolve(root);
  const errors = [];
  let saved = 0;
  let count = 0;
  for (const { key, answers } of labels) {
    const res = saveLabel(ROOT, { key, answers, reviewer, model });
    if (res.ok) {
      saved++;
      count = res.count;
    } else errors.push({ key, errors: res.errors });
  }
  return { type: 'mailboard.jev-review.saved', reviewer, saved, errors, total: count || Object.keys(readLabels(ROOT, reviewer).labels).length };
}
