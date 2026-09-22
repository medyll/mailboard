// Dashboard Mailboard — lit window.MAILBOARD (généré par ingest/ingest.mjs).
// L'état « traité » est local au navigateur (localStorage), il ne remonte pas dans data/.

const DATA = window.MAILBOARD ?? { messages: [], runs: [], categories: [], generatedAt: null };

// Libellés et couleurs viennent de config/criteria.json via data.js : ajouter un
// critère ne demande aucune retouche ici ni dans style.css. Les anciennes
// générations de data.js n'ont pas categoryMeta — on retombe sur l'id.
const META = new Map((DATA.categoryMeta ?? []).map((c) => [c.id, c]));

// Préférences : ce que l'on veut, par opposition au CV qui dit ce que l'on sait
// faire. Le libellé vient de config/preferences.json via data.js.
const PREF_LABELS = DATA.preferenceLabels ?? {};
const prefLabel = (id) => PREF_LABELS[id] ?? id;
const dark = window.matchMedia?.('(prefers-color-scheme: dark)');
const labelOf = (id) => META.get(id)?.label ?? id;
const toneOf = (id) => {
  const color = META.get(id)?.color;
  if (!color) return `var(--${id}, var(--muted))`;
  return dark?.matches ? color.dark ?? color.light : color.light ?? color.dark;
};

// bodies.js est chargé à part (et à la demande) : l'index reste léger, et une balise
// <script> injectée fonctionne aussi bien en file:// qu'en http, contrairement à fetch.
const bodies = {
  map: null,
  loading: false,
  get(id) {
    return this.map?.[id]?.text ?? null;
  },
  truncated(id) {
    return Boolean(this.map?.[id]?.truncated);
  },
  load() {
    if (this.map || this.loading) return;
    this.loading = true;
    const tag = document.createElement('script');
    tag.src = 'bodies.js';
    tag.onload = () => {
      this.map = window.MAILBOARD_BODIES ?? {};
      this.loading = false;
      renderMessages();
    };
    tag.onerror = () => {
      this.map = {};
      this.loading = false;
      console.warn('bodies.js introuvable — lancer `node ingest/ingest.mjs --rebuild`');
    };
    document.head.appendChild(tag);
  },
};

const store = {
  read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* mode privé, stockage bloqué : on continue sans persistance */
    }
  },
};

// Avant le multicanal, « traité » était mémorisé sous l'id Gmail nu. On ajoute
// la forme canonique pour ne pas rouvrir d'un coup tout ce qui était classé.
const done = new Set(
  store.read('mailboard.done', []).flatMap((k) => (k.includes(':') ? [k] : [k, `gmail-legacy:${k}`])),
);
const state = {
  category: null,
  source: null,
  query: '',
  hideDone: store.read('mailboard.hideDone', false),
  hideBlocked: store.read('mailboard.hideBlocked', false),
  expanded: new Set(),
};

const $ = (id) => document.getElementById(id);
const fmtDate = (iso) =>
  new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function relative(iso) {
  const h = (Date.now() - new Date(iso)) / 36e5;
  if (h < 1) return "il y a moins d'une heure";
  if (h < 24) return `il y a ${Math.round(h)} h`;
  return `il y a ${Math.round(h / 24)} j`;
}

function visible() {
  const q = state.query.trim().toLowerCase();
  return DATA.messages.filter((m) => {
    if (state.category && m.category !== state.category) return false;
    if (state.source && m.sourceId !== state.source) return false;
    if (state.hideDone && done.has(m.key)) return false;
    // Masquer reste un geste de l'utilisateur : une préférence ne supprime
    // jamais un message d'elle-même.
    if (state.hideBlocked && m.prefs?.blocked) return false;
    if (!q) return true;
    const haystack = `${m.from} ${m.subject} ${m.summary} ${bodies.get(m.key) ?? ''}`;
    return haystack.toLowerCase().includes(q);
  });
}

function highlight(text, query) {
  const safe = escapeHtml(text);
  const q = query.trim();
  if (!q) return safe;
  const pattern = new RegExp(escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return safe.replace(pattern, (hit) => `<mark>${hit}</mark>`);
}

// Extrait du corps autour de la première occurrence, pour situer un résultat de recherche.
function snippet(id, query) {
  const text = bodies.get(id);
  if (!text) return null;
  const i = text.toLowerCase().indexOf(query.trim().toLowerCase());
  if (i < 0) return null;
  const start = Math.max(0, i - 60);
  const end = Math.min(text.length, i + query.length + 90);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function renderFreshness() {
  const last = DATA.runs[0];
  $('freshness').textContent = last
    ? `Dernier run ${fmtDate(last.runAt)} (${relative(last.runAt)}) · ${DATA.messages.length} message(s) suivis`
    : 'Aucun run ingéré pour le moment.';
}

function renderKpis() {
  const since = Date.now() - 7 * 864e5;
  const week = DATA.messages.filter((m) => new Date(m.date) >= since);
  const counts = Object.fromEntries(DATA.categories.map((c) => [c, 0]));
  for (const m of week) counts[m.category] = (counts[m.category] ?? 0) + 1;

  const cards = [
    { label: '7 derniers jours', value: week.length, tone: 'var(--accent)' },
    ...DATA.categories.map((c) => ({ label: labelOf(c), value: counts[c] ?? 0, tone: toneOf(c) })),
    { label: 'À traiter', value: DATA.messages.filter((m) => !done.has(m.key)).length, tone: 'var(--muted)' },
  ];

  $('kpis').innerHTML = cards
    .map((c) => `<article class="kpi" style="--tone:${c.tone}"><b>${c.value}</b><span>${c.label}</span></article>`)
    .join('');
}

function renderCoverage() {
  const runs = DATA.runs.slice(0, 60).reverse();
  $('coverage').innerHTML = runs
    .map((r) => {
      const h = r.added ? Math.min(100, 20 + r.added * 20) : 8;
      return `<i style="height:${h}%" data-empty="${r.added ? 0 : 1}" title="${fmtDate(r.runAt)} — ${r.added} nouveau(x) sur ${r.returned} retourné(s)"></i>`;
    })
    .join('');
  $('coverage-hint').textContent = runs.length
    ? `${runs.length} derniers runs · gris = run sans nouveauté`
    : 'aucun run';
}

function renderFilters() {
  const buttons = [{ key: null, label: 'Tout', tone: 'var(--accent)' }].concat(
    DATA.categories.map((c) => ({ key: c, label: labelOf(c), tone: toneOf(c) })),
  );
  $('filters').innerHTML = buttons
    .map(
      (b) =>
        `<button class="chip" type="button" style="--tone:${b.tone}" data-cat="${b.key ?? ''}" aria-pressed="${state.category === b.key}">${b.label}</button>`,
    )
    .join('');
}

/** Étiquettes de préférence : ce qui attire, ce qui repousse, et pourquoi. */
function prefTags(m) {
  const p = m.prefs;
  if (!p || (!p.pro?.length && !p.con?.length)) return '';
  const tag = (id, kind) => `<span class="pref pref-${kind}">${escapeHtml(prefLabel(id))}</span>`;
  return (
    `<div class="prefs">` +
    (p.con ?? []).map((id) => tag(id, 'con')).join('') +
    (p.pro ?? []).map((id) => tag(id, 'pro')).join('') +
    `</div>`
  );
}

function renderMessages() {
  const rows = visible();
  $('count-hint').textContent = `${rows.length} affiché(s) sur ${DATA.messages.length}`;
  $('empty').hidden = rows.length > 0;
  const q = state.query;
  $('messages').innerHTML = rows
    .map((m) => {
      const open = state.expanded.has(m.key);
      const body = bodies.get(m.key);
      const hit = q ? snippet(m.key, q) : null;
      return `
      <li data-done="${done.has(m.key) ? 1 : 0}" data-open="${open ? 1 : 0}" style="--tone:${toneOf(m.category)}">
        <div>
          <button class="msg-open" type="button" data-expand="${m.key}" aria-expanded="${open}">
            <span class="caret">${open ? '▾' : '▸'}</span>
            <span class="msg-subject">${highlight(m.subject, q)}</span>
          </button>
          <div class="msg-meta">${highlight(m.from, q)} · ${labelOf(m.category)}${m.hasBody ? '' : ' · <em>corps non capturé</em>'}</div>
          ${prefTags(m)}
          ${m.summary ? `<div class="msg-summary">${highlight(m.summary, q)}</div>` : ''}
          ${hit && !open ? `<div class="msg-hit">${highlight(hit, q)}</div>` : ''}
          ${
            open
              ? body
                ? `<pre class="msg-body">${highlight(body, q)}</pre>${bodies.truncated(m.key) ? '<p class="hint">(corps tronqué à l\'ingestion)</p>' : ''}`
                : `<p class="hint msg-body-empty">${bodies.map ? 'Aucun corps stocké pour ce message.' : 'Chargement…'}</p>`
              : ''
          }
        </div>
        <div class="msg-side">
          <time datetime="${m.date}">${fmtDate(m.date)}</time>
          ${m.link ? `<a href="${m.link}" target="_blank" rel="noopener">${m.provider === 'gmail' || !m.provider ? 'Gmail' : m.provider}</a>` : ''}
          <button type="button" data-toggle="${m.key}">${done.has(m.key) ? 'Rouvrir' : 'Traité'}</button>
        </div>
      </li>`;
    })
    .join('');
}

function renderSources() {
  const known = new Map((DATA.sources ?? []).map((source) => [source.sourceId, source.provider]));
  for (const message of DATA.messages) {
    if (!known.has(message.sourceId)) known.set(message.sourceId, message.provider);
  }

  $('source-filter').innerHTML = [
    '<option value="">Toutes les sources</option>',
    ...[...known.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sourceId, provider]) =>
        `<option value="${escapeHtml(sourceId)}">${escapeHtml(sourceId)}${provider ? ` (${escapeHtml(provider)})` : ''}</option>`,
      ),
  ].join('');
}

function escapeHtml(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function renderAll() {
  renderFreshness();
  renderKpis();
  renderCoverage();
  renderFilters();
  renderSources();
  renderMessages();
}

// --- interactions -----------------------------------------------------------

$('filters').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-cat]');
  if (!btn) return;
  state.category = btn.dataset.cat || null;
  renderFilters();
  renderMessages();
});

$('messages').addEventListener('click', (e) => {
  const expand = e.target.closest('[data-expand]');
  if (expand) {
    const id = expand.dataset.expand;
    state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
    bodies.load();
    renderMessages();
    return;
  }

  const btn = e.target.closest('[data-toggle]');
  if (!btn) return;
  const id = btn.dataset.toggle;
  done.has(id) ? done.delete(id) : done.add(id);
  store.write('mailboard.done', [...done]);
  renderKpis();
  renderMessages();
});

$('search').addEventListener('input', (e) => {
  state.query = e.target.value;
  if (state.query.trim()) bodies.load(); // la recherche couvre le corps dès qu'il est là
  renderMessages();
});

$('source-filter').addEventListener('change', (e) => {
  state.source = e.target.value || null;
  renderMessages();
});

const hideBlocked = $('hide-blocked');
hideBlocked.checked = state.hideBlocked;
hideBlocked.addEventListener('change', (e) => {
  state.hideBlocked = e.target.checked;
  store.write('mailboard.hideBlocked', state.hideBlocked);
  renderMessages();
});

const hideDone = $('hide-done');
hideDone.checked = state.hideDone;
hideDone.addEventListener('change', (e) => {
  state.hideDone = e.target.checked;
  store.write('mailboard.hideDone', state.hideDone);
  renderMessages();
});

const theme = store.read('mailboard.theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.dataset.theme = theme;
$('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.write('mailboard.theme', next);
});

renderAll();
