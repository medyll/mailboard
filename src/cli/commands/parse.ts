import { parseArgs } from 'node:util';

export const commands = ['init', 'ingest', 'rebuild', 'cycle', 'collect', 'missing-bodies', 'messages', 'message', 'queries', 'jev-backfill', 'jev-agreement', 'jev-review', 'serve', 'mcp'] as const;
export type Command = typeof commands[number];
const commandOptions: Record<Command, string[]> = {
  init: [], ingest: ['dry', 'jev'], rebuild: [], cycle: ['skip-collect', 'retry-failed'],
  collect: ['source', 'check', 'observe', 'dry', 'nav', 'window', 'max'],
  'missing-bodies': ['source', 'limit'], messages: ['source', 'limit', 'query', 'category'],
  message: ['source', 'id'], queries: ['provider', 'window'],
  'jev-backfill': ['source', 'limit', 'dry', 'stale'], 'jev-agreement': ['reference'], 'jev-review': ['reviewer', 'limit', 'file', 'order'], serve: ['port'], mcp: [],
};
export function parseCli(args: string[]) {
  const parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    root: { type: 'string' }, json: { type: 'boolean' }, dry: { type: 'boolean' }, jev: { type: 'boolean' },
    'skip-collect': { type: 'boolean' }, 'retry-failed': { type: 'boolean' }, stale: { type: 'boolean' },
    source: { type: 'string' }, id: { type: 'string' }, limit: { type: 'string' },
    query: { type: 'string' }, category: { type: 'string' }, provider: { type: 'string' },
    window: { type: 'string' }, port: { type: 'string' },
    check: { type: 'boolean' }, observe: { type: 'boolean' }, nav: { type: 'string' }, max: { type: 'string' },
    reference: { type: 'string' }, reviewer: { type: 'string' }, file: { type: 'string' }, order: { type: 'string' },
  } });
  if (parsed.positionals.length > 1) throw new Error('Only one command is expected.');
  const name = parsed.positionals[0];
  if (name && !commands.includes(name as Command)) throw new Error(`Unknown command: ${name}`);
  const command = name as Command | undefined;
  if (command) for (const option of Object.keys(parsed.values)) {
    if (!['help', 'version', 'root', 'json'].includes(option) && !commandOptions[command].includes(option)) throw new Error(`--${option} does not apply to ${command}`);
  }
  if (parsed.values.nav && !['direct', 'jev'].includes(parsed.values.nav)) throw new Error('--nav expects direct or jev');
  for (const option of ['limit', 'window', 'port', 'max'] as const) {
    const value = parsed.values[option];
    if (value !== undefined && !/^\d+$/.test(value)) throw new Error(`--${option} expects an integer.`);
    const max = option === 'port' ? 65535 : option === 'window' ? 720 : option === 'max' ? Number.MAX_SAFE_INTEGER : 200;
    if (value !== undefined && (Number(value) < (option === 'port' ? 0 : 1) || Number(value) > max)) throw new Error(`--${option} out of range (maximum ${max})`);
  }
  if (!parsed.values.help && !parsed.values.version) {
    if ((command === 'missing-bodies' || command === 'message') && !parsed.values.source) throw new Error('--source is required.');
    if (command === 'message' && !parsed.values.id) throw new Error('--id is required.');
    if (command === 'collect' && !parsed.values.check && !parsed.values.source) throw new Error('--source is required for collect.');
  }
  return { command, values: parsed.values };
}
