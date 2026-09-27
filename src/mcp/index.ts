import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Mailboard } from '../core/index.js';
import { createMcpServer } from './server.js';

export function startMcp(board: Mailboard): void {
  serveStdio(() => createMcpServer(board));
}
