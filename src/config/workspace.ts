import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function userWorkspace(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'jobmailboard');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'jobmailboard');
  return path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'jobmailboard');
}

export function workspaceRoot(root?: string): string {
  const resolved = path.resolve(root ?? process.env.MAILBOARD_ROOT ?? userWorkspace());
  // Empêche une installation npm d'être utilisée comme espace de données.
  const runtime = fileURLToPath(new URL('../../', import.meta.url));
  const packageRoot = path.resolve(runtime, '..');
  const relative = path.relative(packageRoot, resolved);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Le répertoire de données doit être extérieur au package npm.');
  }
  return resolved;
}

export function initializeWorkspace(root: string): void {
  const assets = fileURLToPath(new URL('../../assets/', import.meta.url));
  for (const directory of ['config', 'dashboard', 'data/runs-inbox', 'data/runs-archive', 'profile']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  for (const folder of ['config', 'dashboard']) {
    const source = path.join(assets, folder);
    const copy = (from: string, to: string): void => {
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const target = path.join(to, entry.name);
        if (entry.isDirectory()) {
          fs.mkdirSync(target, { recursive: true });
          copy(path.join(from, entry.name), target);
        } else if (!fs.existsSync(target)) {
          fs.copyFileSync(path.join(from, entry.name), target, fs.constants.COPYFILE_EXCL);
        }
      }
    };
    copy(source, path.join(root, folder));
  }
}
