import { parseArgs } from 'node:util';

export const commands = ['init', 'ingest', 'rebuild', 'cycle', 'collect', 'missing-bodies', 'messages', 'message', 'queries', 'jev-backfill', 'jev-agreement', 'serve', 'mcp'] as const;
export type Command = typeof commands[number];
const commandOptions: Record<Command, string[]> = {
  init: [], ingest: ['dry', 'jev'], rebuild: [], cycle: ['skip-collect', 'retry-failed'],
  collect: ['source', 'check', 'observe', 'dry', 'nav', 'window', 'max'],
  'missing-bodies': ['source', 'limit'], messages: ['source', 'limit', 'query', 'category'],
  message: ['source', 'id'], queries: ['provider', 'window'],
  'jev-backfill': ['source', 'limit', 'dry', 'stale'], 'jev-agreement': [], serve: ['port'], mcp: [],
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
  } });
  if (parsed.positionals.length > 1) throw new Error('Une seule commande est attendue.');
  const name = parsed.positionals[0];
  if (name && !commands.includes(name as Command)) throw new Error(`Commande inconnue : ${name}`);
  const command = name as Command | undefined;
  if (command) for (const option of Object.keys(parsed.values)) {
    if (!['help', 'version', 'root', 'json'].includes(option) && !commandOptions[command].includes(option)) throw new Error(`--${option} ne s’applique pas à ${command}`);
  }
  if (parsed.values.nav && !['direct', 'jev'].includes(parsed.values.nav)) throw new Error('--nav attend direct ou jev');
  for (const option of ['limit', 'window', 'port', 'max'] as const) {
    const value = parsed.values[option];
    if (value !== undefined && !/^\d+$/.test(value)) throw new Error(`--${option} attend un entier.`);
    const max = option === 'port' ? 65535 : option === 'window' ? 720 : option === 'max' ? Number.MAX_SAFE_INTEGER : 200;
    if (value !== undefined && (Number(value) < (option === 'port' ? 0 : 1) || Number(value) > max)) throw new Error(`--${option} hors limites (maximum ${max})`);
  }
  if (!parsed.values.help && !parsed.values.version) {
    if ((command === 'missing-bodies' || command === 'message') && !parsed.values.source) throw new Error('--source est requis.');
    if (command === 'message' && !parsed.values.id) throw new Error('--id est requis.');
    if (command === 'collect' && !parsed.values.check && !parsed.values.source) throw new Error('--source est requis pour collect.');
  }
  return { command, values: parsed.values };
}
