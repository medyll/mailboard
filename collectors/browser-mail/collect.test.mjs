// node --test collectors/browser-mail/collect.test.mjs
//
// Ce qui se teste sans navigateur : forme du run, fenêtre de collecte, identité
// et classement local. Les sélecteurs Proton, eux, se vérifient dans un vrai
// DOM — providers/proton.fixture.html, ouvert via un serveur statique.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CollectorError, STATUSES } from './errors.mjs';
import { identify, openInbox, parseProtonDate, INBOX_URL } from './providers/proton.mjs';
import { loadCriteria } from '../../config/load.mjs';

// Le module lit argv à l'import : --dry garantit qu'aucun run de test n'atterrit
// dans data/runs-inbox/.
process.argv.push('--dry');
const { writeRun, windowBounds, shortHash } = await import('./collect.mjs');

const channel = {
  sourceId: 'proton-perso',
  channelKind: 'mailbox',
  accessMode: 'browser',
  provider: 'proton',
  browser: { family: 'edge' },
  collection: { windowHours: 12, maxItems: 100 },
};

test('un échec produit quand même un run, avec son statut', () => {
  const { run, file } = writeRun({
    channel,
    runAt: '2026-09-22T19:00:00.000Z',
    status: 'needs_user',
    note: 'session expirée',
    coverage: { folder: 'inbox', complete: false, itemsInspected: 0 },
    messages: [],
  });

  assert.equal(run.schemaVersion, 2);
  assert.equal(run.collector.status, 'needs_user');
  assert.equal(run.source.sourceId, 'proton-perso');
  assert.deepEqual(run.messages, []);
  assert.match(file, /run-\d{8}-\d{4}--proton-perso\.json$/);
  // Un run nommé par sa source : deux canaux sur la même fenêtre ne se écrasent pas.
  assert.ok(!file.includes('undefined'));
});

test('le run ne transporte aucun secret ni chemin de profil', () => {
  const { run } = writeRun({
    channel: { ...channel, accountHint: 'user-03@example.test', browser: { family: 'edge', profile: 'Default' } },
    runAt: '2026-09-22T19:00:00.000Z',
    status: 'ok',
    coverage: { folder: 'inbox', complete: true, itemsInspected: 3 },
    messages: [],
  });
  const dump = JSON.stringify(run);
  assert.ok(!dump.includes('Default'), 'le profil navigateur reste local');
  assert.equal(run.collector.browser, 'edge');
});

test('fenêtre de collecte dérivée du canal', () => {
  const { from, to } = windowBounds(channel, '2026-09-22T19:00:00.000Z');
  assert.equal(to, '2026-09-22T19:00:00.000Z');
  assert.equal(from, '2026-09-22T07:00:00.000Z');
});

test('empreinte de repli : stable, distincte par canal et par ligne', () => {
  const row = { date: '2026-09-21T08:00:00.000Z', from: 'Newsletter', subject: 'Svelte 6' };
  const a = identify(row, { sourceId: 'proton-perso', folder: 'inbox' }, shortHash);
  const b = identify(row, { sourceId: 'proton-perso', folder: 'inbox' }, shortHash);
  const autreCanal = identify(row, { sourceId: 'gmail-browser', folder: 'inbox' }, shortHash);
  const autreObjet = identify({ ...row, subject: 'Svelte 7' }, { sourceId: 'proton-perso', folder: 'inbox' }, shortHash);

  assert.equal(a.identityQuality, 'fingerprint');
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, autreCanal.id);
  assert.notEqual(a.id, autreObjet.id);
});

test('un identifiant fourni par le fournisseur prime sur l empreinte', () => {
  const out = identify({ id: 'msg-aaa', subject: 'x' }, { sourceId: 'proton-perso', folder: 'inbox' }, shortHash);
  assert.deepEqual(out, { id: 'msg-aaa', identityQuality: 'provider-id' });
});

test('un statut inconnu retombe sur error plutôt que de passer en douce', () => {
  assert.equal(new CollectorError('n_importe_quoi', 'x').status, 'error');
  for (const s of STATUSES) assert.equal(new CollectorError(s, 'x').status, s);
});

test('classement local : le domaine déclaré tranche', () => {
  const criteria = loadCriteria();
  const ft = criteria.classify({ from: 'France Travail <test@francetravail.fr>', subject: 'Bonjour' });
  assert.equal(ft.id, 'france-travail');
  assert.equal(ft.reason, 'domaine');
});

test('classement local : à défaut de domaine, les mots-clés', () => {
  const criteria = loadCriteria();
  const emploi = criteria.classify({ from: 'Nora <user-04@example.test>', subject: 'Mission freelance React', snippet: 'poste à pourvoir' });
  assert.equal(emploi.id, 'emploi');

  const rien = criteria.classify({ from: 'ami@example.com', subject: 'Déjeuner jeudi ?' });
  assert.equal(rien.id, 'autre');
  assert.equal(rien.reason, 'aucun critère');
});

test('classement local : un sous-domaine du domaine déclaré compte aussi', () => {
  const criteria = loadCriteria();
  assert.equal(criteria.classify({ from: 'test@mail.francetravail.fr', subject: 'rien' }).id, 'france-travail');
});

/**
 * Onglet simulé : `navigate` rend l'URL d'atterrissage, `eval` rend une réponse
 * par sonde. Assez pour exercer les décisions de openInbox sans navigateur.
 */
const fakeTab = (landed, answers = {}) => ({
  navigate: async () => landed,
  url: async () => landed,
  eval: async (expression) => {
    if (expression.includes('unlockForm')) return answers.needsUser ?? false;
    if (expression.includes('userdropdown')) return answers.account ?? null;
    if (expression.includes('data-element-id')) return answers.rowCount ?? { selector: '[data-element-id]', count: 3 };
    return null;
  },
});

test('redirection vers le SSO Proton : needs_user, pas une sortie de périmètre', async () => {
  // Constaté sur la vraie page : sans session, mail.proton.me renvoie vers
  // account.proton.me. Traiter ça en `error` ferait passer une déconnexion
  // pour une panne du collecteur.
  await assert.rejects(
    () => openInbox(fakeTab('https://account.proton.me/login'), { accountHint: 'user-03@example.test', settleTries: 2, settleMs: 1 }),
    (err) => err.status === 'needs_user',
  );
});

test('formulaire de connexion dans la page : needs_user', async () => {
  await assert.rejects(
    () => openInbox(fakeTab(INBOX_URL, { needsUser: true }), { accountHint: 'user-03@example.test' }),
    (err) => err.status === 'needs_user',
  );
});

test('compte affiché différent : wrong_account avant toute lecture', async () => {
  await assert.rejects(
    () => openInbox(fakeTab(INBOX_URL, { account: 'user-06@example.test' }), { accountHint: 'user-03@example.test' }),
    (err) => err.status === 'wrong_account' && /user-06@example\.test/.test(err.message),
  );
});

test('compte illisible alors qu il est exigé : wrong_account', async () => {
  await assert.rejects(
    () => openInbox(fakeTab(INBOX_URL, { account: null }), { accountHint: 'user-03@example.test' }),
    (err) => err.status === 'wrong_account',
  );
});

test('aucune ligne reconnue : partial, pas une boîte vide', async () => {
  await assert.rejects(
    () => openInbox(fakeTab(INBOX_URL, { account: 'user-03@example.test', rowCount: { selector: null, count: 0 } }), {
      accountHint: 'user-03@example.test',
    }),
    (err) => err.status === 'partial',
  );
});

test('compte attendu : la boîte est déclarée ouverte', async () => {
  const session = await openInbox(fakeTab(INBOX_URL, { account: 'user-03@example.test' }), { accountHint: 'user-03@example.test' });
  assert.equal(session.account, 'user-03@example.test');
  assert.equal(session.visibleRows, 3);
});

test('date Proton : le datetime localisé est converti, pas recopié', () => {
  // Constaté sur la vraie boîte : <time datetime> contient « mardi 22 septembre
  // 2026 à 11:45 », pas de l ISO. Sans conversion, la fenêtre de collecte
  // comparait des chaînes de texte et ne filtrait plus rien.
  const iso = parseProtonDate('mardi 22 septembre 2026 à 11:45');
  assert.match(iso, /^2026-09-22T\d{2}:45:00\.000Z$/);
  assert.ok(iso < parseProtonDate('mardi 22 septembre 2026 à 12:45'));
});

test('date Proton : mois accentués et valeur ISO déjà propre', () => {
  assert.match(parseProtonDate('3 février 2026 à 09:07'), /^2026-02-03T/);
  assert.match(parseProtonDate('12 décembre 2025 à 23:59'), /^2025-12-1[23]T/);
  assert.equal(parseProtonDate('2026-09-22T16:42:00.000Z'), '2026-09-22T16:42:00.000Z');
});

test('date Proton : illisible reste nulle plutôt qu inventée', () => {
  for (const v of ['Hier', 'il y a 2 h', '', null, undefined, 'mardi 22 brumaire 2026']) {
    assert.equal(parseProtonDate(v), null, `${v} devrait rester nul`);
  }
});
