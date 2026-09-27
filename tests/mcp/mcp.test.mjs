import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export async function checkMcp(bin, root) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin, 'mcp', '--root', root], stderr: 'pipe' });
  const client = new Client({ name: 'jobmailboard-test', version: '1.0.0' });
  const errors = [];
  client.onerror = error => errors.push(error);
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ['collection_queries', 'get_message', 'ingest_runs', 'jev_agreement', 'jev_backfill', 'jev_review_queue', 'jev_review_save', 'list_messages', 'missing_bodies', 'rebuild_dashboard', 'run_cycle'].sort());
    const call = async (name, args = {}) => {
      const reply = await client.callTool({ name, arguments: args });
      assert.ok(!reply.isError, reply.content?.[0]?.text);
      return JSON.parse(reply.content[0].text);
    };
    assert.ok((await call('collection_queries', { windowHours: 18 })).emploi.includes('18h'));
    fs.writeFileSync(path.join(root, 'data', 'runs-inbox', 'mcp.json'), JSON.stringify({
      schemaVersion: 2, runAt: '2026-09-27T10:00:00Z', source: { sourceId: 'test', provider: 'gmail', accessMode: 'connector' },
      messages: [{ id: '1', date: '2026-09-27T09:00:00Z', subject: 'Emploi', from: 'jobs@example.test', category: 'emploi', body: 'Texte MCP test' }],
    }));
    assert.equal((await call('ingest_runs')).added, 1);
    assert.equal((await call('get_message', { sourceId: 'test', id: '1' })).body, 'Texte MCP test');
    assert.equal((await call('list_messages', { query: 'MCP' })).length, 1);
    assert.equal((await call('missing_bodies', { sourceId: 'test' })).missing, 0);
    assert.equal((await call('run_cycle', { skipCollect: true })).notify, false);
    await call('rebuild_dashboard');
    const dry = await call('jev_backfill', { dry: true });
    assert.equal(dry.called, 0);
    const invalid = await client.callTool({ name: 'missing_bodies', arguments: { sourceId: 'test', limit: -1 } });
    assert.equal(invalid.isError, true);
    const missing = await client.callTool({ name: 'get_message', arguments: { sourceId: 'test', id: 'absent' } });
    assert.equal(missing.isError, true);
    assert.ok((await client.listResources()).resources.some(r => r.uri === 'jobmailboard://settings'));
    const settings = await client.readResource({ uri: 'jobmailboard://settings' });
    assert.equal(JSON.parse(settings.contents[0].text).jev.enabled, false);
    // Tout stdout parasite fait échouer le décodage JSON-RPC du transport.
    assert.deepEqual(errors, []);
  } finally { await client.close(); }
}

test('serveur MCP stdio : enregistrement, validation, métier et stdout propre', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobmailboard-mcp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await checkMcp(path.resolve('bin/jobmailboard.js'), root);
});
