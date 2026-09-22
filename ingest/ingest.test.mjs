// node --test ingest/ingest.test.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadCriteria } from '../config/load.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INGEST = path.join(PROJECT_ROOT, 'ingest', 'ingest.mjs');

const readJsonl = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const readProjection = (file, property) => {
  const sandbox = {
    window: { dispatchEvent() {} },
    Event: class Event {},
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox);
  return sandbox.window[property];
};

test('ingère des runs v1 et v2 sans confondre les identifiants de deux sources', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailboard-ingest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const inbox = path.join(root, 'data', 'runs-inbox');
  const archive = path.join(root, 'data', 'runs-archive');
  const dashboard = path.join(root, 'dashboard');
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(dashboard, { recursive: true });

  const category = loadCriteria().ids[0];
  const shared = {
    id: 'shared-id',
    date: '2026-09-22T08:00:00.000Z',
    from: 'jobs@example.test',
    subject: 'Identifiant partagé',
    summary: 'Même identifiant externe, sources distinctes',
    category,
  };

  fs.writeFileSync(
    path.join(inbox, 'legacy-run.json'),
    JSON.stringify({
      runAt: '2026-09-22T08:05:00.000Z',
      queries: { [category]: 'fixture-v1' },
      messages: [{ ...shared, body: 'Corps du canal historique' }],
    }),
  );

  fs.writeFileSync(
    path.join(inbox, 'primary-run.json'),
    JSON.stringify({
      schemaVersion: 2,
      runAt: '2026-09-22T08:10:00.000Z',
      source: { sourceId: 'gmail-primary', provider: 'gmail', accessMode: 'connector' },
      collector: { status: 'ok', mode: 'fixture' },
      messages: [
        { ...shared, body: '<p>Corps &amp; principal</p>' },
        { ...shared, id: 'same-channel', subject: 'Premier passage', body: 'Premier corps' },
        { ...shared, id: 'same-channel', subject: 'Doublon du même canal', body: 'Corps ignoré' },
      ],
    }),
  );

  const output = execFileSync(process.execPath, [INGEST, '--json'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: { ...process.env, MAILBOARD_ROOT: root },
  });

  assert.match(output, /2 run\(s\) ingéré\(s\).*3 nouveau\(x\).*1 doublon\(s\)/s);
  const result = JSON.parse(output.trim().split('\n').at(-1));
  assert.deepEqual(result, {
    type: 'mailboard.ingest.result',
    runs: 2,
    added: 3,
    dupes: 1,
    bodiesAdded: 3,
    sources: [
      { sourceId: 'gmail-legacy', status: 'ok' },
      { sourceId: 'gmail-primary', status: 'ok' },
    ],
  });

  const messages = readJsonl(path.join(root, 'data', 'messages.jsonl'));
  const runs = readJsonl(path.join(root, 'data', 'runs.jsonl'));
  const bodies = readJsonl(path.join(root, 'data', 'bodies.jsonl'));

  assert.deepEqual(
    messages.map((message) => message.key).sort(),
    ['gmail-legacy:shared-id', 'gmail-primary:same-channel', 'gmail-primary:shared-id'],
  );
  assert.equal(messages.find((message) => message.key === 'gmail-primary:same-channel').seenCount, 2);
  assert.equal(runs.length, 2);
  assert.equal(bodies.length, 3);
  assert.equal(bodies.find((body) => body.key === 'gmail-primary:shared-id').text, 'Corps & principal');
  assert.deepEqual(fs.readdirSync(archive).sort(), ['legacy-run.json', 'primary-run.json']);
  assert.deepEqual(fs.readdirSync(inbox), []);

  const dataProjection = readProjection(path.join(dashboard, 'data.js'), 'MAILBOARD');
  const bodyProjection = readProjection(path.join(dashboard, 'bodies.js'), 'MAILBOARD_BODIES');
  assert.equal(dataProjection.messages.length, 3);
  assert.equal(dataProjection.runs.length, 2);
  assert.equal(Object.keys(bodyProjection).length, 3);
  assert.equal(bodyProjection['gmail-primary:shared-id'].text, 'Corps & principal');
});
