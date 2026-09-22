// node --test dashboard/dashboard.test.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withOwnedTab } from '../collectors/browser-mail/edge.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const edgePath = () =>
  [
    process.env.MAILBOARD_EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].find((candidate) => candidate && fs.existsSync(candidate));

const freePort = async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
};

const waitForCdp = async (port) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Edge ouvre le port quelques instants après le lancement du processus.
    }
    await delay(100);
  }
  throw new Error(`Edge n'a pas ouvert le port CDP ${port}`);
};

const waitInPage = (expression) =>
  `(async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (${expression}) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  })()`;

test('le dashboard file:// filtre, recherche, ouvre un corps et garde l’état traité', async (t) => {
  const executable = edgePath();
  if (!executable) {
    t.skip('Microsoft Edge absent ; définir MAILBOARD_EDGE_PATH pour exécuter ce test');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailboard-dashboard-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mailboard-edge-'));
  const port = await freePort();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const file of ['index.html', 'app.js', 'style.css', 'settings-runtime.js']) {
    fs.copyFileSync(path.join(PROJECT_ROOT, 'dashboard', file), path.join(root, file));
  }
  fs.mkdirSync(path.join(root, 'settings-component'));
  for (const file of ['settings-component.css', 'settings-component.js']) {
    fs.copyFileSync(
      path.join(PROJECT_ROOT, 'dashboard', 'settings-component', file),
      path.join(root, 'settings-component', file),
    );
  }

  const messages = [
    {
      key: 'gmail-primary:one', id: 'one', sourceId: 'gmail-primary', provider: 'gmail', category: 'alertes',
      date: '2026-09-22T08:00:00.000Z', from: 'one@example.test', subject: 'Premier message', summary: 'résumé un', hasBody: true,
    },
    {
      key: 'gmail-primary:two', id: 'two', sourceId: 'gmail-primary', provider: 'gmail', category: 'alertes',
      date: '2026-09-22T08:01:00.000Z', from: 'two@example.test', subject: 'Deuxième message', summary: 'résumé deux', hasBody: true,
    },
    {
      key: 'proton-personal:three', id: 'three', sourceId: 'proton-personal', provider: 'proton', category: 'alertes',
      date: '2026-09-22T08:02:00.000Z', from: 'three@example.test', subject: 'Troisième message', summary: 'résumé trois', hasBody: true,
    },
  ];
  const payload = {
    generatedAt: '2026-09-22T08:03:00.000Z', categories: ['alertes'],
    categoryMeta: [{ id: 'alertes', label: 'Alertes', color: { light: '#444', dark: '#ccc' } }],
    preferenceLabels: {},
    sources: [
      { sourceId: 'gmail-primary', provider: 'gmail', lastRunAt: '2026-09-22T08:03:00.000Z', runs: 1 },
      { sourceId: 'proton-personal', provider: 'proton', lastRunAt: '2026-09-22T08:03:00.000Z', runs: 1 },
    ],
    messages,
    runs: [
      { runId: 'fixture', runAt: '2026-09-22T08:03:00.000Z', source: { sourceId: 'gmail-primary' }, returned: 3, added: 3 },
    ],
  };
  fs.writeFileSync(path.join(root, 'data.js'), `window.MAILBOARD = ${JSON.stringify(payload)};\n`);
  fs.writeFileSync(
    path.join(root, 'bodies.js'),
    `window.MAILBOARD_BODIES = ${JSON.stringify({
      'gmail-primary:one': { text: 'corps ordinaire', truncated: false },
      'gmail-primary:two': { text: 'texte needle-in-body seulement dans le corps', truncated: false },
      'proton-personal:three': { text: 'autre corps', truncated: false },
    })}; window.dispatchEvent(new Event('mailboard:bodies'));\n`,
  );

  const edge = spawn(
    executable,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--disable-default-apps',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
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
      // Edge peut garder un fichier de profil verrouillé quelques secondes après
      // sa sortie. Ce résidu temporaire ne doit pas masquer le résultat UI.
      if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error;
    }
  });

  await waitForCdp(port);
  await withOwnedTab({ port, family: 'edge', allowedOrigins: ['null'] }, async (tab) => {
    await tab.navigate(pathToFileURL(path.join(root, 'index.html')).href);
    assert.equal(await tab.eval(`document.querySelectorAll('#messages > li').length`), 3);

    assert.equal(
      await tab.eval(`(() => {
        const input = document.querySelector('#source-filter');
        input.value = 'gmail-primary';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return document.querySelectorAll('#messages > li').length;
      })()`),
      2,
    );

    await tab.eval(`(() => {
      const source = document.querySelector('#source-filter');
      source.value = '';
      source.dispatchEvent(new Event('change', { bubbles: true }));
      const search = document.querySelector('#search');
      search.value = 'needle-in-body';
      search.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    assert.equal(await tab.eval(waitInPage(`document.querySelectorAll('#messages > li').length === 1`)), true);

    await tab.eval(`(() => {
      const search = document.querySelector('#search');
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-expand="gmail-primary:two"]').click();
    })()`);
    assert.equal(await tab.eval(waitInPage(`document.querySelector('.msg-body')?.textContent.includes('needle-in-body')`)), true);

    await tab.eval(`document.querySelector('[data-toggle="gmail-primary:two"]').click()`);
    assert.deepEqual(
      await tab.eval(`JSON.parse(localStorage.getItem('mailboard.done'))`),
      ['gmail-primary:two'],
    );
    await tab.eval(`location.reload()`);
    assert.equal(await tab.eval(waitInPage(`document.querySelector('[data-toggle="gmail-primary:two"]')?.textContent === 'Rouvrir'`)), true);
  });
});
