import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { Mailboard } from '../../core/index.js';

const limit = z.number().int().min(1).max(200).optional();
const sourceId = z.string().min(1);
async function result(operation: () => unknown | Promise<unknown>) {
  try { return { content: [{ type: 'text' as const, text: JSON.stringify(await operation()) }] }; }
  catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }; }
}
export function registerTools(server: McpServer, board: Mailboard): void {
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  server.registerTool('list_messages', {
    description: 'Search local messages, stored bodies included.',
    inputSchema: z.object({ sourceId: sourceId.optional(), category: z.string().optional(), query: z.string().optional(), limit }), annotations: readOnly,
  }, args => result(() => board.listMessages(args)));
  server.registerTool('get_message', {
    description: 'Read a local message and its body by channel and external id.',
    inputSchema: z.object({ sourceId, id: z.string().min(1) }), annotations: readOnly,
  }, args => result(() => board.getMessage(args.sourceId, args.id)));
  server.registerTool('missing_bodies', {
    description: 'List missing bodies to backfill.',
    inputSchema: z.object({ sourceId, limit }), annotations: readOnly,
  }, args => result(() => board.missingBodies(args.sourceId, args.limit)));
  server.registerTool('collection_queries', {
    description: 'Read the queries of enabled criteria, with the window substituted.',
    inputSchema: z.object({ provider: z.string().optional(), windowHours: z.number().int().min(1).max(720).optional() }),
  }, args => result(() => board.queries(args.provider, args.windowHours)));
  server.registerTool('ingest_runs', {
    description: 'Ingest inbox runs, deduplicate by channel + id and rebuild the dashboard. JEV is optional.',
    inputSchema: z.object({ dry: z.boolean().optional(), jev: z.boolean().optional() }),
  }, args => result(() => board.ingest(args)));
  server.registerTool('rebuild_dashboard', {
    description: 'Rebuild the dashboard from local storage and current criteria.', inputSchema: z.object({}),
  }, () => result(() => board.rebuild()));
  server.registerTool('run_cycle', {
    description: 'Collect browser channels, ingest once and decide on notification from new ids.',
    inputSchema: z.object({ skipCollect: z.boolean().optional(), retryFailed: z.boolean().optional() }),
  }, args => result(() => board.cycle(args)));
  server.registerTool('jev_backfill', {
    description: 'Re-evaluate a batch with JEV. Calling this is an opt-in to billable network calls; dry avoids any call.',
    inputSchema: z.object({ sourceId: sourceId.optional(), limit, dry: z.boolean().optional(), stale: z.boolean().optional() }),
  }, args => result(() => board.backfill(args)));
}
