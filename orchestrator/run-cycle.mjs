#!/usr/bin/env node
// Cycle complet : collecter chaque canal browser, constater, ingérer une fois,
// décider de la notification. Aucun collecteur n'appelle l'ingesteur ; c'est
// ici que la chaîne est tenue (AGENTS.md, « Cycle d'orchestration »).
//
// Les canaux `connector` (Gmail) sont collectés par l'agent de la tâche
// planifiée avant l'appel : le cycle vérifie seulement que leur run est bien
// arrivé dans data/runs-inbox/.
//
// Usage :
//   node orchestrator/run-cycle.mjs                 cycle complet
//   node orchestrator/run-cycle.mjs --retry-failed  relance les canaux en échec au cycle précédent
//   node orchestrator/run-cycle.mjs --skip-collect  ingère seulement ce qui attend dans l'inbox
//
// Dernière ligne de sortie : un objet `mailboard.cycle.result`. Notifier
// seulement si `notify` vaut true.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChannels } from '../config/load.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COLLECTOR_DIR = path.join(PROJECT_ROOT, 'collectors', 'browser-mail');
const INGEST = path.join(PROJECT_ROOT, 'ingest', 'ingest.mjs');

// Une boîte bloquée sur un écran de connexion ne doit pas geler le cycle.
const CHANNEL_TIMEOUT_MS = Number(process.env.MAILBOARD_CHANNEL_TIMEOUT_MS ?? 0) || 5 * 60_000;

const stamp = (d) =>
  d.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

const tail = (text, lines = 3) => text.trim().split('\n').slice(-lines).join(' | ').slice(0, 500);

/** Lance une commande et rend { code, stdout, stderr, timedOut }, sans jamais rejeter. */
export function run(command, args, { cwd = PROJECT_ROOT, env = process.env, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(command, args, { cwd, env, windowsHide: true });
    } catch (err) {
      resolve({ code: null, stdout, stderr: err.message, timedOut });
      return;
    }
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs)
      : null;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => (stderr += err.message));
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * Collecteur browser par défaut. Sous Windows, run.ps1 prépare Edge et son port
 * CDP ; ailleurs, le collecteur Node est appelé directement.
 */
export function defaultCollector(channel) {
  const [command, args] =
    process.platform === 'win32'
      ? [
          process.env.MAILBOARD_PWSH ?? 'pwsh',
          ['-NoProfile', '-File', path.join(COLLECTOR_DIR, 'run.ps1'), '--source', channel.sourceId],
        ]
      : [process.execPath, [path.join(COLLECTOR_DIR, 'collect.mjs'), '--source', channel.sourceId]];
  return run(command, args, { timeoutMs: CHANNEL_TIMEOUT_MS });
}

export function defaultIngest(root) {
  return run(process.execPath, [INGEST, '--json'], {
    env: { ...process.env, MAILBOARD_ROOT: root },
  });
}

/** Runs présents dans l'inbox, indexés par nom de fichier → sourceId annoncé. */
function inboxRuns(inbox) {
  if (!fs.existsSync(inbox)) return new Map();
  const runs = new Map();
  for (const file of fs.readdirSync(inbox).filter((f) => f.endsWith('.json'))) {
    try {
      const content = JSON.parse(fs.readFileSync(path.join(inbox, file), 'utf8'));
      runs.set(file, { sourceId: content.source?.sourceId ?? 'gmail-legacy', status: content.collector?.status ?? 'ok' });
    } catch {
      runs.set(file, { sourceId: null, status: 'error' });
    }
  }
  return runs;
}

/**
 * Un canal qui n'a laissé aucun run (Edge introuvable, port CDP muet, délai
 * dépassé) reçoit un run d'échec : sans lui, le dashboard croirait la boîte
 * simplement silencieuse.
 */
function writeFailureRun(inbox, channel, { status, note, now }) {
  const runAt = now.toISOString();
  const file = `run-${stamp(now)}--${channel.sourceId}.json`;
  const content = {
    schemaVersion: 2,
    runAt,
    windowHours: channel.collection?.windowHours ?? null,
    source: {
      sourceId: channel.sourceId,
      channelKind: channel.channelKind,
      accessMode: channel.accessMode,
      provider: channel.provider,
    },
    collector: { name: 'orchestrator', status, note },
    coverage: { complete: false, itemsInspected: 0 },
    messages: [],
  };
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, file), `${JSON.stringify(content, null, 2)}\n`);
  return file;
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Exécute un cycle. Toutes les dépendances sont injectables : les tests
 * remplacent le collecteur, jamais l'ingesteur.
 */
export async function runCycle({
  root = process.env.MAILBOARD_ROOT ? path.resolve(process.env.MAILBOARD_ROOT) : PROJECT_ROOT,
  channels = loadChannels().channels,
  collector = defaultCollector,
  ingest = defaultIngest,
  retryFailed = false,
  skipCollect = false,
  now = () => new Date(),
  log = console.log,
} = {}) {
  const inbox = path.join(root, 'data', 'runs-inbox');
  const stateFile = path.join(root, 'data', 'cycle-state.json');
  const previous = readState(stateFile);

  const state = {
    startedAt: now().toISOString(),
    finishedAt: null,
    mode: skipCollect ? 'skip-collect' : retryFailed ? 'retry-failed' : 'full',
    channels: {},
    ingest: { status: 'pending' },
    notify: false,
  };
  writeState(stateFile, state);

  // Préparer : quels canaux ce cycle doit-il tenter ?
  let browserChannels = channels.filter((c) => c.accessMode === 'browser');
  if (retryFailed) {
    const failed = new Set(
      Object.entries(previous?.channels ?? {})
        .filter(([, c]) => c.status !== 'ok' && c.status !== 'delegated')
        .map(([id]) => id),
    );
    browserChannels = browserChannels.filter((c) => failed.has(c.sourceId));
    log(failed.size ? `Reprise : ${[...failed].join(', ')}` : 'Reprise : aucun canal en échec au cycle précédent.');
  }
  if (skipCollect) browserChannels = [];

  // Collecter en série : les canaux browser partagent le profil Edge et son port CDP.
  for (const channel of browserChannels) {
    const before = new Set(inboxRuns(inbox).keys());
    state.channels[channel.sourceId] = { status: 'running', startedAt: now().toISOString() };
    writeState(stateFile, state);

    const result = await collector(channel);
    const produced = [...inboxRuns(inbox)].filter(([file, r]) => !before.has(file) && r.sourceId === channel.sourceId);

    let entry;
    if (produced.length) {
      const [file, r] = produced.at(-1);
      entry = { status: r.status, runFile: file };
    } else {
      const status = result.timedOut ? 'unavailable' : 'error';
      const note = result.timedOut
        ? `délai de ${Math.round(CHANNEL_TIMEOUT_MS / 1000)} s dépassé`
        : tail(result.stderr || result.stdout) || `sortie ${result.code} sans run`;
      entry = { status, runFile: writeFailureRun(inbox, channel, { status, note, now: now() }), note };
    }
    state.channels[channel.sourceId] = { ...state.channels[channel.sourceId], ...entry, finishedAt: now().toISOString() };
    writeState(stateFile, state);
    log(`  ${entry.status === 'ok' ? '+' : '!'} ${channel.sourceId} : ${entry.status}${entry.note ? ` — ${entry.note}` : ''}`);
  }

  // Constater : les canaux connector sont collectés par l'agent avant l'appel.
  if (!retryFailed && !skipCollect) {
    const waiting = [...inboxRuns(inbox).values()];
    for (const channel of channels.filter((c) => c.accessMode === 'connector')) {
      const present = waiting.some((r) => r.sourceId === channel.sourceId);
      state.channels[channel.sourceId] = { status: present ? 'delegated' : 'missing' };
      if (!present) log(`  ! ${channel.sourceId} : aucun run dans l'inbox (collecte déléguée à l'agent)`);
    }
  }

  // Ingérer une seule fois, après toutes les tentatives.
  const ingestion = await ingest(root);
  const resultLine = ingestion.stdout
    .trim()
    .split('\n')
    .reverse()
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((obj) => obj?.type === 'mailboard.ingest.result');

  if (ingestion.code === 0) {
    // Inbox vide : l'ingesteur ne produit pas de résultat, rien de nouveau.
    const r = resultLine ?? { type: 'mailboard.ingest.result', runs: 0, added: 0, dupes: 0, bodiesAdded: 0, sources: [] };
    state.ingest = { status: 'ok', result: r };
    // Notifier depuis le résultat canonique, jamais depuis le nombre collecté.
    state.notify = r.added > 0;
  } else {
    state.ingest = { status: 'error', note: tail(ingestion.stderr || ingestion.stdout) };
  }

  state.finishedAt = now().toISOString();
  writeState(stateFile, state);

  const failed = Object.entries(state.channels).filter(([, c]) => !['ok', 'delegated'].includes(c.status));
  const added = state.ingest.result?.added ?? 0;
  const message =
    state.ingest.status !== 'ok'
      ? `Mailboard : ingestion en échec (${state.ingest.note})`
      : `Mailboard : ${added} nouveau(x) message(s)` +
        (failed.length ? ` — canal en échec : ${failed.map(([id, c]) => `${id} (${c.status})`).join(', ')}` : '');

  return {
    type: 'mailboard.cycle.result',
    ok: state.ingest.status === 'ok',
    notify: state.notify,
    added,
    message,
    channels: Object.fromEntries(Object.entries(state.channels).map(([id, c]) => [id, c.status])),
    ingest: state.ingest.result ?? null,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = new Set(process.argv.slice(2));
  const result = await runCycle({ retryFailed: argv.has('--retry-failed'), skipCollect: argv.has('--skip-collect') });
  console.log(result.message);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
