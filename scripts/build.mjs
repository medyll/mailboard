import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
const compiled = spawnSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')], { cwd: root, stdio: 'inherit' });
if (compiled.status !== 0) process.exit(compiled.status ?? 1);
fs.cpSync(path.join(root, 'assets', 'config'), path.join(dist, 'assets', 'config'), { recursive: true });
fs.cpSync(path.join(root, 'dashboard'), path.join(dist, 'assets', 'dashboard'), {
  recursive: true,
  filter: file => !/(?:^|[\\/])(?:data\.js|bodies\.js|.*\.test\.mjs)$/.test(file),
});
for (const file of ['jev_driver.py', 'pyproject.toml', 'run.ps1']) {
  fs.copyFileSync(path.join(root, 'collectors', 'browser-mail', file), path.join(dist, 'collectors', 'browser-mail', file));
}
// Les déclarations internes restent nécessaires aux exports TypeScript publics.
fs.chmodSync(path.join(root, 'bin', 'jobmailboard.js'), 0o755);
console.log('Build JavaScript et assets terminé.');
