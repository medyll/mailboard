import fs from 'node:fs';
// Un seul numéro de version pour npm, CLI et MCP.
export const version = (JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
