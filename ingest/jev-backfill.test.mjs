// node --test ingest/jev-backfill.test.mjs
//
// Le rattrapage réécrit messages.jsonl : ce qui compte est qu'il ne touche que
// les blocs `jev` des messages choisis, respecte --limit, et n'appelle rien en
// --dry ni pour une décision déjà valide.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(PROJECT_ROOT, 'ingest', 'jev-backfill.mjs');

const readJsonl = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

// Réponse valide pour tout le jeu de questions de config/jev.json.
const answers = {
  needsReply: { noul: 0.1 },
  hasDeadline: { noul: 0.05 },
  eventKind: { choice: 'information', confidence: 0.8, probabilities: { information: 0.8 } },
  attention: { score: 0.4, confidence: 0.7 },
  isOffer: { noul: 0.9 },
  stackMatch: { noul: 0.6 },
  roleFit: { score: 1.5, confidence: 0.6 },
};

function server() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json', 'x-typesafe-request-id': 'req_bf' });
      res.end(JSON.stringify({ model: 'jev-test', answers, usage: { input_tokens: 10, output_tokens: 2 } }));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () =>
      resolve({ seen, url: `http://127.0.0.1:${srv.address().port}/v1/systemone`, close: () => srv.close() }),
    );
  });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailboard-jev-bf-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dashboard'), { recursive: true });

  const base = { sourceId: 'gmail-primary', category: 'emploi', from: 'jobs@example.test', summary: 'Résumé' };
  const rows = [
    { ...base, key: 'gmail-primary:a', id: 'a', date: '2026-09-22T10:00:00Z', subject: 'Sans bloc' },
    { ...base, key: 'gmail-primary:b', id: 'b', date: '2026-09-21T10:00:00Z', subject: 'Skipped', jev: { status: 'skipped', reason: 'skipped:disabled' } },
    { ...base, key: 'gmail-primary:c', id: 'c', date: '2026-09-20T10:00:00Z', subject: 'Déjà évalué', jev: { status: 'ok', questionSet: 'mailboard-v1', answers: {} } },
    { ...base, key: 'proton-perso:d', id: 'd', sourceId: 'proton-perso', date: '2026-09-19T10:00:00Z', subject: 'Autre canal' },
  ];
  fs.writeFileSync(path.join(root, 'data', 'messages.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return root;
}

const env = (root, url) => ({
  ...process.env,
  MAILBOARD_ROOT: root,
  MAILBOARD_JEV_ENDPOINT: url ?? 'http://127.0.0.1:9/never',
  TYPESAFE_API_KEY: 'clé-de-test',
  MAILBOARD_JEV: '0',
});

const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').at(-1));

test('--dry : liste les candidats, aucun appel, aucune écriture', async (t) => {
  const root = fixture(t);
  const before = fs.readFileSync(path.join(root, 'data', 'messages.jsonl'), 'utf8');
  const { stdout } = await run(process.execPath, [SCRIPT, '--dry'], { cwd: PROJECT_ROOT, env: env(root) });

  const result = lastJson(stdout);
  assert.equal(result.type, 'mailboard.jev-backfill.result');
  assert.equal(result.eligible, 3, 'a, b et d ; c a déjà une décision');
  assert.equal(result.called, 0);
  assert.equal(fs.readFileSync(path.join(root, 'data', 'messages.jsonl'), 'utf8'), before);
});

test('évalue les plus récents dans la limite, même si la config dit enabled: false', async (t) => {
  const root = fixture(t);
  const s = await server();
  const { stdout } = await run(process.execPath, [SCRIPT, '--limit', '1', '--source', 'gmail-primary'], {
    cwd: PROJECT_ROOT,
    env: env(root, s.url),
  });
  s.close();

  const result = lastJson(stdout);
  assert.equal(s.seen.length, 1);
  assert.equal(result.ok, 1);
  assert.equal(result.remaining, 1, 'b reste à faire');

  const rows = readJsonl(path.join(root, 'data', 'messages.jsonl'));
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId.a.jev.status, 'ok');
  assert.equal(byId.a.jev.requestId, 'req_bf');
  assert.equal(byId.b.jev.status, 'skipped', 'hors limite : inchangé');
  assert.deepEqual(byId.c.jev, { status: 'ok', questionSet: 'mailboard-v1', answers: {} });
  assert.ok(!byId.d.jev, 'autre canal : inchangé');
  assert.equal(byId.a.subject, 'Sans bloc', 'seul le bloc jev change');

  // Aucun identifiant ne part chez le fournisseur.
  assert.ok(!JSON.stringify(s.seen[0]).includes('gmail-primary:a'));
  // Le dashboard est régénéré.
  assert.ok(fs.existsSync(path.join(root, 'dashboard', 'data.js')));
  const log = readJsonl(path.join(root, 'data', 'jev-runs.jsonl'));
  assert.equal(log[0].backfill, true);
});

test('sans clé : aucun appel, sortie non nulle, fichier intact', async (t) => {
  const root = fixture(t);
  const before = fs.readFileSync(path.join(root, 'data', 'messages.jsonl'), 'utf8');
  const e = { ...env(root), TYPESAFE_API_KEY: '' };
  delete e.TYPESAFE_API_KEY;
  await assert.rejects(run(process.execPath, [SCRIPT], { cwd: PROJECT_ROOT, env: e }), (err) => {
    assert.equal(lastJson(err.stdout).status, 'skipped:no-key');
    return true;
  });
  assert.equal(fs.readFileSync(path.join(root, 'data', 'messages.jsonl'), 'utf8'), before);
});
