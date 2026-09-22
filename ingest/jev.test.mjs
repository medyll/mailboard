// node --test ingest/jev.test.mjs
//
// L'adaptateur est testé contre un faux serveur : ce qui compte est ce qui part
// (jamais d'id ni de lien), ce qui est accepté en retour, et le fait qu'une
// panne devienne un statut plutôt qu'une exception.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { enrich, buildState, senderDomain, fingerprint } from './jev.mjs';

const QUESTIONS = [
  { id: 'needsReply', primitive: 'noul', text: 'Demande une réponse ?' },
  {
    id: 'eventKind',
    primitive: 'choice',
    text: 'Quel événement ?',
    options: { invitation: 'Entretien proposé', other: 'Autre cas' },
  },
  { id: 'attention', primitive: 'score', text: 'Attention requise ?', levels: ['aucune', 'faible', 'forte'] },
  { id: 'roleFit', primitive: 'score', text: 'Adéquation au profil ?', levels: ['nulle', 'partielle', 'nette'], requiresProfile: true },
];

const OK_BODY = {
  model: 'jev-1.13.0',
  answers: {
    needsReply: { type: 'noul', noul: 0.94 },
    eventKind: { type: 'choice', choice: 'invitation', confidence: 0.91, probabilities: { invitation: 0.91, other: 0.09 } },
    attention: { type: 'score', score: 1.7, confidence: 0.76 },
    roleFit: { type: 'score', score: 1.9, confidence: 0.8 },
  },
  usage: { input_tokens: 312, output_tokens: 48 },
};

const message = () => ({
  key: 'gmail-primary:demo-1',
  id: 'demo-1',
  category: 'emploi',
  from: 'Recrutement ACME <user-07@example.test>',
  subject: 'Proposition d entretien',
  summary: 'Deux créneaux proposés.',
  link: 'https://mail.google.com/mail/u/0/#all/demo-1',
  date: '2026-09-22T16:42:00.000Z',
});

/** Faux System One. `handler` décide du statut et du corps ; `seen` garde la charge utile. */
function server(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      seen.push({ body: JSON.parse(raw), auth: req.headers.authorization });
      const { status, body, delayMs } = await handler(seen.length);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      res.writeHead(status, { 'content-type': 'application/json', 'x-typesafe-request-id': 'req_test' });
      res.end(JSON.stringify(body ?? {}));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () =>
      resolve({ seen, url: `http://127.0.0.1:${srv.address().port}/v1/systemone`, close: () => srv.close() }),
    );
  });
}

const config = (url, over = {}) => ({
  enabled: true,
  status: 'ok',
  endpoint: url,
  model: 'jev-latest',
  apiKey: 'clé-de-test',
  questions: QUESTIONS,
  questionSet: 'test-v1',
  // Large : le premier appel HTTP d'un runner CI froid dépasse parfois 500 ms.
  // Le test de timeout fixe sa propre valeur.
  timeoutMs: 5000,
  concurrency: 2,
  profile: { send: false, file: null, maxChars: 4000 },
  ...over,
});

test('état minimal : ni id, ni lien, ni date, et seulement le domaine', () => {
  const state = buildState(message());
  assert.deepEqual(Object.keys(state.message).sort(), ['currentCategory', 'senderDomain', 'subject', 'summary']);
  assert.equal(state.message.senderDomain, 'example.test');
  assert.ok(!JSON.stringify(state).includes('demo-1'));
  assert.ok(!JSON.stringify(state).includes('mail.google.com'));
  assert.ok(!JSON.stringify(state).includes('rh@'));
});

test('empreinte stable et sensible au contenu', () => {
  const a = fingerprint(buildState(message()));
  assert.equal(a, fingerprint(buildState(message())));
  assert.notEqual(a, fingerprint(buildState({ ...message(), subject: 'Autre objet' })));
});

test('senderDomain accepte les deux formes d adresse', () => {
  assert.equal(senderDomain('user-07@example.test'), 'example.test');
  assert.equal(senderDomain('ACME <user-07@example.test>'), 'example.test');
  assert.equal(senderDomain('(inconnu)'), null);
});

test('réponse conforme : bloc jev complet, tokens et latence relevés', async () => {
  const s = await server(() => ({ status: 200, body: OK_BODY }));
  const msg = message();
  const stats = await enrich([msg], config(s.url), { criteria: { profileMatchIds: ['emploi'] } });
  s.close();

  assert.equal(msg.jev.status, 'ok');
  assert.equal(msg.jev.model, 'jev-1.13.0');
  assert.equal(msg.jev.questionSet, 'test-v1');
  assert.equal(msg.jev.requestId, 'req_test');
  assert.match(msg.jev.inputFingerprint, /^sha256:[0-9a-f]{32}$/);
  assert.equal(msg.jev.answers.needsReply.probability, 0.94);
  assert.equal(msg.jev.answers.eventKind.value, 'invitation');
  assert.equal(msg.jev.answers.attention.value, 1.7);
  assert.equal(stats.inputTokens + stats.outputTokens, 360);

  // La clé ne doit apparaître que dans l'en-tête, jamais dans le bloc persisté.
  assert.equal(s.seen[0].auth, 'Bearer clé-de-test');
  assert.ok(!JSON.stringify(msg.jev).includes('clé-de-test'));
});

test('un seul appel porte toutes les questions', async () => {
  const s = await server(() => ({ status: 200, body: OK_BODY }));
  await enrich([message()], config(s.url), { criteria: { profileMatchIds: ['emploi'] } });
  s.close();
  assert.equal(s.seen.length, 1);
  assert.deepEqual(Object.keys(s.seen[0].body.questions).sort(), ['attention', 'eventKind', 'needsReply', 'roleFit']);
  assert.equal(s.seen[0].body.questions.eventKind.criteria.invitation, 'Entretien proposé');
  assert.deepEqual(s.seen[0].body.questions.attention.criteria, ['aucune', 'faible', 'forte']);
});

test('les questions de fit ne partent pas pour un critère sans profileMatch', async () => {
  const s = await server(() => ({ status: 200, body: { ...OK_BODY, answers: { ...OK_BODY.answers, roleFit: undefined } } }));
  const msg = { ...message(), category: 'france-travail' };
  await enrich([msg], config(s.url), { criteria: { profileMatchIds: ['emploi'] } });
  s.close();
  assert.ok(!('roleFit' in s.seen[0].body.questions));
  assert.equal(msg.jev.status, 'ok');
});

test('option hors contrat : erreur, pas de repli silencieux vers other', async () => {
  const body = { ...OK_BODY, answers: { ...OK_BODY.answers, eventKind: { type: 'choice', choice: 'inconnu', confidence: 0.4 } } };
  const s = await server(() => ({ status: 200, body }));
  const msg = message();
  await enrich([msg], config(s.url), { criteria: { profileMatchIds: ['emploi'] } });
  s.close();
  assert.equal(msg.jev.status, 'error');
  assert.equal(msg.jev.code, 'invalid_response');
  assert.ok(!msg.jev.answers);
});

for (const [status, code] of [
  [401, 'unauthorized'],
  [429, 'rate_limited'],
  [529, 'unavailable'],
  [422, 'invalid_response'],
]) {
  test(`HTTP ${status} → code ${code}, le message reste ingérable`, async () => {
    const s = await server(() => ({ status, body: { error: 'peu importe' } }));
    const msg = message();
    const stats = await enrich([msg], config(s.url), { criteria: { profileMatchIds: ['emploi'] } });
    s.close();
    assert.equal(msg.jev.status, 'error');
    assert.equal(msg.jev.code, code);
    assert.equal(stats.errors, 1);
    assert.equal(msg.subject, 'Proposition d entretien');
  });
}

test('timeout : un seul essai, statut error', async () => {
  const s = await server(() => ({ status: 200, body: OK_BODY, delayMs: 200 }));
  const msg = message();
  await enrich([msg], config(s.url, { timeoutMs: 50 }), { criteria: { profileMatchIds: ['emploi'] } });
  s.close();
  assert.equal(msg.jev.code, 'timeout');
  assert.equal(s.seen.length, 1, 'aucun retry : un timeout peut déjà avoir été facturé');
});

test('intégration désactivée : aucun appel, statut skipped', async () => {
  const s = await server(() => ({ status: 200, body: OK_BODY }));
  const msg = message();
  const stats = await enrich([msg], config(s.url, { enabled: false, status: 'skipped:no-key' }), {});
  s.close();
  assert.equal(s.seen.length, 0);
  assert.equal(msg.jev.status, 'skipped');
  assert.equal(msg.jev.reason, 'skipped:no-key');
  assert.equal(stats.called, 0);
});

test('concurrence bornée : jamais plus d appels en vol que configuré', async () => {
  let inFlight = 0;
  let peak = 0;
  const s = await server(async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 30));
    inFlight--;
    return { status: 200, body: OK_BODY };
  });
  const batch = Array.from({ length: 8 }, (_, i) => ({ ...message(), key: `k${i}` }));
  await enrich(batch, config(s.url, { concurrency: 2 }), { criteria: { profileMatchIds: ['emploi'] } });
  s.close();
  assert.ok(peak <= 2, `pic de ${peak} appels simultanés`);
  assert.ok(batch.every((m) => m.jev.status === 'ok'));
});

test('les préférences accompagnent l état, sans rien révéler de plus', async () => {
  const s = await server(() => ({ status: 200, body: OK_BODY }));
  const msg = message();
  await enrich([msg], config(s.url), {
    criteria: { profileMatchIds: ['emploi'] },
    preferences: { wants: 'Node.js / TypeScript, Lead', avoids: 'Java / J2EE (rédhibitoire), Python' },
  });
  s.close();

  const envoye = s.seen[0].body.state;
  assert.equal(envoye.candidatePreferences.avoids, 'Java / J2EE (rédhibitoire), Python');
  // Les préférences sont des intentions, pas une identité : l état minimal le reste.
  const dump = JSON.stringify(envoye);
  assert.ok(!dump.includes('demo-1'));
  assert.ok(!dump.includes('mail.google.com'));
});

test('sans préférences déclarées, rien n est ajouté à l état', async () => {
  const s = await server(() => ({ status: 200, body: OK_BODY }));
  await enrich([message()], config(s.url), { criteria: { profileMatchIds: ['emploi'] } });
  s.close();
  assert.ok(!('candidatePreferences' in s.seen[0].body.state));
});
