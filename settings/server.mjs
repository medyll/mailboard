import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareSettings, readSettings, serializeSettings, validateSettings } from './config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

const json = (response, status, payload) => {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
};

const readBody = async (request) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error('Requête trop volumineuse.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const runRebuild = (root) => {
  const result = spawnSync(process.execPath, [path.join(root, 'ingest', 'ingest.mjs'), '--rebuild'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'Le rebuild a échoué.');
  return result.stdout.trim();
};

export async function saveSettings(root, settings, rebuild = () => runRebuild(root)) {
  const errors = validateSettings(settings);
  if (errors.length) return { ok: false, status: 422, errors };

  const prepared = prepareSettings(settings);
  const contents = serializeSettings(prepared);
  const transaction = randomBytes(8).toString('hex');
  const backups = new Map();
  const staged = new Map();

  try {
    for (const [relative, content] of Object.entries(contents)) {
      const target = path.join(root, relative);
      const temp = `${target}.settings-${transaction}.tmp`;
      backups.set(target, fs.readFileSync(target));
      fs.writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' });
      staged.set(target, temp);
    }
    for (const [target, temp] of staged) fs.renameSync(temp, target);
    const output = await rebuild();
    return { ok: true, status: 200, settings: prepared, rebuild: output };
  } catch (error) {
    let rollbackError = null;
    for (const [target, content] of backups) {
      try {
        fs.writeFileSync(target, content);
      } catch (restoreError) {
        rollbackError ??= restoreError;
      }
    }
    const suffix = rollbackError ? ` La restauration a aussi échoué : ${rollbackError.message}` : '';
    return { ok: false, status: 500, errors: [{ path: '', message: `Enregistrement annulé : ${error.message}.${suffix}` }] };
  } finally {
    for (const temp of staged.values()) fs.rmSync(temp, { force: true });
  }
}

export async function createSettingsServer({ root = ROOT, host = '127.0.0.1', port = 0, rebuild } = {}) {
  const token = randomBytes(24).toString('base64url');
  const dashboard = path.join(root, 'dashboard');
  let saving = false;

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host ?? host}`);
      const isApi = url.pathname.startsWith('/api/settings');

      if (isApi) {
        const origin = request.headers.origin;
        if (origin && origin !== `http://${request.headers.host}`) return json(response, 403, { error: 'Origine refusée.' });
        if (request.headers['x-mailboard-token'] !== token) return json(response, 403, { error: 'Jeton local invalide.' });

        if (request.method === 'GET' && url.pathname === '/api/settings') {
          return json(response, 200, { settings: readSettings(root) });
        }
        if (request.method === 'POST' && url.pathname === '/api/settings/validate') {
          const settings = await readBody(request);
          const errors = validateSettings(settings);
          return json(response, errors.length ? 422 : 200, { ok: errors.length === 0, errors });
        }
        if (request.method === 'PUT' && url.pathname === '/api/settings') {
          if (saving) return json(response, 409, { errors: [{ path: '', message: 'Un enregistrement est déjà en cours.' }] });
          saving = true;
          try {
            const result = await saveSettings(root, await readBody(request), rebuild);
            return json(response, result.status, result);
          } finally {
            saving = false;
          }
        }
        return json(response, 404, { error: 'Route inconnue.' });
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405).end();
        return;
      }
      if (url.pathname === '/settings-runtime.js') {
        response.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(`window.MAILBOARD_SETTINGS = Object.freeze({ enabled: true, token: ${JSON.stringify(token)} });\n`);
        return;
      }
      if (url.pathname === '/favicon.ico') {
        response.writeHead(204, { 'Cache-Control': 'max-age=86400' }).end();
        return;
      }

      const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(dashboard, requested);
      const relative = path.relative(dashboard, file);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        response.writeHead(404).end('Introuvable');
        return;
      }
      response.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': file.endsWith('data.js') || file.endsWith('bodies.js') ? 'no-store' : 'max-age=0',
        'X-Content-Type-Options': 'nosniff',
      });
      if (request.method === 'HEAD') response.end();
      else fs.createReadStream(file).pipe(response);
    } catch (error) {
      json(response, 500, { error: error.message });
    }
  });

  await new Promise((resolve, reject) => server.once('error', reject).listen(port, host, resolve));
  const address = server.address();
  const url = `http://${host}:${address.port}/`;
  return {
    server,
    token,
    url,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const portArg = process.argv.indexOf('--port');
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 4177;
  const app = await createSettingsServer({ port });
  console.log(`Mailboard réglages : ${app.url}`);
  console.log('Ctrl+C pour arrêter le processus local.');
  process.on('SIGINT', async () => {
    await app.close();
    process.exit(0);
  });
}
