import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Mailboard, userWorkspace } from '../../dist/src/index.js';

const logger = { log() {}, warn() {}, error() {} };
test('ingestion partagée : ids par source, corps immuable, doublons et notification', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobmailboard-core-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const board = new Mailboard({ root, logger });
  board.initialize();
  const writeRun = (file, sourceId, body) => fs.writeFileSync(path.join(root, 'data', 'runs-inbox', file), JSON.stringify({
    schemaVersion: 2, runId: file, runAt: '2026-09-27T10:00:00Z',
    source: { sourceId, provider: 'gmail', accessMode: 'connector' },
    messages: [{ id: 'same', subject: 'Offre emploi', date: '2026-09-27T09:00:00Z', from: 'jobs@example.test', category: 'emploi', body }],
  }));
  writeRun('a.json', 'a', 'Premier corps unique');
  writeRun('b.json', 'b', 'Autre corps');
  const first = await board.cycle({ skipCollect: true });
  assert.equal(first.added, 2);
  assert.equal(first.notify, true);
  assert.equal(board.getMessage('a', 'same').body, 'Premier corps unique');
  assert.equal(board.listMessages({ query: 'unique' }).length, 1);
  writeRun('duplicate.json', 'a', 'Corps remplacé interdit');
  const duplicate = await board.cycle({ skipCollect: true });
  assert.equal(duplicate.added, 0);
  assert.equal(duplicate.notify, false);
  assert.equal(board.getMessage('a', 'same').body, 'Premier corps unique');
  assert.equal(board.missingBodies('a').missing, 0);
  assert.equal(board.queries('gmail', 24).emploi.includes('newer_than:24h'), true);
  assert.equal(board.readSettings().jev.enabled, false);
});
test('chemins utilisateur pour les trois OS et refus du répertoire npm', () => {
  assert.ok(userWorkspace('win32', { LOCALAPPDATA: 'local' }, 'home').endsWith(path.join('local', 'jobmailboard')));
  assert.equal(userWorkspace('linux', { XDG_DATA_HOME: '/data' }, '/home'), path.join('/data', 'jobmailboard'));
  assert.equal(userWorkspace('darwin', {}, '/home'), path.join('/home', 'Library', 'Application Support', 'jobmailboard'));
  assert.throws(() => new Mailboard({ root: path.resolve('.') }), /extérieur/);
});
test('initialisation préserve les critères existants et les données', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobmailboard-init-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const board = new Mailboard({ root, logger });
  board.initialize();
  const file = path.join(root, 'config', 'preferences.json');
  fs.writeFileSync(file, '{"preferences":[]}');
  board.initialize();
  assert.equal(fs.readFileSync(file, 'utf8'), '{"preferences":[]}');
});
test('--dry sur un espace neuf ne crée aucun fichier', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'jobmailboard-dry-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'not-created');
  const board = new Mailboard({ root, logger });
  assert.equal((await board.ingest({ dry: true })).added, 0);
  assert.equal((await board.backfill({ dry: true })).called, 0);
  assert.equal(fs.existsSync(root), false);
});
test('serveur distribué : dashboard, réglages sauvegardés et projection reconstruite', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobmailboard-serve-'));
  const board = new Mailboard({ root, logger });
  const app = await board.serve(0);
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal((await fetch(app.url)).status, 200);
  const headers = { 'Content-Type': 'application/json', 'X-Mailboard-Token': app.token };
  const settings = board.readSettings();
  settings.preferences.preferences = [{ id: 'remote', label: 'Remote', kind: 'pro', strength: 'mild', match: { keywords: ['remote'] } }];
  const saved = await fetch(new URL('/api/settings', app.url), { method: 'PUT', headers, body: JSON.stringify(settings) });
  assert.equal(saved.status, 200);
  assert.equal(board.readSettings().preferences.preferences[0].id, 'remote');
  assert.match(fs.readFileSync(path.join(root, 'dashboard', 'data.js'), 'utf8'), /Remote/);
  assert.equal(board.agreement().labeled, 0);
});
test('collecteur distribué : validation et échec sans navigateur sur un canal inconnu', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobmailboard-collect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const board = new Mailboard({ root, logger });
  assert.throws(() => board.collect({}), /sourceId/);
  const result = await board.collect({ sourceId: 'absent' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.deepEqual(fs.readdirSync(path.join(root, 'data', 'runs-inbox')), []);
});
