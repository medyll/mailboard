import fs from 'node:fs';
import path from 'node:path';

const FILES = Object.freeze({
  criteria: 'criteria.json',
  preferences: 'preferences.json',
  jev: 'jev.json',
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const isId = (value) => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);

export function readSettings(root) {
  const configDir = path.join(root, 'config');
  return Object.fromEntries(
    Object.entries(FILES).map(([key, file]) => [key, JSON.parse(fs.readFileSync(path.join(configDir, file), 'utf8'))]),
  );
}

export function validateSettings(settings) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });

  if (!isObject(settings)) return [{ path: '', message: 'La configuration doit être un objet.' }];
  for (const key of Object.keys(FILES)) {
    if (!isObject(settings[key])) add(key, `Le fichier ${FILES[key]} est absent ou invalide.`);
  }
  if (errors.length) return errors;

  validateCriteria(settings.criteria, add);
  validatePreferences(settings.preferences, add);
  validateJev(settings.jev, add);
  return errors;
}

function validateCriteria(config, add) {
  const windowHours = config.defaults?.windowHours;
  if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 720) {
    add('criteria.defaults.windowHours', 'La fenêtre doit être un entier entre 1 et 720 heures.');
  }
  if (!Array.isArray(config.criteria) || config.criteria.length === 0) {
    add('criteria.criteria', 'Ajoutez au moins un critère.');
    return;
  }

  const ids = new Set();
  config.criteria.forEach((criterion, index) => {
    const base = `criteria.criteria.${index}`;
    if (!isObject(criterion)) {
      add(base, 'Le critère doit être un objet.');
      return;
    }
    validateUniqueId(criterion.id, `${base}.id`, ids, add);
    if (!isText(criterion.label)) add(`${base}.label`, 'Le libellé est obligatoire.');
    if (criterion.enabled !== undefined && typeof criterion.enabled !== 'boolean') {
      add(`${base}.enabled`, 'enabled doit être vrai ou faux.');
    }
    if (!isObject(criterion.queries)) {
      add(`${base}.queries`, 'Les requêtes doivent former un objet.');
      return;
    }
    for (const [provider, query] of Object.entries(criterion.queries)) {
      if (provider.startsWith('$')) continue;
      if (provider === 'keywords' || provider === 'fromDomains') {
        validateStringList(query, `${base}.queries.${provider}`, add, false);
      } else if (typeof query !== 'string') {
        add(`${base}.queries.${provider}`, `La requête ${provider} doit être du texte.`);
      }
    }
  });

  const fallbackId = config.fallback?.id;
  if (!isId(fallbackId)) add('criteria.fallback.id', 'L’identifiant de repli doit être en kebab-case.');
  if (!isText(config.fallback?.label)) add('criteria.fallback.label', 'Le libellé de repli est obligatoire.');
  if (ids.has(fallbackId)) add('criteria.fallback.id', 'Le repli ne peut pas reprendre l’identifiant d’un critère.');

  const known = new Set([...ids, fallbackId]);
  if (config.aliases !== undefined && !isObject(config.aliases)) {
    add('criteria.aliases', 'Les alias doivent former un objet.');
  } else {
    for (const [alias, target] of Object.entries(config.aliases ?? {})) {
      if (!isId(alias)) add(`criteria.aliases.${alias}`, 'Un alias doit être en kebab-case.');
      if (!known.has(target)) add(`criteria.aliases.${alias}`, `La cible « ${target} » n’existe pas.`);
    }
  }
}

function validatePreferences(config, add) {
  if (!Array.isArray(config.preferences)) {
    add('preferences.preferences', 'La liste des préférences est obligatoire.');
    return;
  }
  const weights = config.weights ?? {};
  for (const strength of ['blocker', 'strong', 'mild']) {
    if (!Number.isFinite(weights[strength]) || weights[strength] < 0) {
      add(`preferences.weights.${strength}`, `Le poids ${strength} doit être un nombre positif.`);
    }
  }

  const ids = new Set();
  config.preferences.forEach((preference, index) => {
    const base = `preferences.preferences.${index}`;
    if (!isObject(preference)) {
      add(base, 'La préférence doit être un objet.');
      return;
    }
    validateUniqueId(preference.id, `${base}.id`, ids, add);
    if (!isText(preference.label)) add(`${base}.label`, 'Le libellé est obligatoire.');
    if (preference.enabled !== undefined && typeof preference.enabled !== 'boolean') {
      add(`${base}.enabled`, 'enabled doit être vrai ou faux.');
    }
    if (!['pro', 'con'].includes(preference.kind)) add(`${base}.kind`, 'Choisissez pro ou con.');
    if (!['blocker', 'strong', 'mild'].includes(preference.strength)) {
      add(`${base}.strength`, 'Choisissez blocker, strong ou mild.');
    }
    validateStringList(preference.match?.keywords, `${base}.match.keywords`, add, true);
  });
}

function validateJev(config, add) {
  if (typeof config.enabled !== 'boolean') add('jev.enabled', 'enabled doit être vrai ou faux.');
  if (!isText(config.model)) add('jev.model', 'Le modèle est obligatoire.');
  if (!isText(config.questionSet)) add('jev.questionSet', 'Le jeu de questions est obligatoire.');
  try {
    const endpoint = new URL(config.endpoint);
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('protocol');
  } catch {
    add('jev.endpoint', 'L’endpoint doit être une URL HTTP ou HTTPS valide.');
  }
  validateInteger(config.timeoutMs, 'jev.timeoutMs', 500, 120000, add);
  validateInteger(config.concurrency, 'jev.concurrency', 1, 20, add);
  validateInteger(config.retriesPerRun, 'jev.retriesPerRun', 0, 5, add);
  validateInteger(config.profile?.maxChars, 'jev.profile.maxChars', 500, 50000, add);
  for (const [key, value] of Object.entries(config.thresholds ?? {})) {
    if (key.startsWith('$')) continue;
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1)) {
      add(`jev.thresholds.${key}`, 'Un seuil doit être vide ou compris entre 0 et 1.');
    }
  }
  if (!Array.isArray(config.questions) || config.questions.length === 0) {
    add('jev.questions', 'Ajoutez au moins une question JEV.');
    return;
  }

  const ids = new Set();
  config.questions.forEach((question, index) => {
    const base = `jev.questions.${index}`;
    if (!isObject(question)) {
      add(base, 'La question doit être un objet.');
      return;
    }
    validateUniqueQuestionId(question.id, `${base}.id`, ids, add);
    if (question.enabled !== undefined && typeof question.enabled !== 'boolean') {
      add(`${base}.enabled`, 'enabled doit être vrai ou faux.');
    }
    if (!['noul', 'choice', 'score'].includes(question.primitive)) {
      add(`${base}.primitive`, 'La primitive doit être noul, choice ou score.');
    }
    if (!isText(question.text)) add(`${base}.text`, 'La formulation est obligatoire.');
    if (!isText(question.usage)) add(`${base}.usage`, 'L’usage est obligatoire.');
    if (question.requiresProfile !== undefined && typeof question.requiresProfile !== 'boolean') {
      add(`${base}.requiresProfile`, 'requiresProfile doit être vrai ou faux.');
    }
    if (question.primitive === 'choice') {
      if (!isObject(question.options) || Object.keys(question.options).length < 2) {
        add(`${base}.options`, 'Une question choice demande au moins deux options.');
      } else {
        for (const [key, description] of Object.entries(question.options)) {
          if (!/^[a-z0-9_]+$/.test(key) || !isText(description)) {
            add(`${base}.options.${key}`, 'Chaque option demande une clé simple et une description.');
          }
        }
      }
    }
    if (question.primitive === 'score') validateStringList(question.levels, `${base}.levels`, add, true, 2);
  });
}

function validateUniqueId(value, path, ids, add) {
  if (!isId(value)) {
    add(path, 'L’identifiant doit être en kebab-case.');
    return;
  }
  if (ids.has(value)) add(path, `L’identifiant « ${value} » est dupliqué.`);
  ids.add(value);
}

function validateUniqueQuestionId(value, path, ids, add) {
  if (typeof value !== 'string' || !/^[a-z][A-Za-z0-9]*$/.test(value)) {
    add(path, 'L’identifiant JEV doit être en camelCase.');
    return;
  }
  if (ids.has(value)) add(path, `L’identifiant « ${value} » est dupliqué.`);
  ids.add(value);
}

function validateStringList(value, path, add, required, minimum = required ? 1 : 0) {
  if (!Array.isArray(value)) {
    if (required) add(path, 'Une liste est obligatoire.');
    return;
  }
  if (value.length < minimum) add(path, `Ajoutez au moins ${minimum} valeur(s).`);
  if (value.some((item) => !isText(item))) add(path, 'Chaque valeur doit être un texte non vide.');
}

function validateInteger(value, path, minimum, maximum, add) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    add(path, `La valeur doit être un entier entre ${minimum} et ${maximum}.`);
  }
}

export function prepareSettings(settings, now = new Date()) {
  const copy = structuredClone(settings);
  const date = now.toISOString().slice(0, 10);
  copy.criteria.updatedAt = date;
  copy.preferences.updatedAt = date;
  return copy;
}

export function serializeSettings(settings) {
  return Object.fromEntries(
    Object.entries(FILES).map(([key, file]) => [path.join('config', file), `${JSON.stringify(settings[key], null, 2)}\n`]),
  );
}

export const settingsFiles = FILES;
