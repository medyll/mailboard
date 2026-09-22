// node --test dashboard/labeling-component/labeling-component.test.mjs
//
// Parcours réel : serveur local, page d'étiquetage dans Edge sans interface,
// un appui sur Entrée, l'étiquette atterrit dans data/jev-labels.json et la
// réponse de JEV n'apparaît qu'après coup.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { withOwnedTab } from '../../collectors/browser-mail/edge.mjs';
import { createSettingsServer } from '../../settings/server.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const edgePath = () =>
  [
    process.env.MAILBOARD_EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((candidate) => candidate && fs.existsSync(candidate));

const freePort = async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
};

const waitInPage = (expression) =>
  `(async () => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (${expression}) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  })()`;

test('étiquetage à l aveugle : Entrée enregistre, JEV révélé après coup', async (t) => {
  const executable = edgePath();
  if (!executable) {
    t.skip('Microsoft Edge absent ; définir MAILBOARD_EDGE_PATH pour exécuter ce test');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailboard-labeling-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mailboard-edge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dashboard = path.join(root, 'dashboard');
  fs.mkdirSync(path.join(dashboard, 'labeling-component'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'));
  fs.copyFileSync(path.join(PROJECT_ROOT, 'dashboard', 'style.css'), path.join(dashboard, 'style.css'));
  for (const file of ['labeling-component.html', 'labeling-component.css', 'labeling-component.js']) {
    fs.copyFileSync(path.join(PROJECT_ROOT, 'dashboard', 'labeling-component', file), path.join(dashboard, 'labeling-component', file));
  }

  const jev = (eventKind) => ({
    status: 'ok',
    answers: { needsReply: { probability: 0.9 }, eventKind: { value: eventKind, confidence: 0.99 }, attention: { value: 2 } },
  });
  const messages = [
    { key: 'gmail-primary:info', sourceId: 'gmail-primary', category: 'emploi', date: '2026-09-22', from: 'a@example.test', subject: 'Alerte banale', jev: jev('information') },
    { key: 'gmail-primary:rdv', sourceId: 'gmail-primary', category: 'emploi', date: '2026-09-21', from: 'b@example.test', subject: 'Rendez-vous proposé', jev: jev('invitation') },
  ];
  fs.writeFileSync(path.join(dashboard, 'data.js'), `window.MAILBOARD = ${JSON.stringify({ messages })};\n`);
  fs.writeFileSync(path.join(dashboard, 'bodies.js'), 'window.MAILBOARD_BODIES = {};\n');

  const app = await createSettingsServer({ root });
  t.after(() => app.close());

  const port = await freePort();
  const edge = spawn(
    executable,
    ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'],
    { stdio: 'ignore' },
  );
  t.after(async () => {
    if (edge.exitCode === null) {
      edge.kill();
      await Promise.race([once(edge, 'exit'), delay(5000)]);
    }
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error;
    }
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
    } catch {
      await delay(100);
    }
  }

  const origin = new URL(app.url).origin;
  await withOwnedTab({ port, family: 'edge', allowedOrigins: [origin] }, async (tab) => {
    await tab.navigate(`${origin}/labeling-component/labeling-component.html`);

    // Le cas rare passe en premier ; la réponse de JEV n'est pas affichée.
    assert.equal(await tab.eval(waitInPage(`document.querySelector('#subject')?.textContent === 'Rendez-vous proposé'`)), true);
    assert.equal(await tab.eval(`document.body.innerText.includes('0.99')`), false);

    await tab.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))`);
    assert.equal(await tab.eval(waitInPage(`document.querySelector('#subject')?.textContent === 'Alerte banale'`)), true);
    assert.equal(await tab.eval(`!document.querySelector('#reveal').hidden && document.querySelector('#reveal').textContent.includes('invitation')`), true);
  });

  const saved = JSON.parse(fs.readFileSync(path.join(root, 'data', 'jev-labels.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.labels), ['gmail-primary:rdv']);
  assert.equal(saved.labels['gmail-primary:rdv'].answers.eventKind, 'information', 'valeur neutre par défaut, pas celle de JEV');
  assert.equal(saved.labels['gmail-primary:rdv'].answers.needsReply, false);
});
