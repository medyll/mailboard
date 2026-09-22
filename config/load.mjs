// Chargement des fichiers de configuration de jobmailboard.
//
// Un seul endroit sait où vivent les fichiers, comment un secret est résolu et
// comment une catégorie historique se rattache à un critère actuel. L'ingesteur
// et les collecteurs importent ce module ; ils ne lisent jamais config/ eux-mêmes.
//
// Variables d'environnement reconnues : voir config/README.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_DIR = process.env.MAILBOARD_CONFIG_DIR
  ? path.resolve(ROOT, process.env.MAILBOARD_CONFIG_DIR)
  : path.join(ROOT, 'config');

const resolvePath = (envVar, fallback) =>
  process.env[envVar] ? path.resolve(ROOT, process.env[envVar]) : path.join(CONFIG_DIR, fallback);

export const PATHS = {
  criteria: resolvePath('MAILBOARD_CRITERIA', 'criteria.json'),
  channels: resolvePath('MAILBOARD_CHANNELS', 'channels.local.json'),
  channelsExample: path.join(CONFIG_DIR, 'channels.example.json'),
  jev: resolvePath('MAILBOARD_JEV_CONFIG', 'jev.json'),
  preferences: resolvePath('MAILBOARD_PREFERENCES', 'preferences.json'),
};

function readJson(file, { optional = false } = {}) {
  if (!fs.existsSync(file)) {
    if (optional) return null;
    throw new Error(`Configuration absente : ${path.relative(ROOT, file)}`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Configuration illisible : ${path.relative(ROOT, file)} — ${err.message}`);
  }
}

// "env:NOM" → valeur de process.env.NOM. Garde endpoints, identifiants et
// chemins hors des fichiers de configuration, et les secrets hors du dépôt.
function resolveEnv(value, trail = '') {
  if (typeof value === 'string' && value.startsWith('env:')) {
    const name = value.slice(4);
    const found = process.env[name];
    if (found === undefined) {
      console.warn(`  ! ${trail || 'config'} : variable d'environnement ${name} non définie`);
      return null;
    }
    return found;
  }
  if (Array.isArray(value)) return value.map((v, i) => resolveEnv(v, `${trail}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveEnv(v, trail ? `${trail}.${k}` : k)]),
    );
  }
  return value;
}

// Les clés « $… » documentent le fichier pour le lecteur humain ; elles ne
// portent aucune configuration et sont retirées avant usage.
function stripComments(value) {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !k.startsWith('$'))
        .map(([k, v]) => [k, stripComments(v)]),
    );
  }
  return value;
}

/** Critères de tri : catégories du dashboard, alias historiques, requêtes par fournisseur. */
export function loadCriteria() {
  const raw = stripComments(readJson(PATHS.criteria));
  const enabled = (raw.criteria ?? []).filter((c) => c.enabled !== false);
  const fallback = raw.fallback ?? { id: 'autre', label: 'Autre' };

  const categories = [...enabled, fallback].map((c) => ({
    id: c.id,
    label: c.label ?? c.id,
    color: c.color ?? null,
  }));
  const known = new Set(categories.map((c) => c.id));
  const aliases = raw.aliases ?? {};

  return {
    raw,
    categories,
    ids: categories.map((c) => c.id),
    fallbackId: fallback.id,
    defaults: raw.defaults ?? {},

    /** Catégorie déclarée par un collecteur → catégorie actuelle (alias résolu, repli sinon). */
    resolveCategory(value) {
      if (known.has(value)) return value;
      const aliased = aliases[value];
      return aliased && known.has(aliased) ? aliased : fallback.id;
    },

    /** Requêtes prêtes à l'emploi pour un fournisseur, fenêtre substituée. */
    queriesFor(provider, { windowHours = raw.defaults?.windowHours ?? 12 } = {}) {
      const out = {};
      for (const c of enabled) {
        const template = c.queries?.[provider];
        if (typeof template !== 'string') continue;
        out[c.id] = template.replaceAll('{windowHours}', String(windowHours));
      }
      return out;
    },

    /**
     * Classement local, pour les collecteurs qui lisent une liste sans moteur de
     * recherche. Déterministe et lisible : un domaine déclaré tranche, sinon le
     * critère qui a le plus de mots-clés présents l'emporte. Aucune égalité n'est
     * départagée au hasard — à égalité, l'ordre du fichier fait foi.
     */
    classify({ from = '', subject = '', snippet = '' } = {}) {
      const haystack = `${from} ${subject} ${snippet}`.toLowerCase();
      const domain = /[\w.+-]+@([\w-]+\.[\w.]+)/.exec(from)?.[1]?.toLowerCase() ?? '';

      let best = { id: fallback.id, score: 0 };
      for (const c of enabled) {
        const domains = c.queries?.fromDomains ?? [];
        if (domain && domains.some((d) => domain === d || domain.endsWith(`.${d}`))) {
          return { id: c.id, reason: 'domaine' };
        }
        const hits = (c.queries?.keywords ?? []).filter((k) => haystack.includes(k.toLowerCase())).length;
        if (hits > best.score) best = { id: c.id, score: hits };
      }
      return { id: best.id, reason: best.score ? `${best.score} mot(s)-clé(s)` : 'aucun critère' };
    },

    /** Critères où l'adéquation au profil a un sens (offres, pas administratif). */
    profileMatchIds: enabled.filter((c) => c.profileMatch).map((c) => c.id),
  };
}

/**
 * Registre des canaux. channels.local.json est optionnel : sans lui, seule la
 * collecte Gmail historique tourne, et l'exemple sert de documentation.
 */
export function loadChannels({ includeDisabled = false } = {}) {
  const file = fs.existsSync(PATHS.channels) ? PATHS.channels : null;
  const raw = file ? stripComments(readJson(file)) : { channels: [], defaults: {} };
  const defaults = raw.defaults ?? {};

  const channels = (raw.channels ?? [])
    .filter((c) => includeDisabled || c.enabled !== false)
    .map((c) => {
      const merged = { ...c, collection: { ...defaults, ...(c.collection ?? {}) } };
      return resolveEnv(merged, `channels[${c.sourceId}]`);
    });

  const seen = new Set();
  for (const c of channels) {
    if (!c.sourceId) throw new Error('channels : un canal sans sourceId');
    if (seen.has(c.sourceId)) throw new Error(`channels : sourceId dupliqué — ${c.sourceId}`);
    seen.add(c.sourceId);
  }

  return { file, defaults, channels, byId: new Map(channels.map((c) => [c.sourceId, c])) };
}

/**
 * Configuration JEV. `enabled` vient du fichier, puis de MAILBOARD_JEV, puis du
 * flag CLI : le plus explicite gagne. `dry` coupe tout, sans condition.
 */
export function loadJev({ cliFlag = false, dry = false } = {}) {
  const raw = stripComments(readJson(PATHS.jev, { optional: true })) ?? { enabled: false, questions: [] };
  const fromEnv = process.env.MAILBOARD_JEV;
  const wanted = cliFlag || (fromEnv !== undefined ? fromEnv === '1' || fromEnv === 'true' : Boolean(raw.enabled));

  const apiKey = process.env[raw.apiKeyEnv ?? 'TYPESAFE_API_KEY'] ?? null;
  const model = process.env.MAILBOARD_JEV_MODEL ?? raw.model ?? 'jev-latest';

  const profileFile = process.env.MAILBOARD_PROFILE
    ? path.resolve(ROOT, process.env.MAILBOARD_PROFILE)
    : path.join(ROOT, raw.profile?.file ?? 'profile/profile.jev.md');
  const hasProfile = fs.existsSync(profileFile);
  const sendProfile = Boolean(raw.profile?.send) && hasProfile;

  // Une question de fit sans profil porterait sur un contexte absent.
  const questions = (raw.questions ?? []).filter((q) => q.enabled !== false && (!q.requiresProfile || sendProfile));

  let status = 'ok';
  if (dry) status = 'skipped:dry';
  else if (!wanted) status = 'skipped:disabled';
  else if (!apiKey) status = 'skipped:no-key';

  return {
    raw,
    enabled: status === 'ok',
    status,
    // Surchargeable pour pointer un bouchon local pendant les tests ou une
    // passerelle interne : l'adaptateur ne connaît qu'une URL.
    endpoint: process.env.MAILBOARD_JEV_ENDPOINT ?? raw.endpoint,
    model,
    apiKey,
    questions,
    questionSet: raw.questionSet ?? 'unversioned',
    timeoutMs: Number(process.env.MAILBOARD_JEV_TIMEOUT_MS ?? raw.timeoutMs ?? 8000),
    concurrency: Number(process.env.MAILBOARD_JEV_CONCURRENCY ?? raw.concurrency ?? 4),
    retriesPerRun: raw.retriesPerRun ?? 0,
    thresholds: raw.thresholds ?? {},
    profile: {
      file: profileFile,
      send: sendProfile,
      available: hasProfile,
      maxChars: raw.profile?.maxChars ?? 4000,
    },
  };
}

/**
 * Préférences : ce qu'on veut, par opposition au CV qui dit ce qu'on sait faire.
 * Le calcul est déterministe et local — aucun modèle, aucun appel. Un `con`
 * rédhibitoire signale une offre, il ne la supprime jamais : la décision reste
 * à l'humain, et une préférence mal formulée ne doit pas faire disparaître une
 * opportunité en silence.
 */
export function loadPreferences() {
  const raw = stripComments(readJson(PATHS.preferences, { optional: true })) ?? { preferences: [] };
  const entries = (raw.preferences ?? []).filter((p) => p.enabled !== false);
  const weights = { blocker: 4, strong: 2, mild: 1, ...(raw.weights ?? {}) };

  return {
    raw,
    entries,
    labels: Object.fromEntries(entries.map((p) => [p.id, p.label ?? p.id])),

    /** Renvoie les préférences touchées par un message, et le score qui en découle. */
    evaluate({ from = '', subject = '', summary = '' } = {}) {
      const haystack = `${from} ${subject} ${summary}`.toLowerCase();
      const pro = [];
      const con = [];
      let score = 0;
      let blocked = false;

      for (const p of entries) {
        const hit = (p.match?.keywords ?? []).find((k) => haystack.includes(k.toLowerCase()));
        if (!hit) continue;
        const weight = weights[p.strength] ?? 1;
        if (p.kind === 'con') {
          con.push(p.id);
          score -= weight;
          if (p.strength === 'blocker') blocked = true;
        } else {
          pro.push(p.id);
          score += weight;
        }
      }
      return { score, pro, con, blocked };
    },

    /** Résumé court, destiné au modèle métier : des intentions, pas une identité. */
    digest() {
      const ligne = (kind) =>
        entries
          .filter((p) => p.kind === kind)
          .map((p) => `${p.label ?? p.id}${p.strength === 'blocker' ? ' (rédhibitoire)' : ''}`)
          .join(', ');
      return { wants: ligne('pro'), avoids: ligne('con') };
    },
  };
}

/** Clé canonique multi-source : un id externe n'est unique que dans son canal. */
export const messageKey = (sourceId, id) => `${sourceId || 'gmail-legacy'}:${id}`;

export const windowHours = (fallback = 12) => Number(process.env.MAILBOARD_WINDOW_HOURS ?? fallback);
