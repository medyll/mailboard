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
    env: { ...process.env, MAILBOARD_ROOT: root, MAILBOARD_JEV: '0' },
  });

  assert.match(output, /2 run\(s\) ingéré\(s\).*3 nouveau\(x\).*1 doublon\(s\)/s);
  const result = JSON.parse(output.trim().split('\n').at(-1));
  assert.deepEqual(result, {
    type: 'mailboard.ingest.result',
    runs: 2,
    added: 3,
    dupes: 1,
    bodiesAdded: 3,
    bodyCoverage: { withBody: 3, total: 3 },
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

test('reprend un historique existant : corps tardif, run rejoué, run illisible, --dry', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailboard-ingest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const inbox = path.join(root, 'data', 'runs-inbox');
  const archive = path.join(root, 'data', 'runs-archive');
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(path.join(root, 'dashboard'), { recursive: true });

  const category = loadCriteria().ids[0];
  const source = { sourceId: 'proton-main', provider: 'proton', accessMode: 'browser' };
  const message = {
    id: 'm-1',
    date: '2026-09-22T09:00:00.000Z',
    from: 'rh@example.test',
    subject: 'Offre sans corps',
    category,
  };
  const writeRun = (name, run) => fs.writeFileSync(path.join(inbox, name), JSON.stringify(run));
  const ingest = (...args) =>
    execFileSync(process.execPath, [INGEST, '--json', ...args], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: { ...process.env, MAILBOARD_ROOT: root, MAILBOARD_JEV: '0' },
    });
  const lastResult = (output) => JSON.parse(output.trim().split('\n').at(-1));

  // Premier passage : liste sans corps, comme le canal Proton list-only.
  writeRun('run-1.json', {
    schemaVersion: 2,
    runAt: '2026-09-22T09:05:00.000Z',
    source,
    collector: { status: 'ok', mode: 'fixture' },
    messages: [message, { subject: 'Sans identifiant' }],
  });
  assert.equal(lastResult(ingest()).added, 1);
  let messages = readJsonl(path.join(root, 'data', 'messages.jsonl'));
  assert.equal(messages[0].hasBody, false);

  // --dry : le run reste dans l'inbox, aucune donnée ne bouge.
  writeRun('run-2.json', {
    schemaVersion: 2,
    runAt: '2026-09-22T10:05:00.000Z',
    source,
    collector: { status: 'ok', mode: 'fixture' },
    messages: [{ ...message, body: 'Corps arrivé plus tard' }],
  });
  const snapshot = fs.readFileSync(path.join(root, 'data', 'messages.jsonl'), 'utf8');
  ingest('--dry');
  assert.equal(fs.readFileSync(path.join(root, 'data', 'messages.jsonl'), 'utf8'), snapshot);
  assert.ok(fs.existsSync(path.join(inbox, 'run-2.json')));
  assert.equal(fs.existsSync(path.join(root, 'data', 'bodies.jsonl')), false);

  // Second passage réel : le corps tardif complète le message existant, un run
  // illisible reste dans l'inbox, un run déjà connu est seulement archivé.
  fs.writeFileSync(path.join(inbox, 'broken.json'), '{ pas du json');
  fs.copyFileSync(path.join(archive, 'run-1.json'), path.join(inbox, 'run-1.json'));

  const result = lastResult(ingest());
  assert.deepEqual(
    { runs: result.runs, added: result.added, dupes: result.dupes, bodiesAdded: result.bodiesAdded },
    { runs: 1, added: 0, dupes: 1, bodiesAdded: 1 },
  );

  messages = readJsonl(path.join(root, 'data', 'messages.jsonl'));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].hasBody, true);
  assert.equal(messages[0].seenCount, 2);
  assert.equal(messages[0].lastSeenAt, '2026-09-22T10:05:00.000Z');
  assert.equal(readJsonl(path.join(root, 'data', 'runs.jsonl')).length, 2);
  assert.deepEqual(fs.readdirSync(inbox), ['broken.json']);
  assert.deepEqual(fs.readdirSync(archive).sort(), ['run-1.json', 'run-2.json']);

  const bodyProjection = readProjection(path.join(root, 'dashboard', 'bodies.js'), 'MAILBOARD_BODIES');
  assert.equal(bodyProjection['proton-main:m-1'].text, 'Corps arrivé plus tard');
});

test('rattrapage : corps ajoutés sans réapparition ni run de couverture', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailboard-ingest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const inbox = path.join(root, 'data', 'runs-inbox');
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(path.join(root, 'dashboard'), { recursive: true });

  const env = { ...process.env, MAILBOARD_ROOT: root, MAILBOARD_JEV: '0' };
  const ingest = () =>
    JSON.parse(execFileSync(process.execPath, [INGEST, '--json'], { cwd: PROJECT_ROOT, encoding: 'utf8', env }).trim().split('\n').at(-1));
  const missing = () =>
    JSON.parse(
      execFileSync(process.execPath, [path.join(PROJECT_ROOT, 'ingest', 'missing-bodies.mjs'), '--source', 'gmail-primary', '--limit', '1'], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        env,
      }),
    );

  const category = loadCriteria().ids[0];
  const source = { sourceId: 'gmail-primary', provider: 'gmail', accessMode: 'connector' };
  fs.writeFileSync(
    path.join(inbox, 'run-1.json'),
    JSON.stringify({
      schemaVersion: 2,
      runAt: '2026-09-22T08:00:00.000Z',
      source,
      messages: [
        { id: 'old', date: '2026-09-21T08:00:00.000Z', subject: 'Ancien', category },
        { id: 'new', date: '2026-09-22T07:00:00.000Z', subject: 'Récent', category },
      ],
    }),
  );
  assert.deepEqual(ingest().bodyCoverage, { withBody: 0, total: 2 });

  // Le plus récent d'abord, borné par --limit.
  const before = missing();
  assert.equal(before.missing, 2);
  assert.deepEqual(before.items.map((i) => i.id), ['new']);

  fs.writeFileSync(
    path.join(inbox, 'backfill-1.json'),
    JSON.stringify({
      schemaVersion: 2,
      kind: 'backfill',
      runAt: '2026-09-22T12:00:00.000Z',
      source,
      messages: [
        { id: 'new', body: 'Corps rattrapé' },
        { id: 'inconnu', body: 'Jamais vu, ignoré' },
      ],
    }),
  );
  const result = ingest();
  assert.equal(result.bodiesAdded, 1);
  assert.equal(result.dupes, 0);
  assert.equal(result.runs, 0);
  assert.deepEqual(result.bodyCoverage, { withBody: 1, total: 2 });

  const messages = readJsonl(path.join(root, 'data', 'messages.jsonl'));
  const recent = messages.find((m) => m.id === 'new');
  assert.equal(recent.hasBody, true);
  assert.equal(recent.seenCount, 1);
  assert.equal(recent.lastSeenAt, '2026-09-22T08:00:00.000Z');
  assert.equal(messages.length, 2);
  assert.equal(readJsonl(path.join(root, 'data', 'runs.jsonl')).length, 1);
  assert.deepEqual(fs.readdirSync(inbox), []);
  assert.deepEqual(missing().items.map((i) => i.id), ['old']);
});
