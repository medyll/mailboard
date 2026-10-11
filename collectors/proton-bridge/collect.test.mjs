import test from 'node:test';
import assert from 'node:assert/strict';
import { collectBridge, messageIdentity } from './collect.mjs';

const now = new Date('2026-10-11T12:00:00Z');
const channel = { sourceId: 'proton-test', channelKind: 'mailbox', provider: 'proton', collection: { windowHours: 12, maxItems: 100, folders: ['INBOX'] } };
const criteria = { fallbackId: 'autre', queriesFor: () => ({ emploi: 'emploi' }), classify: ({ snippet }) => ({ id: snippet.includes('emploi') ? 'emploi' : 'autre' }) };
const raw = id => Buffer.from(`Message-ID: <${id}@example.test>\r\nFrom: Jobs <jobs@example.test>\r\nSubject: Offre\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nUn emploi disponible.`);
function fake({ fail = false, uids = [1, 2], old = false } = {}) {
  return { mailbox: { uidValidity: 12 }, connect: async () => { if (fail) throw Object.assign(new Error('secret'), { code: 'ECONNREFUSED' }); },
    getMailboxLock: async (_folder, options) => { assert.equal(options.readOnly, true); return { release() {} }; },
    search: async () => uids, fetchOne: async uid => ({ uid, internalDate: old ? new Date('2026-10-10') : now, source: raw('same') }), logout: async () => {}, close() {} };
}
const collect = client => collectBridge({ root: '.', channel, criteria, client, now, dry: true });
test('reads full bodies without marking mail read and deduplicates Message-ID', async () => {
  const run = await collect(fake());
  assert.equal(run.messages.length, 1);
  assert.match(run.messages[0].body, /emploi/);
  assert.equal(run.messages[0].id, '<same@example.test>');
  assert.equal(run.collector.status, 'ok');
});
test('empty window is complete; failed connection is explicit and sanitized', async () => {
  assert.deepEqual((await collect(fake({ old: true }))).messages, []);
  const run = await collect(fake({ fail: true }));
  assert.equal(run.collector.status, 'error');
  assert.equal(run.coverage.complete, false);
  assert.ok(!JSON.stringify(run).includes('secret'));
});
test('limit reports incomplete coverage', async () => {
  const run = await collectBridge({ root: '.', channel, criteria, client: fake(), now, dry: true, maxItems: 1 });
  assert.equal(run.collector.status, 'partial');
  assert.equal(run.coverage.complete, false);
});
test('UID fallback includes folder and UIDVALIDITY', () => {
  assert.notEqual(messageIdentity({}, { uid: 1 }, 'INBOX', 1).id, messageIdentity({}, { uid: 1 }, 'INBOX', 2).id);
});
