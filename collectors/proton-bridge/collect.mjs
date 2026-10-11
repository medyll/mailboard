import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { loadChannels, loadCriteria } from '../../config/load.mjs';

export function messageIdentity(mail, item, folder, validity) {
  return { id: mail.messageId || `imap:${folder}:${validity}:${item.uid}`, identityQuality: 'provider-id' };
}

export async function collectBridge({ root, channel, criteria, windowHours, maxItems, check = false, dry = false, client, now = new Date() }) {
  const hours = Number(windowHours ?? channel.collection.windowHours ?? 12);
  const limit = Number(maxItems ?? channel.collection.maxItems ?? 100);
  if (!(hours > 0) || !Number.isInteger(limit) || limit < 1) throw new Error('Invalid collection window or limit');
  const from = new Date(now.getTime() - hours * 3600000);
  const run = {
    schemaVersion: 2, runAt: now.toISOString(), windowHours: hours,
    source: { sourceId: channel.sourceId, channelKind: channel.channelKind, accessMode: 'imap', provider: channel.provider },
    collector: { name: 'proton-bridge', status: 'ok' },
    coverage: { from: from.toISOString(), to: now.toISOString(), complete: true, itemsInspected: 0 },
    queries: criteria.queriesFor(channel.provider, { windowHours: hours }), messages: [],
  };
  try {
    await client.connect();
    if (!check) {
      const seen = new Set();
      for (const folder of channel.collection.folders ?? ['INBOX']) {
        const lock = await client.getMailboxLock(folder, { readOnly: true });
        try {
          const uids = await client.search({ since: new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())) }, { uid: true });
          const selected = (uids || []).slice(-limit);
          if (selected.length < uids.length) { run.coverage.complete = false; run.collector.status = 'partial'; }
          // Fetch individually: no IMAP commands are issued inside a streaming FETCH.
          for (const uid of selected) {
            const item = await client.fetchOne(uid, { source: true, internalDate: true, uid: true }, { uid: true });
            if (!item) continue;
            run.coverage.itemsInspected++;
            const received = new Date(item.internalDate);
            if (received < from || received > now) continue;
            const mail = await simpleParser(item.source, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true });
            const body = mail.text ?? '';
            const category = criteria.classify({ from: mail.from?.text, subject: mail.subject, snippet: body }).id;
            if (category === criteria.fallbackId) continue;
            const identity = messageIdentity(mail, item, folder, client.mailbox.uidValidity);
            if (seen.has(identity.id)) continue;
            seen.add(identity.id);
            run.messages.push({ ...identity, category, date: (mail.date ?? received).toISOString(), from: mail.from?.text ?? '', subject: mail.subject ?? '', summary: body.slice(0, 300), body, link: 'https://mail.proton.me/' });
          }
        } finally { lock.release(); }
      }
    }
  } catch (error) {
    run.collector.status = 'error';
    // Never include server responses, credentials or mail content in diagnostics.
    run.collector.note = `Bridge connection/collection failed (${String(error.code ?? 'IMAP_ERROR').replace(/[^A-Z0-9_]/gi, '').slice(0, 40)})`;
    run.coverage.complete = false;
  } finally { await client.logout().catch(() => client.close()); }
  if (!check && !dry) {
    const inbox = path.join(root, 'data', 'runs-inbox');
    fs.mkdirSync(inbox, { recursive: true });
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(inbox, `run-${stamp}--${channel.sourceId}.json`), JSON.stringify(run, null, 2) + '\n', { flag: 'wx' });
  }
  return run;
}

export async function main() {
  const root = path.resolve(process.env.MAILBOARD_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
  const args = process.argv.slice(2);
  const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const sourceId = value('--source');
  let channel = loadChannels({ root }).byId.get(sourceId);
  if (!channel || channel.accessMode !== 'imap') throw new Error('Select an enabled IMAP channel with --source');
  const secretFile = path.resolve(root, channel.bridge?.envFile ?? '.env.proton-bridge');
  if (fs.existsSync(secretFile)) process.loadEnvFile(secretFile);
  const host = process.env.PROTON_BRIDGE_IMAP_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Proton Bridge must use a loopback host');
  const client = new ImapFlow({ host, port: Number(process.env.PROTON_BRIDGE_IMAP_PORT ?? 1143), secure: false, doSTARTTLS: true,
    auth: { user: process.env.PROTON_BRIDGE_USERNAME ?? channel.accountHint, pass: process.env.PROTON_BRIDGE_PASSWORD },
    tls: { rejectUnauthorized: channel.bridge?.allowSelfSigned !== true }, logger: false,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
  client.on('error', () => {});
  const result = await collectBridge({ root, channel, criteria: loadCriteria({ root }), client, windowHours: value('--window'), maxItems: value('--max'), check: args.includes('--check'), dry: args.includes('--dry') || args.includes('--observe') });
  console.log(JSON.stringify({ type: 'mailboard.collect.result', sourceId, status: result.collector.status, inspected: result.coverage.itemsInspected, kept: result.messages.length, complete: result.coverage.complete, note: result.collector.note }));
  if (result.collector.status !== 'ok') process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Proton Bridge configuration failed'); process.exitCode = 1; });
