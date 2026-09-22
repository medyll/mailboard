#!/usr/bin/env node
// Collecteur navigateur : produit un run dans data/runs-inbox/, rien de plus.
//
//   node collectors/browser-mail/collect.mjs --check              palier A
//   node collectors/browser-mail/collect.mjs --observe --source X palier B
//   node collectors/browser-mail/collect.mjs --source X           palier C
//   … --source X --window 720 --max 1000                          reprise d'un mois
//
// Il ne lance pas `ingest.mjs`. La frontière entre « piloter un navigateur » et
// « décider ce qui fait foi dans data/ » est justement ce qui rend ce collecteur
// remplaçable : un autre outil, dans un autre langage, écrit le même fichier.
//
// Paliers (COLLECTE_MULTICANAL.md) :
//   A  --check    attachement au bon Edge, onglet neutre créé puis refermé.
//                 Aucune boîte n'est ouverte.
//   B  --observe  la boîte est atteinte et le compte vérifié ; on compte les
//                 lignes. Le run écrit ne contient ni objet, ni expéditeur, ni
//                 extrait : il documente la couverture, pas le contenu.
//   C  (défaut)   lignes normalisées vers le contrat de run v2.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadChannels, loadCriteria, ROOT } from '../../config/load.mjs';
import { withOwnedTab, CollectorError } from './edge.mjs';
import * as proton from './providers/proton.mjs';

const NAME = 'browser-mail';
const VERSION = '0.1.0';
const INBOX = path.join(ROOT, 'data', 'runs-inbox');

const PROVIDERS = { proton };

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : null;
};

const CHECK = flag('--check');
// --nav jev délègue la navigation à jev-ultrafast : le modèle choisit les
// actions, le code garde l'extraction. --nav direct (défaut) suit le chemin
// connu de la boîte, sans appel ni coût.
const NAV = option('--nav') ?? 'direct';
const WINDOW = Number(option('--window') ?? process.env.MAILBOARD_WINDOW_HOURS ?? 0) || null;
const MAX = Number(option('--max') ?? 0) || null;
const OBSERVE = flag('--observe');
const DRY = flag('--dry');

const stamp = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}` +
  `-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;

const shortHash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Un run est écrit dans tous les cas : un échec documenté vaut mieux qu'un silence. */
function writeRun({ channel, runAt, status, note, coverage, messages, engine }) {
  const runId = `run-${stamp(new Date(runAt))}--${channel.sourceId}`;
  const run = {
    schemaVersion: 2,
    runAt,
    windowHours: channel.collection?.windowHours ?? null,
    source: {
      sourceId: channel.sourceId,
      channelKind: channel.channelKind,
      accessMode: channel.accessMode,
      provider: channel.provider,
    },
    collector: {
      name: NAME,
      version: VERSION,
      browser: channel.browser?.family ?? null,
      // Dit par quoi la navigation a été décidée : un run guidé par un modèle
      // et un run déterministe ne se relisent pas de la même façon.
      engine: engine ?? (NAV === 'jev' ? 'jev-ultrafast' : 'cdp-déterministe'),
      status,
      ...(note ? { note } : {}),
    },
    coverage,
    messages,
  };

  const file = path.join(INBOX, `${runId}.json`);
  if (!DRY) {
    fs.mkdirSync(INBOX, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
  }
  return { file, run };
}

/**
 * Fenêtre de collecte : une ligne plus ancienne que la fenêtre est ignorée.
 * `--window` l'emporte sur le canal, le temps d'une reprise d'historique.
 */
const windowBounds = (channel, runAt) => {
  const hours = WINDOW ?? channel.collection?.windowHours ?? 12;
  return { from: new Date(new Date(runAt) - hours * 36e5).toISOString(), to: runAt };
};

async function paliereA(channel) {
  const browser = channel?.browser ?? { family: 'edge', profile: null };
  const info = await withOwnedTab(
    {
      port: Number(process.env.MAILBOARD_CDP_PORT ?? browser.port ?? 9222),
      family: browser.family ?? 'edge',
      profile: browser.profile ?? null,
      allowedOrigins: ['about://', 'null'],
    },
    async (tab, meta) => {
      // Page neutre : la preuve d'attachement n'a besoin d'aucun compte.
      const url = await tab.url();
      return { ...meta, tabUrl: url };
    },
  );

  console.log(
    `Palier A — attachement confirmé.\n` +
      `  navigateur : ${info.product}\n` +
      `  profil     : ${info.profile}\n` +
      `  onglet     : créé sur ${info.tabUrl || 'about:blank'}, refermé ; aucun autre onglet touché.`,
  );
}

/**
 * Navigation déléguée à jev-ultrafast, dans un processus Python séparé.
 *
 * La frontière est nette : JEV choisit les actions jusqu'à la vue demandée, et
 * les sondes du fournisseur — le même JavaScript que la voie déterministe —
 * lisent la page une fois arrivée. Le modèle ne lit jamais la liste pour nous.
 */
function navigateWithJev({ channel, provider, probes, port }) {
  const driver = path.join(ROOT, 'collectors', 'browser-mail', 'jev_driver.py');
  const request = {
    cdpUrl: `http://127.0.0.1:${port}`,
    url: provider.INBOX_URL,
    goals: provider.NAV_GOALS ?? [],
    allowedOrigins: [provider.ORIGIN, ...(provider.AUTH_ORIGINS ?? [])],
    maxSteps: Number(option('--max-steps') ?? channel.browser?.maxSteps ?? 25),
    allowTypeText: false,
    probes,
  };

  const res = spawnSync(
    'uv',
    ['run', '--project', path.join(ROOT, 'collectors', 'browser-mail'), 'python', driver],
    { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );

  if (res.error) {
    throw new CollectorError('unavailable', `uv introuvable (${res.error.message}) — voir le README du collecteur`);
  }
  // Le pilote écrit son verdict sur une seule ligne JSON, en dernier.
  const ligne = (res.stdout ?? '').trim().split(/\r?\n/).pop();
  let out;
  try {
    out = JSON.parse(ligne);
  } catch {
    // stderr peut contenir une trace du harnais : on n'en garde qu'une ligne.
    const indice = (res.stderr ?? '').trim().split(/\r?\n/).pop()?.slice(0, 200) ?? '';
    throw new CollectorError('error', `pilote JEV illisible ${indice}`);
  }
  if (out.status !== 'ok') throw new CollectorError(out.status, out.message ?? 'navigation JEV échouée');
  return out;
}

/**
 * Collecte dont la navigation est décidée par JEV. Une seule vue est lue : la
 * pagination reste déterministe côté voie directe, parce que tourner douze
 * pages à coups de décisions de modèle coûterait douze appels pour un geste
 * qu'on sait décrire.
 */
async function collectViaJev({ channel, provider, criteria, runAt, folder, bounds, port, withContent }) {
  const maxItems = MAX ?? channel.collection?.maxItems ?? 100;
  const out = navigateWithJev({
    channel,
    provider,
    port,
    probes: {
      account: provider.PROBE.account,
      listReady: provider.PROBE.listReady,
      rows: provider.rowsExpression(maxItems, withContent),
    },
  });

  const account = out.probes.account ?? null;
  if (channel.accountHint && account !== channel.accountHint.toLowerCase()) {
    throw new CollectorError('wrong_account', `compte affiché ${account ?? 'illisible'}, attendu ${channel.accountHint}`);
  }

  const vue = out.probes.rows ?? {};
  const rows = (vue.rows ?? []).map((r) => ({
    ...r,
    date: provider.parseProtonDate(r.date ?? r.dateText),
    rawDate: r.date ?? null,
  }));
  const oldest = rows.map((r) => r.date).filter(Boolean).sort()[0] ?? null;

  const coverage = {
    folder,
    from: bounds.from,
    to: bounds.to,
    windowHours: WINDOW ?? channel.collection?.windowHours ?? 12,
    complete: Boolean(oldest && oldest < bounds.from),
    oldestSeen: oldest,
    itemsInspected: rows.length,
    selector: vue.selector ?? null,
    navigation: { engine: 'jev-ultrafast', steps: out.steps, url: out.url },
  };

  const messages = withContent
    ? rows
        .filter((row) => !row.date || row.date >= bounds.from)
        .map((row) => ({
          ...provider.identify(row, { sourceId: channel.sourceId, folder }, shortHash),
          date: row.date ?? runAt,
          from: row.from ?? '(inconnu)',
          subject: row.subject ?? '(sans objet)',
          summary: row.snippet ?? '',
          category: criteria.classify({ from: row.from ?? '', subject: row.subject ?? '', snippet: row.snippet ?? '' }).id,
        }))
    : [];

  const { file } = writeRun({
    channel,
    runAt,
    status: 'ok',
    note: `navigation jev-ultrafast : ${out.steps} action(s) jusqu'à la vue`,
    coverage,
    messages,
  });
  console.log(
    `Navigation JEV — vue atteinte en ${out.steps} action(s).
` +
      `  compte  : ${account ?? 'non lu'}
` +
      `  lignes  : ${rows.length}${withContent ? `, ${messages.length} retenue(s) dans la fenêtre` : ' (compteurs seuls)'}
` +
      `  run     : ${path.relative(ROOT, file)}`,
  );
}

async function collect(channel, { withContent }) {
  const provider = PROVIDERS[channel.provider];
  if (!provider) throw new CollectorError('error', `fournisseur non pris en charge : ${channel.provider}`);

  const criteria = loadCriteria();
  const runAt = new Date().toISOString();
  const folder = channel.collection?.folders?.[0] ?? 'inbox';
  const bounds = windowBounds(channel, runAt);
  const browser = channel.browser ?? {};

  const port = Number(process.env.MAILBOARD_CDP_PORT ?? browser.port ?? 9222);

  try {
    if (NAV === 'jev') {
      await collectViaJev({ channel, provider, criteria, runAt, folder, bounds, port, withContent });
      return;
    }

    const result = await withOwnedTab(
      {
        port,
        family: browser.family ?? 'edge',
        profile: browser.profile ?? null,
        allowedOrigins: [provider.ORIGIN, ...(provider.AUTH_ORIGINS ?? [])],
      },
      async (tab) => {
        const session = await provider.openInbox(tab, { accountHint: channel.accountHint });
        const list = await provider.readList(tab, {
          maxItems: MAX ?? channel.collection?.maxItems ?? 100,
          withContent,
          // Demander le bord de la fenêtre fait défiler la liste ; sans cela, on
          // ne lit que ce que le fournisseur a bien voulu rendre à l'écran.
          until: bounds.from,
          onPage: ({ page, collectees, ajoutees }) =>
            console.log(`  page ${page} — ${collectees} ligne(s) accumulée(s)${ajoutees === undefined ? '' : ` (+${ajoutees})`}`),
        });
        return { session, list };
      },
    );

    const { session, list } = result;

    // La liste Proton est virtualisée : « 50 lignes rendues » ne veut pas dire
    // « toute la boîte ». La couverture est complète quand on voit au moins une
    // ligne plus ancienne que la fenêtre — la preuve d'avoir atteint son bord.
    const oldest = list.rows.map((r) => r.date).filter(Boolean).sort()[0] ?? null;
    const coverage = {
      folder,
      from: bounds.from,
      to: bounds.to,
      windowHours: WINDOW ?? channel.collection?.windowHours ?? 12,
      complete: Boolean(list.reachedEdge ?? (oldest && oldest < bounds.from)),
      oldestSeen: oldest,
      itemsInspected: list.inspected,
      selector: list.selector,
    };

    if (!withContent) {
      // Palier B : on prouve l'accès, pas le contenu.
      const unread = list.rows.filter((r) => r.unread).length;
      const identified = list.rows.filter((r) => r.id).length;
      const { file } = writeRun({
        channel,
        runAt,
        status: 'ok',
        note: `observation : ${list.rows.length} ligne(s), ${identified} avec identifiant, ${unread} non lue(s)`,
        coverage,
        messages: [],
      });
      console.log(
        `Palier B — boîte atteinte.\n` +
          `  compte     : ${session.account ?? 'non lu'}\n` +
          `  sélecteur  : ${list.selector}\n` +
          `  lignes     : ${list.inspected} visible(s), ${identified} avec identifiant Proton, ${unread} non lue(s)\n` +
          `  run        : ${path.relative(ROOT, file)} (aucun objet, expéditeur ni extrait)`,
      );
      return;
    }

    const messages = [];
    let outOfWindow = 0;
    for (const row of list.rows) {
      if (row.date && row.date < bounds.from) {
        outOfWindow++;
        continue;
      }
      const identity = provider.identify(row, { sourceId: channel.sourceId, folder }, shortHash);
      const category = criteria.classify({ from: row.from ?? '', subject: row.subject ?? '', snippet: row.snippet ?? '' });
      messages.push({
        ...identity,
        date: row.date ?? runAt,
        from: row.from ?? '(inconnu)',
        subject: row.subject ?? '(sans objet)',
        // L'extrait Proton tient lieu de résumé : ouvrir le mail le marquerait
        // comme lu, donc modifierait le compte distant.
        summary: row.snippet ?? '',
        category: category.id,
      });
    }

    const { file } = writeRun({
      channel,
      runAt,
      status: 'ok',
      note: outOfWindow ? `${outOfWindow} ligne(s) hors fenêtre écartée(s)` : undefined,
      coverage,
      messages,
    });
    console.log(
      `Palier C — ${messages.length} message(s) retenu(s) sur ${list.inspected} ligne(s) lue(s).\n` +
        `  fenêtre : ${coverage.windowHours} h, bord ${coverage.complete ? 'atteint' : 'NON atteint'}\n` +
        `  run : ${path.relative(ROOT, file)}\n` +
        `  suite : node ingest/ingest.mjs`,
    );
  } catch (err) {
    // Une panne de canal est un run en échec, pas une absence de run : sans
    // cette trace, le dashboard croirait la boîte simplement silencieuse.
    const status = err instanceof CollectorError ? err.status : 'error';
    const { file } = writeRun({
      channel,
      runAt,
      status,
      note: err.message,
      coverage: { folder, from: bounds.from, to: bounds.to, complete: false, itemsInspected: 0 },
      messages: [],
    });
    console.error(`Collecte interrompue — ${status} : ${err.message}\n  run : ${path.relative(ROOT, file)}`);
    process.exitCode = 1;
  }
}

async function main() {
  const channels = loadChannels({ includeDisabled: true });
  const wanted = option('--source');

  if (CHECK) {
    // Le palier A n'a pas besoin d'un canal déclaré : il ne lit aucune boîte.
    await paliereA(wanted ? channels.byId.get(wanted) : null);
    return;
  }

  if (!wanted) {
    const names = channels.channels.map((c) => `${c.sourceId} (${c.provider}, ${c.enabled === false ? 'désactivé' : 'actif'})`);
    console.error(
      `--source <sourceId> est requis.\n` +
        (names.length ? `  canaux déclarés : ${names.join(', ')}` : `  aucun canal dans config/channels.local.json`),
    );
    process.exitCode = 1;
    return;
  }

  const channel = channels.byId.get(wanted);
  if (!channel) throw new CollectorError('error', `canal inconnu : ${wanted}`);
  if (channel.accessMode !== 'browser') {
    throw new CollectorError('error', `${wanted} n'est pas un canal browser (accessMode: ${channel.accessMode})`);
  }

  await collect(channel, { withContent: !OBSERVE });
}

// Ce fichier est aussi importé par ses tests : on ne s'exécute qu'en CLI.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof CollectorError ? `${err.status} : ${err.message}` : err);
    process.exitCode = 1;
  });
}

export { writeRun, windowBounds, shortHash };
