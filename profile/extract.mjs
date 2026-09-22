#!/usr/bin/env node
// CV → cache Markdown, puis digest anonymisé destiné à JEV.
//
//   node profile/extract.mjs           extrait si la source a changé
//   node profile/extract.mjs --force   réextrait quoi qu'il arrive
//   node profile/extract.mjs --show    affiche le digest qui serait envoyé
//
// Deux fichiers sortent d'ici, tous deux ignorés par Git :
//
//   profile/profile.cache.md   texte intégral, ne quitte jamais la machine
//   profile/profile.jev.md     digest expurgé, seul fichier transmis au modèle
//
// La séparation est le point important : juger l'adéquation d'une offre demande
// des compétences et un niveau, pas un nom, un téléphone ni une adresse.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const CACHE = path.join(HERE, 'profile.cache.md');
const DIGEST = path.join(HERE, 'profile.jev.md');
const MANUAL = path.join(HERE, 'profile.md'); // rédigé à la main : prioritaire sur le PDF
const REDACT_LIST = path.join(HERE, 'redact.local.txt');

const argv = new Set(process.argv.slice(2));
const FORCE = argv.has('--force');
const MAX_CHARS = Number(process.env.MAILBOARD_PROFILE_MAX_CHARS ?? 4000);

/** Source du profil : variable d'env, profile.md manuscrit, sinon le premier PDF déposé. */
function findSource() {
  const fromEnv = process.env.MAILBOARD_PROFILE_SOURCE;
  if (fromEnv) return { file: path.resolve(ROOT, fromEnv), kind: path.extname(fromEnv).toLowerCase() };
  if (fs.existsSync(MANUAL)) return { file: MANUAL, kind: '.md' };
  const pdf = fs
    .readdirSync(HERE)
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .sort()[0];
  return pdf ? { file: path.join(HERE, pdf), kind: '.pdf' } : null;
}

function pdfToText(file) {
  // pdftotext (poppler) est fourni par Git for Windows, MacPorts, la plupart des
  // distributions. Aucune dépendance npm n'est ajoutée au projet pour si peu.
  const res = spawnSync('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    throw new Error(
      `pdftotext indisponible ou en échec (${res.error?.message ?? `code ${res.status}`}).\n` +
        `  Installer poppler, ou déposer un profil rédigé à la main dans ${path.relative(ROOT, MANUAL)}.`,
    );
  }
  return res.stdout;
}

/** Retire ce qui identifie une personne sans rien apprendre sur son métier. */
function redact(text) {
  let out = text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{1,4}\)?[\s.-]?){3,6}\d{2,4}/g, (m) =>
      (m.replace(/\D/g, '').length >= 9 ? '[téléphone]' : m),
    )
    .replace(/https?:\/\/\S+/g, '[lien]')
    .replace(/\b\d{5}\b\s+[A-ZÉÈÀÂÎÔÛ][\wÀ-ÿ-]+/g, '[ville]')
    .replace(/\b(?:\d{1,4}\s+)?(?:rue|avenue|boulevard|impasse|chemin|allée)\s+[^\n,]{2,40}/gi, '[adresse]');

  // Littéraux à retirer en plus (nom, employeurs sensibles…), un par ligne.
  // Fichier local et facultatif : il contient des données personnelles.
  if (fs.existsSync(REDACT_LIST)) {
    for (const line of fs.readFileSync(REDACT_LIST, 'utf8').split('\n')) {
      const term = line.trim();
      if (term.length < 2 || term.startsWith('#')) continue;
      out = out.replaceAll(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[retiré]');
    }
  }
  return out;
}

/**
 * Digest : ce qui sert à juger une offre. On garde les sections utiles au fit et
 * on coupe le reste, plutôt que de tronquer aveuglément au milieu d'une phrase.
 */
function digest(text) {
  const clean = redact(text)
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, arr) => l || arr[i - 1]) // pas plus d'une ligne vide d'affilée
    .join('\n')
    .trim();

  if (clean.length <= MAX_CHARS) return clean;

  // Au-delà de la limite, on privilégie profil et compétences : c'est là que se
  // trouvent les langages et le niveau, donc la réponse aux questions de fit.
  const keep = /(PROFIL|COMPÉTENCES|COMPETENCES|SKILLS|EXPÉRIENCE|EXPERIENCE|FORMATION)/i;
  const blocks = clean.split(/\n{2,}/).map((text, index) => ({ text, index }));
  const byPriority = [...blocks].sort((a, b) => Number(keep.test(b.text)) - Number(keep.test(a.text)));

  const picked = [];
  let size = 0;
  for (const block of byPriority) {
    if (size + block.text.length + 2 > MAX_CHARS) continue;
    picked.push(block);
    size += block.text.length + 2;
  }
  // Sélection par priorité, restitution dans l'ordre du CV : un digest qui se lit
  // encore comme un parcours, pas comme un sac de paragraphes.
  return picked
    .sort((a, b) => a.index - b.index)
    .map((b) => b.text)
    .join('\n\n');
}

function main() {
  const source = findSource();
  if (!source || !fs.existsSync(source.file)) {
    console.error(
      `Aucun profil trouvé.\n` +
        `  Déposer un CV PDF dans ${path.relative(ROOT, HERE)}/, ou un ${path.basename(MANUAL)} rédigé à la main.`,
    );
    process.exit(1);
  }

  const bytes = fs.readFileSync(source.file);
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);

  const existing = fs.existsSync(CACHE) ? fs.readFileSync(CACHE, 'utf8') : '';
  if (!FORCE && existing.includes(`sourceHash: ${hash}`) && fs.existsSync(DIGEST)) {
    console.log(`Profil à jour (${path.basename(source.file)}, ${hash}). --force pour réextraire.`);
    if (argv.has('--show')) console.log(`\n${fs.readFileSync(DIGEST, 'utf8')}`);
    return;
  }

  const text = source.kind === '.pdf' ? pdfToText(source.file) : fs.readFileSync(source.file, 'utf8');
  if (!text.trim()) throw new Error(`Extraction vide pour ${path.basename(source.file)}`);

  const now = new Date().toISOString();
  const head = (title, extra) =>
    `---\n${title}\nsource: ${path.basename(source.file)}\nsourceHash: ${hash}\nextractedAt: ${now}\n${extra}---\n\n`;

  fs.writeFileSync(
    CACHE,
    head('kind: profile-cache', `tool: ${source.kind === '.pdf' ? 'pdftotext' : 'copie'}\nwords: ${text.split(/\s+/).length}\n`) +
      text.trim() +
      '\n',
  );

  const sent = digest(text);
  fs.writeFileSync(
    DIGEST,
    head('kind: profile-digest', `redacted: true\nmaxChars: ${MAX_CHARS}\nchars: ${sent.length}\n`) +
      sent +
      '\n',
  );

  console.log(
    `${path.basename(source.file)} → ${path.relative(ROOT, CACHE)} (${text.split(/\s+/).length} mots)\n` +
      `            → ${path.relative(ROOT, DIGEST)} (${sent.length} car., expurgé)`,
  );
  if (argv.has('--show')) console.log(`\n${sent}`);
}

try {
  main();
} catch (err) {
  console.error(`profil : ${err.message}`);
  process.exit(1);
}
