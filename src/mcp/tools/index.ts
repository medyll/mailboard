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
    description: 'Chercher les messages locaux, y compris dans les corps stockés.',
    inputSchema: z.object({ sourceId: sourceId.optional(), category: z.string().optional(), query: z.string().optional(), limit }), annotations: readOnly,
  }, args => result(() => board.listMessages(args)));
  server.registerTool('get_message', {
    description: 'Lire un message local et son corps par canal et id externe.',
    inputSchema: z.object({ sourceId, id: z.string().min(1) }), annotations: readOnly,
  }, args => result(() => board.getMessage(args.sourceId, args.id)));
  server.registerTool('missing_bodies', {
    description: 'Lister les corps manquants pour le rattrapage.',
    inputSchema: z.object({ sourceId, limit }), annotations: readOnly,
  }, args => result(() => board.missingBodies(args.sourceId, args.limit)));
  server.registerTool('collection_queries', {
    description: 'Lire les requêtes des critères activés avec substitution de la fenêtre.',
    inputSchema: z.object({ provider: z.string().optional(), windowHours: z.number().int().min(1).max(720).optional() }),
  }, args => result(() => board.queries(args.provider, args.windowHours)));
  server.registerTool('ingest_runs', {
    description: 'Ingérer les runs de l’inbox, dédupliquer par canal + id et reconstruire le dashboard. JEV est optionnel.',
    inputSchema: z.object({ dry: z.boolean().optional(), jev: z.boolean().optional() }),
  }, args => result(() => board.ingest(args)));
  server.registerTool('rebuild_dashboard', {
    description: 'Reconstruire le dashboard depuis le stockage local et les critères actuels.', inputSchema: z.object({}),
  }, () => result(() => board.rebuild()));
  server.registerTool('run_cycle', {
    description: 'Collecter les canaux navigateur, ingérer une fois et décider de la notification depuis les nouveaux ids.',
    inputSchema: z.object({ skipCollect: z.boolean().optional(), retryFailed: z.boolean().optional() }),
  }, args => result(() => board.cycle(args)));
  server.registerTool('jev_backfill', {
    description: 'Réévaluer un lot via JEV. Cet appel constitue un opt-in réseau facturable ; dry évite tout appel.',
    inputSchema: z.object({ sourceId: sourceId.optional(), limit, dry: z.boolean().optional(), stale: z.boolean().optional() }),
  }, args => result(() => board.backfill(args)));
}
