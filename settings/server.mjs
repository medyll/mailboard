import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareSettings, readSettings, serializeSettings, validateSettings } from './config.mjs';
import { labelQuestions, readLabels, saveLabel } from '../ingest/jev-labels.mjs';
import { ingestRuns } from '../src/core/services/ingestion.mjs';

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
    if (size > 2_000_000) throw new Error('Request too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const runRebuild = root => ingestRuns({ root, configRoot: root, rebuildOnly: true });

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
    const suffix = rollbackError ? ` Restoring also failed: ${rollbackError.message}` : '';
    return { ok: false, status: 500, errors: [{ path: '', message: `Save cancelled: ${error.message}.${suffix}` }] };
  } finally {
    for (const temp of staged.values()) fs.rmSync(temp, { force: true });
  }
}

/** @param {{root?: string, host?: string, port?: number, rebuild?: () => unknown | Promise<unknown>}} options */
export async function createSettingsServer({ root = ROOT, host = '127.0.0.1', port = 0, rebuild } = {}) {
  const token = randomBytes(24).toString('base64url');
  const dashboard = path.join(root, 'dashboard');
  let saving = false;

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host ?? host}`);
      const isApi = url.pathname.startsWith('/api/settings') || url.pathname.startsWith('/api/labels');

      if (isApi) {
        const origin = request.headers.origin;
        if (origin && origin !== `http://${request.headers.host}`) return json(response, 403, { error: 'Origin refused.' });
        if (request.headers['x-mailboard-token'] !== token) return json(response, 403, { error: 'Invalid local token.' });

        if (request.method === 'GET' && url.pathname === '/api/settings') {
          return json(response, 200, { settings: readSettings(root) });
        }
        if (request.method === 'POST' && url.pathname === '/api/settings/validate') {
          const settings = await readBody(request);
          const errors = validateSettings(settings);
          return json(response, errors.length ? 422 : 200, { ok: errors.length === 0, errors });
        }
        if (request.method === 'PUT' && url.pathname === '/api/settings') {
          if (saving) return json(response, 409, { errors: [{ path: '', message: 'A save is already in progress.' }] });
          saving = true;
          try {
            const result = await saveSettings(root, await readBody(request), rebuild);
            return json(response, result.status, result);
          } finally {
            saving = false;
          }
        }
        // Étiquetage JEV : questions posées + étiquettes déjà saisies, écriture une à une.
        if (request.method === 'GET' && url.pathname === '/api/labels') {
          const configRoot = fs.existsSync(path.join(root, 'config', 'jev.json')) ? root : undefined;
          return json(response, 200, { ...labelQuestions(configRoot), labels: readLabels(root).labels });
        }
        if (request.method === 'PUT' && url.pathname === '/api/labels') {
          const result = saveLabel(root, await readBody(request));
          return json(response, result.status, result);
        }
        return json(response, 404, { error: 'Unknown route.' });
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
  console.log(`Mailboard settings: ${app.url}`);
  console.log('Ctrl+C to stop the local process.');
  process.on('SIGINT', async () => {
    await app.close();
    process.exit(0);
  });
}
