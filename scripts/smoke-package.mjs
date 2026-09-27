import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Lancer avec npm run smoke pour obtenir le chemin portable de npm.');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobmailboard-package-'));
const runNpm = (args, cwd) => {
  const env = { ...process.env };
  delete env.npm_config_local_prefix;
  delete env.npm_config_prefix;
  // Utiliser le même vrai Node que le test, même lorsqu'il vient d'un wrapper dlx.
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `${path.dirname(process.execPath)}${path.delimiter}${env[pathKey] ?? ''}`;
  const result = spawnSync(process.execPath, [npm, ...args], { cwd, encoding: 'utf8', env });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
};
try {
  const packResult = JSON.parse(runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', temp], root));
  // npm 10/11 renvoie un tableau ; npm 12 un objet indexé par nom de package.
  const packed = Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0];
  const names = packed.files.map(f => f.path);
  for (const file of ['bin/jobmailboard.js', 'dist/src/index.js', 'dist/src/cli/index.js', 'dist/src/mcp/index.js', 'dist/assets/dashboard/index.html', 'dist/assets/config/criteria.json']) assert.ok(names.includes(file), `Fichier absent : ${file}`);
  assert.ok(!names.some(f => /(^|\/)(profile|data|tests|node_modules|\.claude|\.tooling)(\/|$)|\.test\.mjs$|(?:data|bodies)\.js$/.test(f)), 'Données ou tests locaux dans le package');
  assert.ok(!names.some(f => f === 'config/channels.local.json'));
  const archive = path.join(temp, packed.filename);
  const installed = path.join(temp, 'installed');
  fs.mkdirSync(installed);
  fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: 'jobmailboard-smoke', version: '1.0.0', private: true, type: 'module' }));
  runNpm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', archive], installed);
  const packageRoot = path.join(installed, 'node_modules', '@medyll', 'jobmailboard');
  const bin = path.join(packageRoot, 'bin', 'jobmailboard.js');
  const dataRoot = path.join(temp, 'user data');
  for (const args of [['--help'], ['--version'], ['init', '--root', dataRoot, '--json'], ['cycle', '--skip-collect', '--root', dataRoot, '--json']]) {
    const result = spawnSync(process.execPath, [bin, ...args], { cwd: installed, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.trim());
  }
  // npm exec utilise réellement le shim du bin du package installé, sur les trois OS.
  const shim = path.join(installed, 'node_modules', '.bin', process.platform === 'win32' ? 'jobmailboard.cmd' : 'jobmailboard');
  assert.ok(fs.existsSync(shim), `Shim absent : ${shim}`);
  assert.ok(runNpm(['exec', '--offline', '--', 'jobmailboard', '--version'], installed).includes(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version));
  const api = await import(pathToFileURL(path.join(packageRoot, 'dist', 'src', 'index.js')).href);
  const board = new api.Mailboard({ root: dataRoot });
  assert.equal(board.listMessages().length, 0);
  const app = await board.serve(0);
  try { assert.equal((await fetch(app.url)).status, 200); }
  finally { await app.close(); }
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin, 'mcp', '--root', dataRoot], stderr: 'pipe' });
  const client = new Client({ name: 'package-smoke', version: '1.0.0' });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 8);
    const reply = await client.callTool({ name: 'ingest_runs', arguments: {} });
    assert.ok(!reply.isError);
    assert.equal(JSON.parse(reply.content[0].text).added, 0);
  } finally { await client.close(); }
  console.log(`Package inspecté : ${names.length} fichiers, ${packed.size} octets. Installation sans devDependencies, bin/npx, API et MCP : OK.`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
