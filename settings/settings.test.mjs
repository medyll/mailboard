import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareSettings, readSettings, validateSettings } from './config.mjs';
import { createSettingsServer, saveSettings } from './server.mjs';

const fixture = () => ({
  criteria: {
    schemaVersion: 1,
    updatedAt: '2026-01-01',
    defaults: { windowHours: 12, fallbackCategory: 'autre' },
    criteria: [{
      id: 'emploi', label: 'Emploi', enabled: true, profileMatch: true,
      queries: { gmail: 'newer_than:{windowHours}h emploi', proton: 'emploi', keywords: ['emploi'], fromDomains: [] },
    }],
    aliases: {},
    fallback: { id: 'autre', label: 'Autre' },
  },
  preferences: {
    schemaVersion: 1,
    updatedAt: '2026-01-01',
    weights: { blocker: 4, strong: 2, mild: 1 },
    preferences: [{ id: 'remote', kind: 'pro', strength: 'mild', label: 'Remote', match: { keywords: ['remote'] } }],
  },
  jev: {
    schemaVersion: 1,
    enabled: false,
    questionSet: 'mailboard-test',
    endpoint: 'https://example.test/v1/systemone',
    model: 'jev-test',
    timeoutMs: 8000,
    concurrency: 2,
    retriesPerRun: 0,
    profile: { send: true, file: 'profile/profile.jev.md', maxChars: 4000 },
    questions: [{ id: 'needsReply', enabled: true, primitive: 'noul', text: 'Faut-il répondre ?', usage: 'badge' }],
    thresholds: {},
  },
});

const makeRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailboard-settings-'));
  fs.mkdirSync(path.join(root, 'config'));
  fs.mkdirSync(path.join(root, 'dashboard'));
  fs.writeFileSync(path.join(root, 'dashboard', 'index.html'), '<!doctype html><title>Mailboard test</title>');
  for (const [name, value] of Object.entries(fixture())) {
    fs.writeFileSync(path.join(root, 'config', `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  }
  return root;
};

test('la configuration actuelle du projet respecte le contrat de l’éditeur', () => {
  const root = path.resolve(import.meta.dirname, '..');
  assert.deepEqual(validateSettings(readSettings(root)), []);
});

test('prépare les dates sans muter le formulaire', () => {
  const settings = fixture();
  const prepared = prepareSettings(settings, new Date('2026-09-22T10:00:00Z'));
  assert.equal(prepared.criteria.updatedAt, '2026-09-22');
  assert.equal(prepared.preferences.updatedAt, '2026-09-22');
  assert.equal(settings.criteria.updatedAt, '2026-01-01');
});

test('refuse les doublons et les objets JEV incomplets', () => {
  const settings = fixture();
  settings.criteria.criteria.push(structuredClone(settings.criteria.criteria[0]));
  settings.jev.questions[0] = { id: 'choiceOne', primitive: 'choice', text: '', usage: '', options: { only: 'Une option' } };
  const paths = validateSettings(settings).map((error) => error.path);
  assert.ok(paths.includes('criteria.criteria.1.id'));
  assert.ok(paths.includes('jev.questions.0.text'));
  assert.ok(paths.includes('jev.questions.0.options'));
});

test('une question JEV désactivée reste dans le fichier mais ne part pas au modèle', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings = fixture();
  settings.jev.questions.push({ id: 'hiddenQuestion', enabled: false, primitive: 'noul', text: 'Question masquée ?', usage: 'aucun' });
  fs.writeFileSync(path.join(root, 'config', 'jev.json'), `${JSON.stringify(settings.jev, null, 2)}\n`);

  const previous = process.env.MAILBOARD_CONFIG_DIR;
  process.env.MAILBOARD_CONFIG_DIR = path.join(root, 'config');
  try {
    const { loadJev } = await import(`../config/load.mjs?settings-test=${Date.now()}`);
    assert.deepEqual(loadJev({ dry: true }).questions.map((question) => question.id), ['needsReply']);
  } finally {
    if (previous === undefined) delete process.env.MAILBOARD_CONFIG_DIR;
    else process.env.MAILBOARD_CONFIG_DIR = previous;
  }
});

test('écrit les trois fichiers puis lance le rebuild', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let rebuilt = 0;
  const settings = fixture();
  settings.criteria.defaults.windowHours = 24;
  const result = await saveSettings(root, settings, async () => {
    rebuilt += 1;
    return 'dashboard reconstruit';
  });
  assert.equal(result.ok, true);
  assert.equal(rebuilt, 1);
  assert.equal(readSettings(root).criteria.defaults.windowHours, 24);
});

test('restaure les fichiers si le rebuild échoue', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = fs.readFileSync(path.join(root, 'config', 'criteria.json'), 'utf8');
  const settings = fixture();
  settings.criteria.defaults.windowHours = 48;
  const result = await saveSettings(root, settings, async () => {
    throw new Error('rebuild cassé');
  });
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(path.join(root, 'config', 'criteria.json'), 'utf8'), before);
});

test('le serveur protège l’API et sert le runtime éphémère', async (t) => {
  const root = makeRoot();
  const app = await createSettingsServer({ root, rebuild: async () => 'ok' });
  t.after(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const runtime = await fetch(new URL('settings-runtime.js', app.url)).then((response) => response.text());
  assert.match(runtime, /enabled: true/);
  assert.match(runtime, new RegExp(app.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const forbidden = await fetch(new URL('api/settings', app.url));
  assert.equal(forbidden.status, 403);

  const allowed = await fetch(new URL('api/settings', app.url), { headers: { 'X-Mailboard-Token': app.token } });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).settings.criteria.defaults.windowHours, 12);

  const invalid = fixture();
  invalid.jev.concurrency = 0;
  const validation = await fetch(new URL('api/settings/validate', app.url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Mailboard-Token': app.token },
    body: JSON.stringify(invalid),
  });
  assert.equal(validation.status, 422);
});
