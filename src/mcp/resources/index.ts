import type { McpServer } from '@modelcontextprotocol/server';
import type { Mailboard } from '../../core/index.js';

export function registerResources(server: McpServer, board: Mailboard): void {
  server.registerResource('settings', 'jobmailboard://settings', { description: 'Criteria, preferences and JEV questions (no secret values)', mimeType: 'application/json' }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(board.readSettings()) }],
  }));
}
