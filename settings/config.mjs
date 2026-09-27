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

  if (!isObject(settings)) return [{ path: '', message: 'The configuration must be an object.' }];
  for (const key of Object.keys(FILES)) {
    if (!isObject(settings[key])) add(key, `File ${FILES[key]} is missing or invalid.`);
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
    add('criteria.defaults.windowHours', 'The window must be an integer between 1 and 720 hours.');
  }
  if (!Array.isArray(config.criteria) || config.criteria.length === 0) {
    add('criteria.criteria', 'Add at least one criterion.');
    return;
  }

  const ids = new Set();
  config.criteria.forEach((criterion, index) => {
    const base = `criteria.criteria.${index}`;
    if (!isObject(criterion)) {
      add(base, 'The criterion must be an object.');
      return;
    }
    validateUniqueId(criterion.id, `${base}.id`, ids, add);
    if (!isText(criterion.label)) add(`${base}.label`, 'The label is required.');
    if (criterion.enabled !== undefined && typeof criterion.enabled !== 'boolean') {
      add(`${base}.enabled`, 'enabled must be true or false.');
    }
    if (!isObject(criterion.queries)) {
      add(`${base}.queries`, 'Queries must form an object.');
      return;
    }
    for (const [provider, query] of Object.entries(criterion.queries)) {
      if (provider.startsWith('$')) continue;
      if (provider === 'keywords' || provider === 'fromDomains') {
        validateStringList(query, `${base}.queries.${provider}`, add, false);
      } else if (typeof query !== 'string') {
        add(`${base}.queries.${provider}`, `The ${provider} query must be text.`);
      }
    }
  });

  const fallbackId = config.fallback?.id;
  if (!isId(fallbackId)) add('criteria.fallback.id', 'The fallback identifier must be kebab-case.');
  if (!isText(config.fallback?.label)) add('criteria.fallback.label', 'The fallback label is required.');
  if (ids.has(fallbackId)) add('criteria.fallback.id', 'The fallback cannot reuse a criterion identifier.');

  const known = new Set([...ids, fallbackId]);
  if (config.aliases !== undefined && !isObject(config.aliases)) {
    add('criteria.aliases', 'Aliases must form an object.');
  } else {
    for (const [alias, target] of Object.entries(config.aliases ?? {})) {
      if (!isId(alias)) add(`criteria.aliases.${alias}`, 'An alias must be kebab-case.');
      if (!known.has(target)) add(`criteria.aliases.${alias}`, `Target "${target}" does not exist.`);
    }
  }
}

function validatePreferences(config, add) {
  if (!Array.isArray(config.preferences)) {
    add('preferences.preferences', 'The preference list is required.');
    return;
  }
  const weights = config.weights ?? {};
  for (const strength of ['blocker', 'strong', 'mild']) {
    if (!Number.isFinite(weights[strength]) || weights[strength] < 0) {
      add(`preferences.weights.${strength}`, `The ${strength} weight must be a positive number.`);
    }
  }

  const ids = new Set();
  config.preferences.forEach((preference, index) => {
    const base = `preferences.preferences.${index}`;
    if (!isObject(preference)) {
      add(base, 'The preference must be an object.');
      return;
    }
    validateUniqueId(preference.id, `${base}.id`, ids, add);
    if (!isText(preference.label)) add(`${base}.label`, 'The label is required.');
    if (preference.enabled !== undefined && typeof preference.enabled !== 'boolean') {
      add(`${base}.enabled`, 'enabled must be true or false.');
    }
    if (!['pro', 'con'].includes(preference.kind)) add(`${base}.kind`, 'Choose pro or con.');
    if (!['blocker', 'strong', 'mild'].includes(preference.strength)) {
      add(`${base}.strength`, 'Choose blocker, strong or mild.');
    }
    validateStringList(preference.match?.keywords, `${base}.match.keywords`, add, true);
  });
}

function validateJev(config, add) {
  if (typeof config.enabled !== 'boolean') add('jev.enabled', 'enabled must be true or false.');
  if (!isText(config.model)) add('jev.model', 'The model is required.');
  if (!isText(config.questionSet)) add('jev.questionSet', 'The question set is required.');
  try {
    const endpoint = new URL(config.endpoint);
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('protocol');
  } catch {
    add('jev.endpoint', 'The endpoint must be a valid HTTP or HTTPS URL.');
  }
  validateInteger(config.timeoutMs, 'jev.timeoutMs', 500, 120000, add);
  validateInteger(config.concurrency, 'jev.concurrency', 1, 20, add);
  validateInteger(config.retriesPerRun, 'jev.retriesPerRun', 0, 5, add);
  validateInteger(config.profile?.maxChars, 'jev.profile.maxChars', 500, 50000, add);
  if (config.body !== undefined) {
    if (typeof config.body?.send !== 'boolean') add('jev.body.send', 'Sending the body must be true or false.');
    validateInteger(config.body?.maxChars ?? 1500, 'jev.body.maxChars', 200, 12000, add);
  }
  for (const [key, value] of Object.entries(config.thresholds ?? {})) {
    if (key.startsWith('$')) continue;
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1)) {
      add(`jev.thresholds.${key}`, 'A threshold must be empty or between 0 and 1.');
    }
  }
  if (!Array.isArray(config.questions) || config.questions.length === 0) {
    add('jev.questions', 'Add at least one JEV question.');
    return;
  }

  const ids = new Set();
  config.questions.forEach((question, index) => {
    const base = `jev.questions.${index}`;
    if (!isObject(question)) {
      add(base, 'The question must be an object.');
      return;
    }
    validateUniqueQuestionId(question.id, `${base}.id`, ids, add);
    if (question.enabled !== undefined && typeof question.enabled !== 'boolean') {
      add(`${base}.enabled`, 'enabled must be true or false.');
    }
    if (!['noul', 'choice', 'score'].includes(question.primitive)) {
      add(`${base}.primitive`, 'The primitive must be noul, choice or score.');
    }
    if (!isText(question.text)) add(`${base}.text`, 'The wording is required.');
    if (!isText(question.usage)) add(`${base}.usage`, 'The usage is required.');
    if (question.requiresProfile !== undefined && typeof question.requiresProfile !== 'boolean') {
      add(`${base}.requiresProfile`, 'requiresProfile must be true or false.');
    }
    if (question.primitive === 'choice') {
      if (!isObject(question.options) || Object.keys(question.options).length < 2) {
        add(`${base}.options`, 'A choice question needs at least two options.');
      } else {
        for (const [key, description] of Object.entries(question.options)) {
          if (!/^[a-z0-9_]+$/.test(key) || !isText(description)) {
            add(`${base}.options.${key}`, 'Each option needs a simple key and a description.');
          }
        }
      }
    }
    if (question.primitive === 'score') validateStringList(question.levels, `${base}.levels`, add, true, 2);
  });
}

function validateUniqueId(value, path, ids, add) {
  if (!isId(value)) {
    add(path, 'The identifier must be kebab-case.');
    return;
  }
  if (ids.has(value)) add(path, `Identifier "${value}" is duplicated.`);
  ids.add(value);
}

function validateUniqueQuestionId(value, path, ids, add) {
  if (typeof value !== 'string' || !/^[a-z][A-Za-z0-9]*$/.test(value)) {
    add(path, 'A JEV identifier must be camelCase.');
    return;
  }
  if (ids.has(value)) add(path, `Identifier "${value}" is duplicated.`);
  ids.add(value);
}

function validateStringList(value, path, add, required, minimum = required ? 1 : 0) {
  if (!Array.isArray(value)) {
    if (required) add(path, 'A list is required.');
    return;
  }
  if (value.length < minimum) add(path, `Add at least ${minimum} value(s).`);
  if (value.some((item) => !isText(item))) add(path, 'Each value must be non-empty text.');
}

function validateInteger(value, path, minimum, maximum, add) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    add(path, `The value must be an integer between ${minimum} and ${maximum}.`);
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
