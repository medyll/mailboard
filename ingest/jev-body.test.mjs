// node --test ingest/jev-body.test.mjs
//
// Gabarits relevés sur la vraie boîte (Hellowork, Indeed), anonymisés.

import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanBody } from './jev-body.mjs';

const HELLOWORK = [
  'Hello Camille !',
  '2 nouvelles offres',
  'correspondent à votre profil.',
  'Développeur Node.Js H/F',
  'CELAD Super recruteur',
  'Biot - 06',
  'CDI',
  "Voir l’offre",
  'Développeur Node.Js H/F',
  'IRTISH Consulting Pte Ltd vous propose une offre d’emploi !',
  'SARL RUFF & ASSOCIES — Collaborateur comptable — 39000 €',
  'Voir toutes les offres',
  'https://www.hellowork.com/fr-fr/emplois/123.html',
  'Téléchargez notre application',
  'Espace candidat',
  'Conformément au règlement général sur la protection des données, vous pouvez exercer vos droits.',
  'Hellowork SASU • 2 rue de la Mabilais • 35000 RENNES',
].join('\n');

const INDEED = [
  'Malheureusement, votre candidature n’a pas été retenue.',
  'Si vous répondez directement à cet email, votre message ne sera pas transmis à l’employeur.',
  'Contact : camille.martin@example.test ou +33 6 12 34 56 78',
  'Gardez votre profil Indeed à jour',
  'Camille Martin',
  'Salaire de base minimum',
  '45 000 € par an',
  '© 2026 Indeed Ireland Operations Limited, Block B, Capital Dock',
].join('\n');

test('garde le contenu, retire boutons, liens, pied de page et adresse légale', () => {
  const out = cleanBody(HELLOWORK);
  assert.match(out, /Développeur Node\.Js H\/F/);
  assert.match(out, /Biot - 06/);
  assert.match(out, /IRTISH Consulting Pte Ltd vous propose/, 'une forme sociale sans adresse reste');
  assert.match(out, /SARL RUFF & ASSOCIES — Collaborateur comptable — 39000 €/, 'un salaire n’est pas une adresse');
  for (const noise of ['Hello Camille', 'Voir l’offre', 'Voir toutes les offres', 'https://', 'Téléchargez', 'Espace candidat', 'Conformément', 'SASU']) {
    assert.ok(!out.includes(noise), `bruit restant : ${noise}`);
  }
  assert.equal(out.match(/Développeur Node\.Js H\/F/g).length, 1, 'une offre répétée ne part qu’une fois');
});

test('retire le bloc profil Indeed et masque les identifiants', () => {
  const out = cleanBody(INDEED, { terms: ['Camille', 'Martin'] });
  assert.match(out, /Malheureusement, votre candidature n’a pas été retenue\./);
  assert.ok(!/Salaire de base minimum|45 000/.test(out), 'le salaire souhaité ne part pas');
  assert.ok(!/Camille|Martin/.test(out));
  assert.ok(!out.includes('ne sera pas transmis'));
  assert.match(out, /\[email\]/);
  assert.match(out, /\[téléphone\]/);
});

test('un marqueur de pied de page en tête ne coupe pas le mail', () => {
  const text = ['Si vous ne souhaitez plus recevoir nos offres, répondez STOP', 'Entretien proposé mardi 14 h', 'Merci de confirmer'].join('\n');
  const out = cleanBody(text);
  assert.match(out, /Entretien proposé mardi 14 h/);
  assert.match(out, /Merci de confirmer/);
});

test('la limite de taille s’applique après nettoyage', () => {
  const padded = `${'Politique de confidentialité\n'.repeat(200)}Offre : Lead développeur React`;
  assert.equal(cleanBody(padded, { maxChars: 100 }), 'Offre : Lead développeur React');
  assert.equal(cleanBody(''), '');
});
