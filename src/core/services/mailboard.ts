import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeWorkspace, workspaceRoot } from '../../config/workspace.js';
import { stderrLogger, type Logger } from '../../adapters/logger.js';
import type { Message, SearchOptions, IngestOptions, CycleOptions, BackfillOptions, CollectOptions } from '../models/index.js';
import { collectBrowser } from '../../adapters/browser-collector.js';
import { ingestRuns } from './ingestion.mjs';
import { backfillJev } from './jev-backfill.mjs';
import { missingBodies } from './missing-bodies.mjs';
import { jevAgreement } from './jev-agreement.mjs';
import { reviewQueue, saveReview } from './jev-review.mjs';
import { runCycle } from '../../../orchestrator/run-cycle.mjs';
import { loadCriteria, messageKey } from '../../../config/load.mjs';
import { readSettings } from '../../../settings/config.mjs';
import { createSettingsServer, saveSettings } from '../../../settings/server.mjs';

function readRows<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map((line, i) => {
    try { return JSON.parse(line) as T; }
    catch { throw new Error(`${path.basename(file)}:${i + 1} : JSON invalide`); }
  });
}
function boundedLimit(limit = 20): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit doit être entre 1 et 200');
  return limit;
}

export class Mailboard {
  readonly root: string;
  private readonly logger: Logger;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(options: { root?: string; logger?: Logger } = {}) {
    this.root = workspaceRoot(options.root);
    this.logger = options.logger ?? stderrLogger;
  }
  initialize() {
    initializeWorkspace(this.root);
    return { root: this.root, dashboard: path.join(this.root, 'dashboard', 'index.html') };
  }
  // Les requêtes MCP concurrentes ne peuvent pas réécrire le même index en parallèle.
  private mutate<T>(operation: () => Promise<T>, initialize = true): Promise<T> {
    const next = this.pending.then(async () => { if (initialize) this.initialize(); return operation(); });
    this.pending = next.catch(() => undefined);
    return next;
  }
  ingest(options: IngestOptions = {}) {
    return this.mutate(() => ingestRuns({ root: this.root, configRoot: this.configRoot(), logger: this.logger, ...options }), !options.dry);
  }
  rebuild() {
    return this.mutate(() => ingestRuns({ root: this.root, configRoot: this.root, logger: this.logger, rebuildOnly: true }));
  }
  cycle(options: CycleOptions = {}) {
    return this.mutate(() => runCycle({ root: this.root, configRoot: this.root, log: (...args: unknown[]) => this.logger.log(...args), ...options }));
  }
  backfill(options: BackfillOptions = {}) {
    boundedLimit(options.limit);
    return this.mutate(() => backfillJev({ root: this.root, configRoot: this.configRoot(), logger: this.logger, ...options }), !options.dry);
  }
  private configRoot(): string {
    return fs.existsSync(path.join(this.root, 'config', 'criteria.json')) ? this.root : fileURLToPath(new URL('../../../assets/', import.meta.url));
  }
  agreement(reference = 'human') { return jevAgreement({ root: this.root, configRoot: this.configRoot(), reference, logger: this.logger }); }
  reviewQueue(reviewer = 'claude', limit = 10, order: 'recent' | 'uncertain' = 'recent') {
    return reviewQueue({ root: this.root, configRoot: this.configRoot(), reviewer, limit, order });
  }
  saveReview(options: { reviewer?: string; model?: string; labels: { key: string; answers: Record<string, unknown> | null }[] }) {
    return this.mutate(async () => saveReview({ root: this.root, ...options }));
  }
  collect(options: CollectOptions) {
    if (!options.check && !options.sourceId) throw new Error('sourceId est requis pour la collecte');
    if (options.nav !== undefined && !['direct', 'jev'].includes(options.nav)) throw new Error('nav attend direct ou jev');
    if (options.windowHours !== undefined && (!Number.isInteger(options.windowHours) || options.windowHours < 1 || options.windowHours > 720)) throw new Error('windowHours doit être entre 1 et 720');
    if (options.maxItems !== undefined && (!Number.isInteger(options.maxItems) || options.maxItems < 1)) throw new Error('maxItems doit être positif');
    return this.mutate(() => collectBrowser(this.root, this.configRoot(), options, this.logger), !options.dry);
  }
  missingBodies(sourceId: string, limit = 20) {
    return missingBodies({ root: this.root, sourceId, limit: boundedLimit(limit) });
  }
  listMessages(options: SearchOptions = {}): Message[] {
    const limit = boundedLimit(options.limit);
    const bodies = options.query ? new Map(readRows<{ key?: string; sourceId?: string; id: string; text: string }>(path.join(this.root, 'data', 'bodies.jsonl')).map(b => [b.key ?? messageKey(b.sourceId, b.id), b.text])) : new Map<string, string>();
    const query = options.query?.toLocaleLowerCase();
    return readRows<Message>(path.join(this.root, 'data', 'messages.jsonl'))
      .filter(m => !options.sourceId || (m.sourceId ?? 'gmail-legacy') === options.sourceId)
      .filter(m => !options.category || m.category === options.category)
      .filter(m => !query || `${m.subject} ${m.from} ${m.summary ?? ''} ${bodies.get(m.key ?? messageKey(m.sourceId, m.id)) ?? ''}`.toLocaleLowerCase().includes(query))
      .sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
  }
  getMessage(sourceId: string, id: string) {
    const key = messageKey(sourceId, id);
    const message = readRows<Message>(path.join(this.root, 'data', 'messages.jsonl')).find(m => (m.key ?? messageKey(m.sourceId, m.id)) === key);
    if (!message) throw new Error(`Message inconnu : ${key}`);
    const body = readRows<{ key?: string; sourceId?: string; id: string; text: string; truncated: boolean }>(path.join(this.root, 'data', 'bodies.jsonl')).find(b => (b.key ?? messageKey(b.sourceId, b.id)) === key);
    return { ...message, body: body?.text ?? null, truncated: body?.truncated ?? false };
  }
  queries(provider = 'gmail', windowHours?: number) {
    if (windowHours !== undefined && (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 720)) throw new Error('windowHours doit être entre 1 et 720');
    this.initialize();
    return loadCriteria({ root: this.root }).queriesFor(provider, { windowHours });
  }
  readSettings() { this.initialize(); return readSettings(this.root); }
  saveSettings(settings: Parameters<typeof saveSettings>[1]) {
    return this.mutate(() => saveSettings(this.root, settings, () => ingestRuns({ root: this.root, configRoot: this.root, rebuildOnly: true, logger: this.logger })));
  }
  async serve(port = 4177) {
    this.initialize();
    await this.rebuild();
    return createSettingsServer({ root: this.root, port, rebuild: () => this.rebuild() });
  }
}
