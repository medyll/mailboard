// Étiquetage JEV à l'aveugle : on répond aux mêmes questions que le modèle,
// sans voir sa réponse. Elle n'est révélée qu'après l'enregistrement, pour
// ne pas biaiser le jugement. Les étiquettes partent dans data/jev-labels.json
// via le serveur local (node settings/server.mjs) ; en file://, rien ne s'écrit.

const $ = (id) => document.getElementById(id);
const DATA = window.MAILBOARD ?? { messages: [] };
const BODIES = window.MAILBOARD_BODIES ?? {};
const RUNTIME = window.MAILBOARD_SETTINGS ?? { enabled: false };

const theme = (() => {
  try {
    return localStorage.getItem('mailboard.theme');
  } catch {
    return null;
  }
})();
document.documentElement.dataset.theme = JSON.parse(theme ?? 'null') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

let questions = [];
let labels = {};
let queue = [];
let current = null;
let answers = {};
// Vrai dès qu'une réponse a été touchée : le rapport repère ainsi les lots
// enregistrés sans lecture.
let edited = false;
const skipped = new Set();

const api = (method, body) =>
  fetch('/api/labels', {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Mailboard-Token': RUNTIME.token },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    const payload = await r.json();
    if (!r.ok) throw new Error((payload.errors ?? [payload.error]).join(' ; '));
    return payload;
  });

// Hachage stable : un ordre « aléatoire » identique d'une session à l'autre.
const hash = (s) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

/**
 * Ordre de passage : d'abord ce que JEV juge rare ou important (c'est là que
 * se cachent les erreurs coûteuses), puis un échantillon mélangé du reste
 * pour mesurer aussi les faux positifs sur le tout-venant.
 */
function tier(m) {
  const a = m.jev.answers;
  if (a.eventKind && a.eventKind.value !== 'information') return 0;
  if ((a.needsReply?.probability ?? 0) >= 0.5 || (a.hasDeadline?.probability ?? 0) >= 0.5) return 1;
  return 2;
}

function buildQueue() {
  queue = DATA.messages
    .filter((m) => m.jev?.status === 'ok' && !labels[m.key] && !skipped.has(m.key))
    .sort((a, b) => tier(a) - tier(b) || hash(a.key) - hash(b.key));
}

function defaults(m) {
  // Valeurs neutres, jamais celles de JEV. Les choix restent vides
  // (undefined, distinct du « ? » qui vaut null) : un premier lot validé à la
  // chaîne sur Entrée a montré qu'un choix prérempli finit enregistré sans
  // avoir été lu.
  const out = {};
  for (const q of visibleQuestions(m)) {
    if (q.primitive === 'noul') out[q.id] = false;
    else if (q.primitive === 'choice') out[q.id] = undefined;
    else out[q.id] = q.requiresProfile ? null : 0;
  }
  return out;
}

const missingChoice = () => visibleQuestions(current).filter((q) => q.primitive === 'choice' && answers[q.id] === undefined);

// Les questions de fit ne sont posées à JEV que pour certains critères : on
// suit ce qu'il a reçu, sans regarder ce qu'il a répondu.
const visibleQuestions = (m) => questions.filter((q) => !q.requiresProfile || q.id in (m.jev.answers ?? {}));

function choices(q) {
  if (q.primitive === 'noul') return [[true, 'Yes'], [false, 'No']];
  if (q.primitive === 'choice') {
    const opts = Array.isArray(q.options) ? Object.fromEntries(q.options.map((o) => [o, o])) : q.options;
    return Object.entries(opts);
  }
  return q.levels.map((label, i) => [i, `${i} · ${label}`]);
}

function renderForm() {
  const form = $('form');
  form.replaceChildren();
  for (const q of visibleQuestions(current)) {
    const row = document.createElement('labeling-question');
    const title = document.createElement('p');
    title.textContent = q.text;
    const group = document.createElement('group-control');
    for (const [value, label] of [...choices(q), [null, '?']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = value === null ? 'Don’t know / not applicable' : String(value);
      b.setAttribute('aria-pressed', String(answers[q.id] === value));
      b.addEventListener('click', () => {
        answers[q.id] = value;
        edited = true;
        notice('');
        renderForm();
      });
      group.append(b);
    }
    row.append(title, group);
    form.append(row);
  }
}

function render() {
  const done = Object.keys(labels).length;
  const total = DATA.messages.filter((m) => m.jev?.status === 'ok').length;
  $('progress').textContent = `${done} labeled out of ${total} — ${queue.length} left. Aim for ~60 for a first calibration.`;

  current = queue[0] ?? null;
  for (const id of ['card', 'form', 'footer']) $(id).hidden = !current;
  if (!current) {
    notice('Nothing left to label. Run: node ingest/jev-agreement.mjs');
    return;
  }

  answers = defaults(current);
  edited = false;
  $('meta').textContent = `${current.date?.slice(0, 10)} · ${current.sourceId} · ${current.category} · ${current.from}`;
  $('subject').textContent = current.subject;
  $('summary').textContent = current.summary || '(no summary)';
  const body = BODIES[current.key]?.text;
  $('body-box').hidden = !body;
  $('body').textContent = body ?? '';
  renderForm();
}

function reveal(m, mine) {
  const box = $('reveal');
  const rows = visibleQuestions(m).map((q) => {
    const j = m.jev.answers[q.id];
    const theirs = q.primitive === 'noul' ? j?.probability : j?.value;
    const disagree =
      mine[q.id] !== null &&
      (q.primitive === 'noul' ? (theirs >= 0.5) !== mine[q.id] : q.primitive === 'choice' ? theirs !== mine[q.id] : Math.abs(theirs - mine[q.id]) >= 1);
    return `<li>${disagree ? '≠' : '='} <b>${q.id}</b>: you ${mine[q.id]} · JEV ${theirs}${j?.confidence != null ? ` (conf. ${j.confidence})` : ''}</li>`;
  });
  box.innerHTML = `Previous — <i></i><ul>${rows.join('')}</ul>`;
  box.querySelector('i').textContent = m.subject;
  box.hidden = false;
}

async function save() {
  if (!current) return;
  const missing = missingChoice();
  if (missing.length) {
    notice(`Pick an answer for: ${missing.map((q) => q.id).join(', ')} ("?" if unsure).`);
    return;
  }
  const m = current;
  const mine = { ...answers };
  try {
    await api('PUT', { key: m.key, answers: mine, edited });
    labels[m.key] = { answers: mine };
    queue.shift();
    reveal(m, mine);
    render();
  } catch (err) {
    notice(`Save failed: ${err.message}`);
  }
}

function skip() {
  if (!current) return;
  skipped.add(current.key);
  queue.shift();
  render();
}

function notice(text) {
  $('notice').textContent = text;
  $('notice').hidden = !text;
}

$('save').addEventListener('click', save);
$('skip').addEventListener('click', skip);
document.addEventListener('keydown', (e) => {
  // Touche maintenue = répétition automatique : jamais une décision.
  if (e.repeat || e.target.closest?.('input, textarea, select')) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    save();
  } else if (e.key === 's' || e.key === 'S') skip();
});

if (!RUNTIME.enabled) {
  notice('Page opened without the server: run "node settings/server.mjs" then open http://127.0.0.1:4177/labeling-component/labeling-component.html');
  $('progress').textContent = 'read-only';
} else {
  api('GET')
    .then((payload) => {
      questions = payload.questions;
      labels = payload.labels;
      buildQueue();
      render();
    })
    .catch((err) => notice(`Loading failed: ${err.message}`));
}
