import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseCli } from '../../dist/src/cli/commands/parse.js';

const bin = path.resolve('bin/jobmailboard.js');
const run = args => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
test('CLI sans commande, --help, --version et erreurs de parsing', () => {
  for (const args of [[], ['--help'], ['ingest', '--help']]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: jobmailboard/);
  }
  const version = JSON.parse(fs.readFileSync('package.json')).version;
  assert.equal(run(['--version']).stdout.trim(), version);
  for (const args of [['invalid'], ['--invalid'], ['messages', '--limit', '-1'], ['message'], ['messages', '--dry'], ['messages', '--limit', '200.5'], ['collect'], ['collect', '--check', '--nav', 'invalid']]) {
    assert.equal(run(args).status, 1, args.join(' '));
  }
  assert.equal(parseCli(['--root', 'space with spaces', 'cycle', '--skip-collect']).values.root, 'space with spaces');
  assert.equal(parseCli(['collect', '--check']).values.check, true);
});
test('CLI réelle crée et ingère dans un répertoire extérieur au package', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobmailboard-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(run(['init', '--root', root, '--json']).status, 0);
  const result = run(['ingest', '--root', root, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).added, 0);
  assert.ok(fs.existsSync(path.join(root, 'dashboard', 'data.js')));
});
