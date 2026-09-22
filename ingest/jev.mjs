// Adaptateur JEV — seul endroit qui connaît le protocole TypeSafe System One.
//
// Le reste du projet manipule le vocabulaire de config/jev.json (primitive,
// texte, options, niveaux) ; la traduction vers POST /v1/systemone et la
// validation des réponses vivent ici. Changer de fournisseur ne devrait toucher
// que ce fichier.
//
// Règles non négociables, reprises de JEV_INTEGRATION.md :
//   - aucun id, threadId, lien ni horodatage n'est envoyé ;
//   - de l'expéditeur, seul le domaine part ;
//   - une réponse non conforme est une erreur, jamais un repli silencieux ;
//   - une panne du fournisseur devient un statut, jamais un run perdu.

import fs from 'node:fs';
import { createHash } from 'node:crypto';

/** Domaine de l'expéditeur — le local-part n'apprend rien au modèle. */
export function senderDomain(from) {
  const match = /<([^>]+)>/.exec(from ?? '') ?? [];
  const address = match[1] ?? from ?? '';
  const at = address.lastIndexOf('@');
  return at > -1 ? address.slice(at + 1).trim().toLowerCase() : null;
}

/** État minimal : strictement ce dont les questions ont besoin. */
export function buildState(message) {
  return {
    message: {
      currentCategory: message.category ?? null,
      senderDomain: senderDomain(message.from),
      subject: message.subject ?? '',
      summary: message.summary ?? '',
    },
  };
}

/** Empreinte des champs envoyés : dit si une décision correspond encore à son entrée. */
export const fingerprint = (state) =>
  `sha256:${createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 32)}`;

/** Vocabulaire mailboard → questions System One (map clé → question typée). */
function toApiQuestions(questions) {
  const out = {};
  for (const q of questions) {
    if (q.primitive === 'noul') {
      out[q.id] = { type: 'noul', instructions: q.text };
    } else if (q.primitive === 'choice') {
      // options : liste de valeurs, ou map valeur → description (mieux calibré).
      const criteria = Array.isArray(q.options)
        ? Object.fromEntries(q.options.map((o) => [o, o]))
        : q.options;
      out[q.id] = { type: 'choice', instructions: q.text, criteria };
    } else if (q.primitive === 'score') {
      out[q.id] = { type: 'score', instructions: q.text, criteria: q.levels };
    } else {
      throw new Error(`primitive inconnue : ${q.primitive} (${q.id})`);
    }
  }
  return out;
}

/**
 * Validation stricte. Une valeur hors options ou un type inattendu fait échouer
 * le message entier : convertir vers `other` masquerait une rupture de contrat.
 */
function validateAnswers(raw, questions) {
  const answers = {};
  for (const q of questions) {
    const a = raw?.[q.id];
    if (!a || typeof a !== 'object') throw new Error(`réponse absente pour ${q.id}`);

    if (q.primitive === 'noul') {
      // L'API renvoie une probabilité (`noul`) ; certaines versions renvoient un
      // booléen (`value`). Les deux sont acceptés, rien d'autre.
      const p = typeof a.noul === 'number' ? a.noul : typeof a.value === 'boolean' ? (a.value ? 1 : 0) : null;
      if (p === null || p < 0 || p > 1) throw new Error(`noul invalide pour ${q.id}`);
      answers[q.id] = { probability: round(p) };
      continue;
    }

    if (q.primitive === 'choice') {
      const allowed = Array.isArray(q.options) ? q.options : Object.keys(q.options ?? {});
      const value = a.choice ?? a.value;
      if (!allowed.includes(value)) throw new Error(`option hors contrat pour ${q.id} : ${value}`);
      answers[q.id] = {
        value,
        confidence: round(a.confidence),
        probabilities: roundAll(a.probabilities),
      };
      continue;
    }

    if (q.primitive === 'score') {
      const value = typeof a.score === 'number' ? a.score : a.value;
      const max = (q.levels?.length ?? 1) - 1;
      if (typeof value !== 'number' || value < 0 || value > max) {
        throw new Error(`score hors échelle pour ${q.id} : ${value}`);
      }
      answers[q.id] = { value: round(value), confidence: round(a.confidence) };
      continue;
    }

    throw new Error(`primitive inconnue : ${q.primitive} (${q.id})`);
  }
  return answers;
}

const round = (n) => (typeof n === 'number' ? Math.round(n * 1000) / 1000 : null);
const roundAll = (obj) =>
  obj && typeof obj === 'object'
    ? Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, round(v)]))
    : null;

/** Codes stables. Jamais de clé, d'en-tête ni de corps de réponse persistés. */
function statusCode(status) {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status === 422) return 'invalid_response';
  return 'unavailable';
}

// Un abandon de fetch remonte un DOMException qui porte déjà `code: 20` : on ne
// peut pas s'en servir comme marqueur, d'où un champ propre à l'adaptateur.
const aborted = (err) => err?.name === 'AbortError' || err?.cause?.name === 'AbortError';

async function callOne(config, state, questions, profileText, preferences) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const startedAt = Date.now();

  // Le profil accompagne l'état plutôt que de remplacer le message : le modèle
  // compare les deux, et la même clé sert à l'empreinte.
  const payload = {
    model: config.model,
    state: {
      ...state,
      ...(profileText ? { candidateProfile: profileText } : {}),
      // Le CV dit ce que la personne sait faire ; les préférences disent ce
      // qu'elle veut. Sans elles, `roleFit` note une offre Java au plus haut
      // parce que le parcours en contient.
      ...(preferences ? { candidatePreferences: preferences } : {}),
    },
    questions: toApiQuestions(questions),
  };

  try {
    const res = await fetch(config.endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    const requestId = res.headers.get('x-typesafe-request-id') ?? null;
    if (!res.ok) {
      // Le corps peut contenir l'état renvoyé en écho : on ne le garde pas.
      await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status}`);
      err.jevCode = statusCode(res.status);
      err.requestId = requestId;
      throw err;
    }

    const body = await res.json();
    return {
      answers: validateAnswers(body.answers, questions),
      model: body.model ?? config.model,
      requestId,
      usage: body.usage ?? null,
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    err.latencyMs = Date.now() - startedAt;
    if (err.jevCode) throw err;
    // Abandon = timeout. JSON illisible ou réponse hors contrat = rupture de
    // contrat. Tout le reste (DNS, socket coupée) = fournisseur indisponible.
    err.jevCode = aborted(err) ? 'timeout' : err instanceof TypeError ? 'unavailable' : 'invalid_response';
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Petit pool : quelques appels en vol, pas un par message d'un coup. */
async function pool(items, size, worker) {
  const queue = [...items.entries()];
  const runners = Array.from({ length: Math.max(1, Math.min(size, queue.length)) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      await worker(next[1], next[0]);
    }
  });
  await Promise.all(runners);
}

/**
 * Enrichit les nouveaux messages. Retourne des métriques ; chaque message reçoit
 * un bloc `jev`, y compris en cas d'échec. Aucun appel n'est fait pour un
 * doublon : l'appelant ne passe ici que ce qu'il s'apprête à écrire.
 */
export async function enrich(messages, config, { criteria, preferences, onMetric } = {}) {
  const stats = { called: 0, ok: 0, errors: 0, skipped: 0, byCode: {}, latencyMs: 0, inputTokens: 0, outputTokens: 0 };
  if (!messages.length) return stats;

  if (!config.enabled) {
    for (const m of messages) m.jev = { status: 'skipped', reason: config.status, schemaVersion: 1 };
    stats.skipped = messages.length;
    return stats;
  }

  const profileText = config.profile.send
    ? fs.readFileSync(config.profile.file, 'utf8').slice(0, config.profile.maxChars)
    : null;
  const fitOnly = new Set(criteria?.profileMatchIds ?? []);

  await pool(messages, config.concurrency, async (message) => {
    // Juger l'adéquation d'un courrier administratif au CV n'a pas de sens :
    // les questions de fit ne partent que pour les critères qui le demandent.
    const questions = config.questions.filter((q) => !q.requiresProfile || fitOnly.has(message.category));
    if (!questions.length) {
      message.jev = { status: 'skipped', reason: 'no-question-for-category', schemaVersion: 1 };
      stats.skipped++;
      return;
    }

    const state = buildState(message);
    // L'empreinte couvre l'état du message ; profil et préférences sont
    // identiques d'un message à l'autre dans un même run.
    const base = {
      schemaVersion: 1,
      questionSet: config.questionSet,
      inputFingerprint: fingerprint(state),
      evaluatedAt: new Date().toISOString(),
    };

    stats.called++;
    try {
      const res = await callOne(config, state, questions, profileText, preferences);
      message.jev = {
        ...base,
        status: 'ok',
        model: res.model,
        requestId: res.requestId,
        answers: res.answers,
      };
      stats.ok++;
      stats.latencyMs += res.latencyMs;
      stats.inputTokens += res.usage?.input_tokens ?? 0;
      stats.outputTokens += res.usage?.output_tokens ?? 0;
      onMetric?.({ key: message.key, status: 'ok', code: null, latencyMs: res.latencyMs, model: res.model, requestId: res.requestId, usage: res.usage });
    } catch (err) {
      const code = err.jevCode ?? 'unavailable';
      message.jev = { ...base, status: 'error', code, model: config.model, requestId: err.requestId ?? null };
      stats.errors++;
      stats.byCode[code] = (stats.byCode[code] ?? 0) + 1;
      onMetric?.({ key: message.key, status: 'error', code, latencyMs: err.latencyMs ?? null, model: config.model, requestId: err.requestId ?? null });
    }
  });

  return stats;
}

/** Réévaluation hors ingestion : mêmes règles, appliquées à des messages déjà écrits. */
export const reevaluate = enrich;
