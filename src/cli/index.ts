import { Mailboard } from '../core/index.js';
import { version } from '../config/version.js';
import { parseCli } from './commands/parse.js';

const help = `@medyll/jobmailboard ${version}
Usage: jobmailboard <command> [options]

  init                  Prepare the user workspace
  ingest [--dry --jev]  Ingest runs dropped in data/runs-inbox
  rebuild               Rebuild the dashboard
  cycle [--skip-collect --retry-failed]  Collect, ingest and decide on notification
  collect [--check | --source ID] [--observe --dry --nav direct|jev --window 12 --max 100]
  missing-bodies --source ID [--limit 20]  List bodies to backfill
  messages [--source ID --category ID --query text --limit 20]
  message --source ID --id ID  Read a message and its body
  queries [--provider gmail --window 12]  Queries per enabled criterion
  jev-backfill [--source ID --limit 20 --dry --stale]
  jev-agreement [--reference human|claude]  Compare JEV with human (or reviewer) labels
  jev-review [--reviewer claude --limit 10 --order recent|uncertain]  Next blind batch for a tooled reviewer
  jev-review --file labels.json [--reviewer claude]  Save the reviewer's answers
  serve [--port 4177]   Dashboard and settings on 127.0.0.1
  mcp                   MCP stdio server (stdout reserved for the protocol)

Global options: --root <dir>, --json, --help (-h), --version (-v)
No command: print this help. Default data: the jobmailboard user workspace.
`;

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { command, values } = parseCli(args);
  if (values.version) { console.log(version); return; }
  if (values.help || !command) { console.log(help); return; }
  const board = new Mailboard({ root: values.root });
  if (command === 'mcp') {
    const { startMcp } = await import('../mcp/index.js');
    startMcp(board);
    return;
  }
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  let result: unknown;
  switch (command) {
    case 'init': result = board.initialize(); await board.rebuild(); break;
    case 'ingest': result = await board.ingest({ dry: values.dry, jev: values.jev }); break;
    case 'rebuild': result = await board.rebuild(); break;
    case 'cycle': {
      const cycle = await board.cycle({ skipCollect: values['skip-collect'], retryFailed: values['retry-failed'] });
      result = cycle;
      if (!cycle.ok) process.exitCode = 1;
      break;
    }
    case 'missing-bodies': result = board.missingBodies(values.source!, limit); break;
    case 'messages': result = board.listMessages({ sourceId: values.source, category: values.category, query: values.query, limit }); break;
    case 'message': result = board.getMessage(values.source!, values.id!); break;
    case 'queries': result = board.queries(values.provider, values.window === undefined ? undefined : Number(values.window)); break;
    case 'jev-agreement': result = board.agreement(values.reference); break;
    case 'jev-review': {
      if (values.file) {
        const raw = JSON.parse((await import('node:fs')).readFileSync(values.file, 'utf8'));
        const labels = Array.isArray(raw) ? raw : raw.labels;
        result = await board.saveReview({ reviewer: values.reviewer ?? raw.reviewer, model: raw.model, labels });
      } else result = board.reviewQueue(values.reviewer, limit, values.order as 'recent' | 'uncertain' | undefined);
      break;
    }
    case 'collect': {
      const collected = await board.collect({ sourceId: values.source, check: values.check, observe: values.observe, dry: values.dry,
        nav: values.nav as 'direct' | 'jev' | undefined, windowHours: values.window === undefined ? undefined : Number(values.window), maxItems: values.max === undefined ? undefined : Number(values.max) });
      result = collected;
      if (!collected.ok) process.exitCode = 1;
      break;
    }
    case 'jev-backfill': {
      const backfill = await board.backfill({ sourceId: values.source, limit, dry: values.dry, stale: values.stale });
      result = backfill;
      if (!values.dry && backfill.status !== 'ok') process.exitCode = 1;
      break;
    }
    case 'serve': {
      const app = await board.serve(values.port === undefined ? 4177 : Number(values.port));
      console.log(values.json ? JSON.stringify({ url: app.url }) : `JobMailBoard : ${app.url}`);
      const close = () => { void app.close().then(() => { process.exitCode = 0; }); };
      process.once('SIGINT', close);
      process.once('SIGTERM', close);
      return;
    }
  }
  console.log(JSON.stringify(result, null, values.json ? undefined : 2));
}
