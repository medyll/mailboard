import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../orchestrator/run-cycle.mjs';
import type { Logger } from './logger.js';
import type { CollectOptions } from '../core/models/index.js';

export async function collectBrowser(root: string, configRoot: string, options: CollectOptions, logger: Logger) {
  const collector = fileURLToPath(new URL('../../collectors/browser-mail/collect.mjs', import.meta.url));
  const args = [collector];
  if (options.sourceId) args.push('--source', options.sourceId);
  if (options.check) args.push('--check');
  if (options.observe) args.push('--observe');
  if (options.dry) args.push('--dry');
  if (options.nav) args.push('--nav', options.nav);
  if (options.windowHours) args.push('--window', String(options.windowHours));
  if (options.maxItems) args.push('--max', String(options.maxItems));
  const output = await run(process.execPath, args, {
    env: { ...process.env, MAILBOARD_ROOT: root, MAILBOARD_CONFIG_DIR: process.env.MAILBOARD_CONFIG_DIR ?? path.join(configRoot, 'config') },
    timeoutMs: 300000,
  });
  if (output.stdout.trim()) logger.log(output.stdout.trim());
  if (output.stderr.trim()) logger.error(output.stderr.trim());
  return { type: 'mailboard.collect.result', ok: output.code === 0 && !output.timedOut, code: output.code, timedOut: output.timedOut };
}
