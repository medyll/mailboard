#!/usr/bin/env node
// Ingère les runs déposés dans data/runs-inbox/, déduplique par canal + id
// externe, alimente data/messages.jsonl + data/runs.jsonl, puis régénère
// dashboard/data.js. Critères de tri et canaux viennent de config/.
//
// Usage :
//   node ingest/ingest.mjs            ingère tout runs-inbox/ puis rebuild
//   node ingest/ingest.mjs --rebuild  rebuild dashboard/data.js seulement
//   node ingest/ingest.mjs --dry      montre ce qui serait fait, n'écrit rien
//   node ingest/ingest.mjs --jev      enrichit les nouveaux messages via JEV
//   node ingest/ingest.mjs --json     ajoute un résultat final lisible par le planificateur

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCriteria, loadChannels, loadJev, loadPreferences, messageKey } from '../config/load.mjs';
import { enrich } from './jev.mjs';

// Les tests bout en bout isolent les écritures dans un répertoire temporaire.
// Sans surcharge, le chemin historique du projet reste la seule cible.
const ROOT = process.env.MAILBOARD_ROOT
  ? path.resolve(process.env.MAILBOARD_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const INBOX = path.join(DATA, 'runs-inbox');
const ARCHIVE = path.join(DATA, 'runs-archive');
const MESSAGES = path.join(DATA, 'messages.jsonl');
const BODIES = path.join(DATA, 'bodies.jsonl');
const RUNS = path.join(DATA, 'runs.jsonl');
const JEV_LOG = path.join(DATA, 'jev-runs.jsonl');
const OUT = path.join(ROOT, 'dashboard', 'data.js');
const OUT_BODIES = path.join(ROOT, 'dashboard', 'bodies.js');

// Les catégories viennent de config/criteria.json : ajouter un critère là-bas
// suffit, l'ingesteur et le dashboard suivent. Les noms historiques restent
// lisibles grâce aux alias, sans réécrire messages.jsonl.
const criteria = loadCriteria();
const CATEGORIES = criteria.ids;

// Les préférences sont appliquées à la reconstruction, pas à l'ingestion :
// éditer config/preferences.json puis --rebuild réévalue tout l'historique,
// sans réécrire une seule ligne de data/.
const preferences = loadPreferences();

const BODY_MAX = 12000; // au-delà, on tronque : un mail emploi utile tient largement dedans

// Quand un collecteur ne fournit pas de lien, on le reconstruit. Le gabarit est
// une propriété du canal (channels.local.json), pas une constante de l'ingesteur ;
// ces valeurs ne servent que de repli pour les canaux non déclarés.
const channels = loadChannels({ includeDisabled: true });
const DEFAULT_LINK_TEMPLATES = { gmail: 'https://mail.google.com/mail/u/0/#all/{id}' };

const linkFor = (sourceId, provider, id) => {
  const template = channels.byId.get(sourceId)?.linkTemplate ?? DEFAULT_LINK_TEMPLATES[provider];
  return template && id ? template.replaceAll('{id}', id) : null;
};

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry');

// --dry coupe JEV sans condition : une simulation ne doit rien coûter.
const jev = loadJev({ cliFlag: argv.has('--jev'), dry: DRY });

for (const dir of [DATA, INBOX, ARCHIVE]) fs.mkdirSync(dir, { recursive: true });

const readJsonl = (file) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l, i) => {
          try {
            return JSON.parse(l);
          } catch {
            console.warn(`  ! ${path.basename(file)}:${i + 1} ligne illisible, ignorée`);
            return null;
          }
        })
        .filter(Boolean)
    : [];

const appendJsonl = (file, rows) => {
  if (!rows.length || DRY) return;
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
};

const rewriteJsonl = (file, rows) => {
  if (DRY) return;
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
};

// Entités nommées rencontrées dans les mails FR (le reste passe par les refs numériques).
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ',
  ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ',
  ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oelig: 'œ',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yuml: 'ÿ', szlig: 'ß',
  laquo: '«', raquo: '»', deg: '°', euro: '€', pound: '£', sect: '§',
  hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  ndash: '–', mdash: '—', bull: '•', middot: '·', times: '×', copy: '©', reg: '®', trade: '™',
};

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name) => {
      const lower = name.toLowerCase();
      const char = ENTITIES[lower];
      if (!char) return match;
      // &Eacute; → É : une entité capitalisée désigne la majuscule.
      return name[0] === name[0].toUpperCase() && lower !== name ? char.toUpperCase() : char;
    });
}

// Nettoie un corps de mail : HTML éventuel → texte, espaces normalisés, troncature.
function normalizeBody(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw;
  if (/<\/?(html|body|div|p|br|table|a)\b/i.test(text)) {
    text = text
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
  }
  text = decodeEntities(text)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();

  if (!text) return null;
  const truncated = text.length > BODY_MAX;
  return { text: truncated ? text.slice(0, BODY_MAX) : text, truncated };
}

// Part des messages dont le corps est stocké : la recherche plein texte n'a de
// valeur que si ce chiffre monte.
const bodyCoverage = (messages) => ({
  withBody: messages.filter((m) => m.hasBody).length,
  total: messages.length,
});

async function ingest() {
  const files = fs
    .readdirSync(INBOX)
    .filter((f) => f.endsWith('.json'))
    .sort();

  if (!files.length) {
    console.log('runs-inbox vide, rien à ingérer.');
    return { added: 0, dupes: 0, bodiesAdded: 0, runs: 0, sources: [], jev: null, bodyCoverage: bodyCoverage(readJsonl(MESSAGES)) };
  }

  // Un id externe n'est unique que dans son canal : la clé de déduplication est
  // sourceId + id. Les lignes écrites avant le multicanal retombent sur
  // gmail-legacy, ce qui préserve leur identité sans réécriture.
  const messages = readJsonl(MESSAGES);
  const byKey = new Map(messages.map((m) => [m.key ?? messageKey(m.sourceId, m.id), m]));
  const bodies = readJsonl(BODIES);
  const bodyByKey = new Map(bodies.map((b) => [b.key ?? messageKey(b.sourceId, b.id), b]));
  const runs = readJsonl(RUNS);
  const knownRuns = new Set(runs.map((r) => r.runId));

  let added = 0;
  let dupes = 0;
  let bodiesAdded = 0;
  let touched = false;
  const newMessages = [];
  const newBodies = [];
  const newRuns = [];
  const jevMetrics = [];

  // Les runs ne sont archivés qu'après l'enrichissement et les écritures : une
  // panne en cours de route laisse le fichier là où on saura le reprendre.
  const toArchive = [];

  for (const file of files) {
    const full = path.join(INBOX, file);
    let run;
    try {
      run = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (err) {
      console.error(`  ! ${file} : JSON invalide (${err.message}) — laissé dans runs-inbox`);
      continue;
    }

    const runId = path.basename(file, '.json');
    if (knownRuns.has(runId)) {
      console.log(`  = ${file} déjà ingéré, archivage`);
      toArchive.push([full, file]);
      continue;
    }

    const runAt = run.runAt || new Date().toISOString();
    const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
    let runAdded = 0;

    // Un run v1 (Gmail, avant le multicanal) n'annonce pas sa source.
    const source = run.source ?? { sourceId: 'gmail-legacy', provider: 'gmail', accessMode: 'connector' };
    const sourceId = source.sourceId ?? 'gmail-legacy';

    // Un run de rattrapage n'apporte que des corps pour des messages déjà
    // connus : ce n'est pas une observation de la boîte, il ne compte ni comme
    // réapparition ni comme run de couverture.
    const backfill = run.kind === 'backfill';
    let runBodies = 0;

    for (const raw of run.messages ?? []) {
      if (!raw?.id) {
        console.warn(`  ! ${file} : message sans id, ignoré`);
        continue;
      }
      const key = messageKey(sourceId, raw.id);
      const existing = byKey.get(key);
      if (backfill && !existing) {
        console.warn(`  ! ${file} : ${key} inconnu, corps de rattrapage ignoré`);
        continue;
      }

      // Un run ultérieur peut apporter le corps qu'un run précédent n'avait pas récupéré.
      const body = normalizeBody(raw.body);
      if (body && !bodyByKey.get(key)?.text) {
        const row = { key, id: raw.id, sourceId, text: body.text, truncated: body.truncated };
        bodyByKey.set(key, row);
        newBodies.push(row);
        bodiesAdded++;
        runBodies++;
      }
      const hasBody = Boolean(bodyByKey.get(key)?.text);

      if (backfill) {
        if (hasBody && !existing.hasBody) {
          existing.hasBody = true;
          touched = true;
        }
        continue;
      }

      const category = criteria.resolveCategory(raw.category);
      counts[category]++;

      if (existing) {
        existing.lastSeenAt = runAt;
        existing.seenCount = (existing.seenCount ?? 1) + 1;
        if (hasBody) existing.hasBody = true;
        dupes++;
        continue;
      }

      const msg = {
        key,
        id: raw.id,
        sourceId,
        provider: source.provider ?? null,
        // provider-id > conversation-id > empreinte : le dashboard peut signaler
        // qu'une ligne repose sur une identité reconstruite.
        identityQuality: raw.identityQuality ?? 'provider-id',
        threadId: raw.threadId ?? null,
        category,
        date: raw.date ?? runAt,
        from: raw.from ?? '(inconnu)',
        subject: raw.subject ?? '(sans objet)',
        summary: raw.summary ?? '',
        link: raw.link ?? linkFor(sourceId, source.provider, raw.id),
        hasBody,
        runId,
        firstSeenAt: runAt,
        lastSeenAt: runAt,
        seenCount: 1,
      };
      if (raw.jev) msg.jev = raw.jev;
      byKey.set(key, msg);
      newMessages.push(msg);
      added++;
      runAdded++;
    }

    if (backfill) {
      console.log(`  ~ ${file} : rattrapage, ${runBodies} corps ajouté(s) / ${(run.messages ?? []).length} fourni(s)`);
      toArchive.push([full, file]);
      continue;
    }

    newRuns.push({
      runId,
      runAt,
      source: { ...source, sourceId },
      collector: run.collector ?? null,
      coverage: run.coverage ?? null,
      windowHours: run.windowHours ?? null,
      queries: run.queries ?? {},
      returned: (run.messages ?? []).length,
      added: runAdded,
      counts,
    });

    console.log(`  + ${file} : ${runAdded} nouveau(x) / ${(run.messages ?? []).length} retourné(s)`);
    toArchive.push([full, file]);
  }

  // Enrichissement : après identification des nouveaux messages, avant toute
  // écriture. Un échec devient un statut porté par le message, pas une
  // interruption du run.
  const jevStats = await enrich(newMessages, jev, {
    criteria,
    preferences: preferences.entries.length ? preferences.digest() : null,
    onMetric: (m) => jevMetrics.push({ ...m, at: new Date().toISOString() }),
  });

  // lastSeenAt/seenCount ont pu changer sur des lignes existantes → réécriture complète
  if (dupes > 0 || touched) rewriteJsonl(MESSAGES, [...byKey.values()]);
  else appendJsonl(MESSAGES, newMessages);
  appendJsonl(BODIES, newBodies);
  appendJsonl(RUNS, newRuns);
  appendJsonl(JEV_LOG, jevMetrics);

  for (const [full, file] of toArchive) {
    if (!DRY) fs.renameSync(full, path.join(ARCHIVE, file));
  }

  return {
    added,
    dupes,
    bodiesAdded,
    runs: newRuns.length,
    sources: newRuns.map((run) => ({
      sourceId: run.source.sourceId,
      status: run.collector?.status ?? 'ok',
    })),
    jev: jevStats,
    bodyCoverage: bodyCoverage([...byKey.values()]),
  };
}

function rebuild() {
  // Les alias sont appliqués à la lecture : renommer un critère change ce que
  // montre le dashboard sans toucher aux lignes déjà écrites sur disque.
  const messages = readJsonl(MESSAGES)
    .map((m) => ({
      ...m,
      key: m.key ?? messageKey(m.sourceId, m.id),
      sourceId: m.sourceId ?? 'gmail-legacy',
      category: criteria.resolveCategory(m.category),
      prefs: preferences.evaluate({ from: m.from, subject: m.subject, summary: m.summary }),
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const runs = readJsonl(RUNS).sort((a, b) => (a.runAt < b.runAt ? 1 : -1));

  // Fraîcheur par canal : un « dernier run » global masquerait une boîte en
  // panne derrière une autre source qui tourne encore.
  const sources = new Map();
  for (const r of runs) {
    const id = r.source?.sourceId ?? 'gmail-legacy';
    const seen = sources.get(id);
    if (!seen || seen.lastRunAt < r.runAt) {
      sources.set(id, {
        sourceId: id,
        provider: r.source?.provider ?? null,
        accessMode: r.source?.accessMode ?? null,
        lastRunAt: r.runAt,
        lastStatus: r.collector?.status ?? 'ok',
        runs: 0,
      });
    }
    sources.get(id).runs++;
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    criteriaUpdatedAt: criteria.raw.updatedAt ?? null,
    categories: CATEGORIES,
    categoryMeta: criteria.categories,
    preferenceLabels: preferences.labels,
    sources: [...sources.values()].sort((a, b) => (a.lastRunAt < b.lastRunAt ? 1 : -1)),
    messages,
    runs,
  };
  const js = `// Généré par ingest/ingest.mjs — ne pas éditer à la main.\nwindow.MAILBOARD = ${JSON.stringify(payload, null, 2)};\n`;
  if (!DRY) fs.writeFileSync(OUT, js);

  // Les corps vivent dans un second fichier, chargé à part par le dashboard :
  // l'index reste léger même quand l'historique grossit.
  const bodies = Object.fromEntries(
    readJsonl(BODIES).map((b) => [b.key ?? messageKey(b.sourceId, b.id), { text: b.text, truncated: b.truncated }]),
  );
  const bodiesJs = `// Généré par ingest/ingest.mjs — ne pas éditer à la main.\nwindow.MAILBOARD_BODIES = ${JSON.stringify(bodies)};\nwindow.dispatchEvent(new Event('mailboard:bodies'));\n`;
  if (!DRY) fs.writeFileSync(OUT_BODIES, bodiesJs);

  const kb = Math.round(Buffer.byteLength(bodiesJs) / 1024);
  console.log(
    `dashboard/data.js : ${messages.length} message(s), ${runs.length} run(s).\n` +
      `dashboard/bodies.js : ${Object.keys(bodies).length} corps (${kb} Ko).`,
  );
}

const stats = argv.has('--rebuild') ? null : await ingest();
rebuild();
if (stats) {
  console.log(
    `\n${stats.runs} run(s) ingéré(s) — ${stats.added} nouveau(x), ${stats.dupes} doublon(s) écarté(s), ${stats.bodiesAdded} corps stocké(s).`,
  );

  // Métriques séparées : un enrichissement muet coûterait du réseau sans rien
  // apprendre. Latence, codes d'erreur et tokens sont aussi écrits dans
  // data/jev-runs.jsonl, sans jamais de clé ni de contenu de message.
  const j = stats.jev;
  if (j?.called) {
    const codes = Object.entries(j.byCode)
      .map(([c, n]) => `${c}×${n}`)
      .join(', ');
    console.log(
      `JEV ${jev.model} — ${j.ok}/${j.called} ok${j.errors ? ` (${codes})` : ''}, ` +
        `${j.ok ? Math.round(j.latencyMs / j.ok) : 0} ms en moyenne, ` +
        `${j.inputTokens + j.outputTokens} token(s).`,
    );
  } else if (stats.added) {
    console.log(`JEV : ${jev.status} — ${stats.added} message(s) non évalué(s).`);
  }

  if (argv.has('--json')) {
    console.log(
      JSON.stringify({
        type: 'mailboard.ingest.result',
        runs: stats.runs,
        added: stats.added,
        dupes: stats.dupes,
        bodiesAdded: stats.bodiesAdded,
        bodyCoverage: stats.bodyCoverage,
        sources: stats.sources,
      }),
    );
  }
}
if (DRY) console.log('(--dry : aucune écriture, aucun appel JEV)');
