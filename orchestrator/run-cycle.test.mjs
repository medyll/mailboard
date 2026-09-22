// node --test orchestrator/run-cycle.test.mjs
//
// Le collecteur est simulé (aucun Edge en test) ; l'ingesteur est le vrai,
// isolé dans un répertoire temporaire par MAILBOARD_ROOT.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadCriteria } from '../config/load.mjs';
import { runCycle } from './run-cycle.mjs';

const category = loadCriteria().ids[0];

const channels = [
  { sourceId: 'gmail-primary', accessMode: 'connector', provider: 'gmail', channelKind: 'mailbox' },
  { sourceId: 'proton-up', accessMode: 'browser', provider: 'proton', channelKind: 'mailbox' },
  { sourceId: 'proton-down', accessMode: 'browser', provider: 'proton', channelKind: 'mailbox' },
];

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailboard-cycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inbox = path.join(root, 'data', 'runs-inbox');
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(path.join(root, 'dashboard'), { recursive: true });
  return { root, inbox, archive: path.join(root, 'data', 'runs-archive') };
}

const dropRun = (inbox, sourceId, ids, runAt = '2026-09-22T08:00:00.000Z') =>
  fs.writeFileSync(
    path.join(inbox, `run-${sourceId}-${ids.join('-') || 'vide'}.json`),
    JSON.stringify({
      schemaVersion: 2,
      runAt,
      source: { sourceId, provider: 'fixture', accessMode: 'fixture' },
      collector: { status: 'ok' },
      messages: ids.map((id) => ({ id, subject: `Offre ${id}`, category })),
    }),
  );

/** Collecteur simulé : `behaviour[sourceId]` dit ce que le canal fait. */
const fakeCollector = (inbox, behaviour, calls = []) => async (channel) => {
  calls.push(channel.sourceId);
  const b = behaviour[channel.sourceId];
  if (b === 'crash') return { code: 1, stdout: '', stderr: "Edge a démarré, mais le port CDP 9222 ne répond pas.", timedOut: false };
  if (b === 'timeout') return { code: null, stdout: '', stderr: '', timedOut: true };
  dropRun(inbox, channel.sourceId, b);
  return { code: 0, stdout: '', stderr: '', timedOut: false };
};

const quiet = () => {};

test('cycle complet : un canal en panne n’empêche ni les autres ni l’ingestion', async (t) => {
  const { root, inbox, archive } = setup(t);
  dropRun(inbox, 'gmail-primary', ['g1']); // déposé par l'agent avant l'appel
  const calls = [];

  const result = await runCycle({
    root,
    channels,
    collector: fakeCollector(inbox, { 'proton-up': ['p1', 'p2'], 'proton-down': 'crash' }, calls),
    log: quiet,
  });

  assert.deepEqual(calls, ['proton-up', 'proton-down']);
  assert.equal(result.ok, true);
  assert.equal(result.notify, true);
  assert.equal(result.added, 3);
  assert.deepEqual(result.channels, { 'proton-up': 'ok', 'proton-down': 'error', 'gmail-primary': 'delegated' });
  assert.match(result.message, /3 nouveau\(x\).*proton-down \(error\)/);

  // La panne est tracée par un run d'échec, ingéré comme les autres.
  const runs = fs
    .readFileSync(path.join(root, 'data', 'runs.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const failure = runs.find((r) => r.source.sourceId === 'proton-down');
  assert.equal(failure.collector.status, 'error');
  assert.match(failure.collector.note, /port CDP 9222/);
  assert.equal(fs.readdirSync(archive).length, 3);
  assert.deepEqual(fs.readdirSync(inbox), []);

  const state = JSON.parse(fs.readFileSync(path.join(root, 'data', 'cycle-state.json'), 'utf8'));
  assert.equal(state.ingest.status, 'ok');
  assert.ok(state.finishedAt);
  assert.equal(state.channels['proton-down'].status, 'error');
});

test('--retry-failed ne relance que les canaux en échec au cycle précédent', async (t) => {
  const { root, inbox } = setup(t);
  await runCycle({
    root,
    channels,
    collector: fakeCollector(inbox, { 'proton-up': ['p1'], 'proton-down': 'timeout' }),
    log: quiet,
  });

  const calls = [];
  const result = await runCycle({
    root,
    channels,
    retryFailed: true,
    collector: fakeCollector(inbox, { 'proton-up': ['p1'], 'proton-down': ['d1'] }, calls),
    log: quiet,
  });

  assert.deepEqual(calls, ['proton-down']);
  assert.deepEqual(result.channels, { 'proton-down': 'ok' });
  assert.equal(result.added, 1);
  assert.equal(result.notify, true);
});

test('pas de notification sans nouveau message, run connector manquant signalé', async (t) => {
  const { root, inbox } = setup(t);
  dropRun(inbox, 'proton-up', ['p1']);
  await runCycle({ root, channels, skipCollect: true, log: quiet });

  // Même message revu : doublon, rien à notifier. Gmail n'a rien déposé.
  const result = await runCycle({
    root,
    channels,
    collector: fakeCollector(inbox, { 'proton-up': ['p1'], 'proton-down': [] }),
    log: quiet,
  });
  assert.equal(result.ok, true);
  assert.equal(result.notify, false);
  assert.equal(result.added, 0);
  assert.equal(result.channels['gmail-primary'], 'missing');
});

test('inbox vide : cycle sain, rien à notifier', async (t) => {
  const { root } = setup(t);
  const result = await runCycle({ root, channels, skipCollect: true, log: quiet });
  assert.equal(result.ok, true);
  assert.equal(result.notify, false);
  assert.deepEqual(result.channels, {});
});

test('ingestion en échec : pas de notification, cycle signalé en erreur', async (t) => {
  const { root, inbox } = setup(t);
  dropRun(inbox, 'proton-up', ['p1']);
  const result = await runCycle({
    root,
    channels,
    skipCollect: true,
    ingest: async () => ({ code: 1, stdout: '', stderr: 'criteria.json illisible', timedOut: false }),
    log: quiet,
  });
  assert.equal(result.ok, false);
  assert.equal(result.notify, false);
  assert.match(result.message, /ingestion en échec.*criteria\.json illisible/);
  // Le run attend toujours : le prochain cycle le reprendra.
  assert.equal(fs.readdirSync(inbox).length, 1);
});
