// node --test ingest/jev-labels.test.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { labelQuestions, readLabels, saveLabel, validateLabel } from './jev-labels.mjs';
import { createSettingsServer } from '../settings/server.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailboard-labels-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dashboard'), { recursive: true });
  return root;
}

test('validation : types du contrat, null toujours permis', () => {
  const { questions } = labelQuestions();
  assert.deepEqual(validateLabel({ needsReply: true, eventKind: 'invitation', attention: 3, roleFit: null }, questions), []);
  assert.equal(validateLabel({ needsReply: 'oui' }, questions).length, 1);
  assert.equal(validateLabel({ eventKind: 'inconnu' }, questions).length, 1);
  assert.equal(validateLabel({ attention: 1.5 }, questions).length, 1);
  assert.equal(validateLabel({ inventee: true }, questions).length, 1);
});

test('enregistrement, remplacement et retrait d une étiquette', (t) => {
  const root = tempRoot(t);
  assert.equal(saveLabel(root, { key: 'gmail-primary:a', answers: { needsReply: false } }).count, 1);
  assert.equal(saveLabel(root, { key: 'gmail-primary:a', answers: { needsReply: true } }).count, 1);
  assert.equal(readLabels(root).labels['gmail-primary:a'].answers.needsReply, true);
  assert.equal(saveLabel(root, { key: 'gmail-primary:a', answers: null }).count, 0);
  assert.equal(saveLabel(root, { key: 'sans-canal', answers: {} }).status, 422);
});

test('API /api/labels : jeton exigé, écriture dans data/', async (t) => {
  const root = tempRoot(t);
  const app = await createSettingsServer({ root });
  t.after(() => app.close());
  const url = new URL('api/labels', app.url);

  assert.equal((await fetch(url)).status, 403);
  const headers = { 'Content-Type': 'application/json', 'X-Mailboard-Token': app.token };
  const got = await (await fetch(url, { headers })).json();
  assert.ok(got.questions.some((q) => q.id === 'eventKind'));

  const put = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ key: 'gmail-primary:a', answers: { needsReply: true } }) });
  assert.equal(put.status, 200);
  assert.ok(readLabels(root).labels['gmail-primary:a']);
});

test('rapport d accord : seuil sans faux négatif, confusions comptées', (t) => {
  const root = tempRoot(t);
  const { questionSet } = labelQuestions();
  const msgs = [];
  const labels = {};
  // 6 « oui » humains entre 0,4 et 0,9, 4 « non » dont un à 0,95.
  const probs = [0.4, 0.6, 0.7, 0.8, 0.85, 0.9, 0.1, 0.2, 0.3, 0.95];
  probs.forEach((p, i) => {
    const key = `gmail-primary:m${i}`;
    msgs.push({
      key,
      id: `m${i}`,
      sourceId: 'gmail-primary',
      jev: { status: 'ok', answers: { needsReply: { probability: p }, eventKind: { value: i === 9 ? 'invitation' : 'information', confidence: 0.99 } } },
    });
    labels[key] = { questionSet, answers: { needsReply: i < 6, eventKind: 'information' } };
  });
  fs.writeFileSync(path.join(root, 'data', 'messages.jsonl'), msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'data', 'jev-labels.json'), JSON.stringify({ schemaVersion: 1, labels }));

  const out = execFileSync(process.execPath, [path.join(PROJECT_ROOT, 'ingest', 'jev-agreement.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, MAILBOARD_ROOT: root },
  });
  const report = JSON.parse(out.trim().split('\n').at(-1));
  assert.equal(report.labeled, 10);
  assert.equal(report.questions.needsReply.suggested, 0.4);
  assert.equal(report.questions.needsReply.atSuggested.fn, 0);
  assert.equal(report.questions.needsReply.atSuggested.fp, 1);
  assert.equal(report.questions.eventKind.confidentWrong, 1);
});
