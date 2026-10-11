// node --test config/load.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPreferences } from './load.mjs';

// Le fichier versionné lui-même : ces tests gardent aussi la liste de mots.
const prefs = loadPreferences();

test('java bloque en mot entier, javascript non', () => {
  assert.equal(prefs.evaluate({ subject: 'Développeur Java - Angular H/F' }).blocked, true);
  assert.equal(prefs.evaluate({ subject: 'Développeur Angular - Jave Springboot H/F' }).blocked, true);
  const js = prefs.evaluate({ subject: 'Développeur JavaScript / TypeScript' });
  assert.equal(js.blocked, false);
  assert.ok(!js.con.includes('java'));
});

test('agent immobilier bloque et ne compte pas comme préférence IA', () => {
  const r = prefs.evaluate({ subject: 'Borne et Delaunay recherche Agent immobilier H/F' });
  assert.equal(r.blocked, true);
  assert.ok(r.con.includes('hors-metier'));
  assert.ok(!r.pro.includes('ia'));
  assert.equal(prefs.evaluate({ subject: 'Consultant immobilier F/H' }).blocked, true);
});

test('le corps d\'une offre unique peut bloquer', () => {
  const r = prefs.evaluate({ subject: 'Camille, Acme recrute un Développeur Full Stack H/F', body: 'Stack : Java 17, Spring Boot' });
  assert.equal(r.blocked, true);
  assert.equal(r.digest, false);
});

test('dans un digest, le corps baisse le score sans bloquer', () => {
  const subject = "Camille, JobBoard a trouvé 3 nouvelles offres d'emploi";
  const body = 'Développeur React H/F — Nice\nDéveloppeur Java H/F — Lyon';
  const r = prefs.evaluate({ subject, body });
  assert.equal(r.digest, true);
  assert.equal(r.blocked, false);
  assert.ok(r.con.includes('java'));
  assert.ok(!r.pro.includes('front-moderne'), 'le corps d\'un digest n\'ajoute pas de bonus');
  assert.ok(r.score < 0);
});

test('dans un digest, l\'objet bloque toujours', () => {
  const r = prefs.evaluate({ subject: 'Borne et Delaunay recherche Consultant immobilier F/H, et 33 autres' });
  assert.equal(r.digest, true);
  assert.equal(r.blocked, true);
});
