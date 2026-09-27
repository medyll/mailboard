import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Mailboard } from '../../dist/src/index.js';

const logger = { log() {}, warn() {}, error() {} };

test('relecture outillée : lot à l’aveugle, étiquettes à part, accord et calibration', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobmailboard-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const board = new Mailboard({ root, logger });
  board.initialize();

  const jev = (needsReply) => ({
    status: 'ok',
    questionSet: JSON.parse(fs.readFileSync(path.join(root, 'config', 'jev.json'), 'utf8')).questionSet,
    answers: { needsReply: { probability: needsReply } },
  });
  const messages = [
    { key: 'g:old', id: 'old', sourceId: 'g', date: '2026-09-01T00:00:00Z', subject: 'Ancien', from: 'a@example.test', jev: jev(0.9) },
    { key: 'g:new', id: 'new', sourceId: 'g', date: '2026-09-20T00:00:00Z', subject: 'Récent', from: 'b@example.test', jev: jev(0.2) },
    { key: 'g:nobody', id: 'nobody', sourceId: 'g', date: '2026-09-21T00:00:00Z', subject: 'Sans corps', from: 'c@example.test', jev: jev(0.5) },
  ];
  fs.writeFileSync(path.join(root, 'data', 'messages.jsonl'), messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
  fs.writeFileSync(
    path.join(root, 'data', 'bodies.jsonl'),
    [{ key: 'g:old', text: 'Merci de répondre avant vendredi.' }, { key: 'g:new', text: 'Newsletter.' }].map((b) => JSON.stringify(b)).join('\n') + '\n',
  );
  const questionSet = messages[0].jev.questionSet;
  // Une étiquette humaine sur l'ancien : il doit passer en tête de file.
  fs.writeFileSync(
    path.join(root, 'data', 'jev-labels.json'),
    JSON.stringify({ schemaVersion: 1, labels: { 'g:old': { questionSet, answers: { needsReply: true } } } }),
  );

  const queue = board.reviewQueue('claude', 10);
  assert.deepEqual(queue.items.map((i) => i.key), ['g:old', 'g:new'], 'humain d’abord, puis récent ; sans corps exclu');
  assert.ok(!JSON.stringify(queue).includes('probability'), 'aucune réponse JEV dans le lot');
  assert.equal(queue.items[0].body, 'Merci de répondre avant vendredi.');

  const saved = await board.saveReview({
    reviewer: 'claude',
    model: 'test-model',
    labels: [
      { key: 'g:old', answers: { needsReply: true } },
      { key: 'g:new', answers: { needsReply: false } },
      { key: 'g:bad', answers: { needsReply: 'peut-être' } },
    ],
  });
  assert.equal(saved.saved, 2);
  assert.equal(saved.errors.length, 1);

  const human = JSON.parse(fs.readFileSync(path.join(root, 'data', 'jev-labels.json'), 'utf8'));
  assert.deepEqual(Object.keys(human.labels), ['g:old'], 'les étiquettes humaines ne bougent pas');
  const claude = JSON.parse(fs.readFileSync(path.join(root, 'data', 'jev-labels.claude.json'), 'utf8'));
  assert.equal(claude.labels['g:old'].reviewer, 'claude');
  assert.equal(claude.labels['g:old'].model, 'test-model');

  assert.equal(board.reviewQueue('claude', 10).items.length, 0, 'déjà relus : file vide');

  const report = board.agreement('claude');
  assert.equal(report.reference, 'claude');
  assert.equal(report.labeled, 2);
  assert.equal(report.questions.needsReply.at05.tp, 1);
  assert.equal(report.calibration.overlap, 1);
  assert.equal(report.calibration.questions.needsReply.agreement, 1);

  assert.throws(() => board.reviewQueue('human', 5), /page/);
});
