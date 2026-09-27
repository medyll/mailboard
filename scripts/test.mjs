import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = [];
for (const dir of ['tests', 'ingest', 'settings', 'orchestrator', 'collectors', 'dashboard']) {
  for (const file of fs.readdirSync(path.join(root, dir), { recursive: true })) {
    if (file.endsWith('.test.mjs') && !file.includes('.venv')) tests.push(path.join(root, dir, file));
  }
}
const result = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
