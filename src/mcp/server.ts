import { McpServer } from '@modelcontextprotocol/server';
import { version } from '../config/version.js';
import { Mailboard } from '../core/index.js';
import { registerTools } from './tools/index.js';
import { registerResources } from './resources/index.js';

export function createMcpServer(board = new Mailboard()): McpServer {
  const server = new McpServer({ name: '@medyll/jobmailboard', version });
  registerTools(server, board);
  registerResources(server, board);
  return server;
}
