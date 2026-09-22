(() => {
  const runtime = window.MAILBOARD_SETTINGS ?? { enabled: false, token: null };
  const component = document.getElementById('settings');
  const openButton = document.getElementById('settings-open');
  const nav = component.querySelector('settings-nav');
  const content = component.querySelector('settings-content');
  const status = document.getElementById('settings-status');
  const saveButton = document.getElementById('settings-save');
  const reloadButton = document.getElementById('settings-reload');
  const cancelButton = document.getElementById('settings-cancel');
  const tabs = [
    ['criteria', 'Collecte'],
    ['preferences', 'Préférences'],
    ['jev', 'JEV'],
    ['system', 'Système'],
  ];
  const view = { tab: 'criteria', settings: null, original: null, dirty: false, errors: [], timer: null };

  if (!runtime.enabled) {
    openButton.dataset.readonly = 'true';
    openButton.title = 'Lancer `node settings/server.mjs`, puis ouvrir l’adresse affichée.';
  }

  const clone = (value) => structuredClone(value);
  const escapeHtml = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const escapeAttr = escapeHtml;
  const getAt = (root, path) => path.split('.').reduce((value, key) => value?.[key], root);
  const setAt = (root, path, value) => {
    const keys = path.split('.');
    const leaf = keys.pop();
    const owner = keys.reduce((current, key) => current[key], root);
    owner[leaf] = value;
  };
  const lines = (value) => (Array.isArray(value) ? value.join('\n') : '');
  const optionsText = (value) =>
    Object.entries(value ?? {})
      .map(([key, description]) => `${key} = ${description}`)
      .join('\n');
  const parseOptions = (value) =>
    Object.fromEntries(
      value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf('=');
          return separator < 0 ? [line, ''] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
        }),
    );

  const request = async (pathname, options = {}) => {
    const response = await fetch(pathname, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Mailboard-Token': runtime.token,
        ...(options.headers ?? {}),
      },
    });
    const payload = await response.json();
    if (!response.ok && response.status !== 422) throw new Error(payload.error ?? 'Le service de réglages ne répond pas.');
    return { response, payload };
  };

  const setStatus = (message, tone = '') => {
    status.textContent = message;
    status.dataset.tone = tone;
  };

  const renderNav = () => {
    nav.innerHTML = tabs
      .map(
        ([id, label]) =>
          `<button type="button" data-settings-tab="${id}" aria-current="${view.tab === id ? 'page' : 'false'}">${label}</button>`,
      )
      .join('');
  };

  const field = (label, control, wide = false) =>
    `<settings-field${wide ? ' data-wide="true"' : ''}><label>${escapeHtml(label)}</label>${control}</settings-field>`;
  const input = (path, value, type = 'text', extra = '') =>
    `<input type="${type}" data-bind="${escapeAttr(path)}" value="${escapeAttr(value)}" ${extra} />`;
  const textarea = (path, value, kind = '', extra = '') =>
    `<textarea data-bind="${escapeAttr(path)}"${kind ? ` data-value-kind="${kind}"` : ''} ${extra}>${escapeHtml(value)}</textarea>`;
  const checkbox = (path, checked, label) =>
    `<label class="settings-check"><input type="checkbox" data-bind="${escapeAttr(path)}" ${checked ? 'checked' : ''} /> ${escapeHtml(label)}</label>`;
  const select = (path, value, options) =>
    `<select data-bind="${escapeAttr(path)}">${options
      .map(([id, label]) => `<option value="${escapeAttr(id)}" ${id === value ? 'selected' : ''}>${escapeHtml(label)}</option>`)
      .join('')}</select>`;

  const errorSummary = () => {
    if (!view.errors.length) return '';
    return `<ul class="settings-errors">${view.errors
      .slice(0, 8)
      .map((error) => `<li>${escapeHtml(error.message)}${error.path ? ` <small>(${escapeHtml(error.path)})</small>` : ''}</li>`)
      .join('')}</ul>`;
  };

  const cardActions = (kind, index, length) => `
    <div class="settings-card-actions">
      <button type="button" data-move="${kind}" data-index="${index}" data-direction="-1" ${index === 0 ? 'disabled' : ''} aria-label="Monter">↑</button>
      <button type="button" data-move="${kind}" data-index="${index}" data-direction="1" ${index === length - 1 ? 'disabled' : ''} aria-label="Descendre">↓</button>
      <button class="settings-delete" type="button" data-remove="${kind}" data-index="${index}">Supprimer</button>
    </div>`;

  function renderCriteria() {
    const config = view.settings.criteria;
    const cards = config.criteria
      .map((criterion, index) => {
        const base = `criteria.criteria.${index}`;
        return `<settings-card>
          <settings-card-header><strong>${escapeHtml(criterion.label || criterion.id || 'Nouveau critère')}</strong>${cardActions('criterion', index, config.criteria.length)}</settings-card-header>
          <settings-fields>
            ${field('Identifiant', input(`${base}.id`, criterion.id))}
            ${field('Libellé', input(`${base}.label`, criterion.label))}
            ${field('État', checkbox(`${base}.enabled`, criterion.enabled !== false, 'Critère activé'))}
            ${field('Adéquation au profil', checkbox(`${base}.profileMatch`, Boolean(criterion.profileMatch), 'Évaluer le profil'))}
            ${field('Description', textarea(`${base}.description`, criterion.description ?? ''), true)}
            ${field('Requête Gmail', textarea(`${base}.queries.gmail`, criterion.queries?.gmail ?? ''), true)}
            ${field('Requête Proton', textarea(`${base}.queries.proton`, criterion.queries?.proton ?? ''), true)}
            ${field('Mots-clés, un par ligne', textarea(`${base}.queries.keywords`, lines(criterion.queries?.keywords), 'lines'), true)}
            ${field('Domaines expéditeurs, un par ligne', textarea(`${base}.queries.fromDomains`, lines(criterion.queries?.fromDomains), 'lines'), true)}
          </settings-fields>
        </settings-card>`;
      })
      .join('');

    return `<settings-section>
      <h3>Collecte</h3>
      <p>Définissez la fenêtre commune et les requêtes exécutées par chaque fournisseur.</p>
      ${errorSummary()}
      <settings-card><settings-fields>
        ${field('Fenêtre de collecte (heures)', input('criteria.defaults.windowHours', config.defaults?.windowHours ?? 12, 'number', 'min="1" max="720"'))}
        ${field('Catégorie de repli', input('criteria.fallback.label', config.fallback?.label ?? 'Autre'))}
      </settings-fields></settings-card>
      <div class="settings-section-head"><h4>Critères</h4><span class="hint">${config.criteria.length} configuré(s)</span></div>
      ${cards}
      <button class="settings-add" type="button" data-add="criterion">+ Ajouter un critère</button>
    </settings-section>`;
  }

  function renderPreferences() {
    const config = view.settings.preferences;
    const cards = config.preferences
      .map((preference, index) => {
        const base = `preferences.preferences.${index}`;
        return `<settings-card>
          <settings-card-header><strong>${escapeHtml(preference.label || preference.id || 'Nouvelle préférence')}</strong>${cardActions('preference', index, config.preferences.length)}</settings-card-header>
          <settings-fields>
            ${field('Identifiant', input(`${base}.id`, preference.id))}
            ${field('Libellé', input(`${base}.label`, preference.label))}
            ${field('Effet', select(`${base}.kind`, preference.kind, [['pro', 'Pro'], ['con', 'Con']]))}
            ${field('Force', select(`${base}.strength`, preference.strength, [['blocker', 'Rédhibitoire'], ['strong', 'Forte'], ['mild', 'Légère']]))}
            ${field('État', checkbox(`${base}.enabled`, preference.enabled !== false, 'Préférence activée'))}
            ${field('Note', textarea(`${base}.note`, preference.note ?? ''), true)}
            ${field('Mots-clés, un par ligne', textarea(`${base}.match.keywords`, lines(preference.match?.keywords), 'lines'), true)}
          </settings-fields>
        </settings-card>`;
      })
      .join('');
    return `<settings-section>
      <h3>Préférences</h3>
      <p>Les pros attirent, les cons repoussent. Une préférence rédhibitoire signale l’offre sans la supprimer.</p>
      ${errorSummary()}
      <settings-card><settings-fields>
        ${field('Poids rédhibitoire', input('preferences.weights.blocker', config.weights?.blocker ?? 4, 'number', 'min="0"'))}
        ${field('Poids fort', input('preferences.weights.strong', config.weights?.strong ?? 2, 'number', 'min="0"'))}
        ${field('Poids léger', input('preferences.weights.mild', config.weights?.mild ?? 1, 'number', 'min="0"'))}
      </settings-fields></settings-card>
      <div class="settings-section-head"><h4>Règles</h4><span class="hint">${config.preferences.length} configurée(s)</span></div>
      ${cards}
      <button class="settings-add" type="button" data-add="preference">+ Ajouter une préférence</button>
    </settings-section>`;
  }

  function renderJev() {
    const config = view.settings.jev;
    const thresholds = Object.entries(config.thresholds ?? {})
      .filter(([key]) => !key.startsWith('$'))
      .map(([key, value]) => field(key, input(`jev.thresholds.${key}`, value ?? '', 'number', 'step="0.01" min="0" max="1" data-nullable-number="true"')))
      .join('');
    const cards = config.questions
      .map((question, index) => {
        const base = `jev.questions.${index}`;
        const specific =
          question.primitive === 'choice'
            ? field('Options : clé = description', textarea(`${base}.options`, optionsText(question.options), 'options'), true)
            : question.primitive === 'score'
              ? field('Niveaux, un par ligne', textarea(`${base}.levels`, lines(question.levels), 'lines'), true)
              : '';
        return `<settings-card>
          <settings-card-header><strong>${escapeHtml(question.id || 'Nouvelle question')}</strong>${cardActions('question', index, config.questions.length)}</settings-card-header>
          <settings-fields>
            ${field('État', checkbox(`${base}.enabled`, question.enabled !== false, 'Question activée'))}
            ${field('Profil', checkbox(`${base}.requiresProfile`, Boolean(question.requiresProfile), 'Profil requis'))}
            ${field('Identifiant', input(`${base}.id`, question.id))}
            ${field('Primitive', select(`${base}.primitive`, question.primitive, [['noul', 'noul'], ['choice', 'choice'], ['score', 'score']]))}
            ${field('Question', textarea(`${base}.text`, question.text ?? ''), true)}
            ${field('Usage', input(`${base}.usage`, question.usage ?? ''), true)}
            ${specific}
          </settings-fields>
        </settings-card>`;
      })
      .join('');
    return `<settings-section>
      <h3>JEV</h3>
      <p>Configurez l’appel métier et les objets envoyés au modèle. La clé API reste dans l’environnement.</p>
      ${errorSummary()}
      <settings-card><settings-fields>
        ${field('État', checkbox('jev.enabled', Boolean(config.enabled), 'Activer JEV'))}
        ${field('Modèle', input('jev.model', config.model ?? 'jev-latest'))}
        ${field('Jeu de questions', input('jev.questionSet', config.questionSet ?? 'mailboard-v1'))}
        ${field('Endpoint', input('jev.endpoint', config.endpoint ?? '', 'url'), true)}
        ${field('Timeout (ms)', input('jev.timeoutMs', config.timeoutMs ?? 8000, 'number', 'min="500" max="120000"'))}
        ${field('Concurrence', input('jev.concurrency', config.concurrency ?? 4, 'number', 'min="1" max="20"'))}
        ${field('Essais supplémentaires', input('jev.retriesPerRun', config.retriesPerRun ?? 0, 'number', 'min="0" max="5"'))}
        ${field('Profil', checkbox('jev.profile.send', Boolean(config.profile?.send), 'Envoyer le profil expurgé'))}
        ${field('Taille du profil', input('jev.profile.maxChars', config.profile?.maxChars ?? 4000, 'number', 'min="500"'))}
      </settings-fields></settings-card>
      <div class="settings-section-head"><h4>Seuils</h4><span class="hint">vide = non calibré</span></div>
      <settings-card><settings-fields>${thresholds}</settings-fields></settings-card>
      <div class="settings-section-head"><h4>Questions JEV</h4><span class="hint">${config.questions.length} configurée(s)</span></div>
      ${cards}
      <button class="settings-add" type="button" data-add="question">+ Ajouter une question</button>
    </settings-section>`;
  }

  function renderSystem() {
    return `<settings-section>
      <h3>Système</h3>
      <p>Ce panneau n’expose ni clé API, ni CV source, ni registre local des comptes.</p>
      ${errorSummary()}
      <settings-card>
        <ul class="settings-system-list">
          <li><code>config/criteria.json</code> : collecte et catégories</li>
          <li><code>config/preferences.json</code> : envies et refus</li>
          <li><code>config/jev.json</code> : modèle, questions et seuils</li>
          <li>Chaque sauvegarde valide les objets, écrit les trois fichiers et lance <code>node ingest/ingest.mjs --rebuild</code>.</li>
          <li>Si le rebuild échoue, les fichiers précédents sont restaurés.</li>
        </ul>
      </settings-card>
    </settings-section>`;
  }

  const renderContent = () => {
    if (!view.settings) {
      content.innerHTML = '<p class="hint">Chargement des réglages…</p>';
      return;
    }
    content.innerHTML =
      view.tab === 'criteria'
        ? renderCriteria()
        : view.tab === 'preferences'
          ? renderPreferences()
          : view.tab === 'jev'
            ? renderJev()
            : renderSystem();
  };

  const markDirty = () => {
    view.dirty = true;
    reloadButton.hidden = true;
    saveButton.disabled = true;
    setStatus('Modifications non appliquées · validation…', 'dirty');
    clearTimeout(view.timer);
    view.timer = setTimeout(validate, 250);
  };

  const validate = async () => {
    try {
      const { payload } = await request('/api/settings/validate', { method: 'POST', body: JSON.stringify(view.settings) });
      view.errors = payload.errors ?? [];
      saveButton.disabled = view.errors.length > 0 || !view.dirty;
      setStatus(view.errors.length ? `${view.errors.length} erreur(s) à corriger` : 'JSON valide · prêt à enregistrer', view.errors.length ? 'error' : 'valid');
    } catch (error) {
      saveButton.disabled = true;
      setStatus(error.message, 'error');
    }
  };

  const load = async () => {
    setStatus('Chargement…');
    const { payload } = await request('/api/settings');
    view.settings = payload.settings;
    view.original = clone(payload.settings);
    view.dirty = false;
    view.errors = [];
    saveButton.disabled = true;
    renderNav();
    renderContent();
    setStatus('Aucune modification');
  };

  const open = async () => {
    if (!runtime.enabled) {
      window.alert('Pour modifier les réglages, lancez `node settings/server.mjs`, puis ouvrez l’adresse affichée.');
      return;
    }
    component.hidden = false;
    document.body.classList.add('settings-open');
    component.querySelector('.settings-close').focus();
    if (!view.settings) {
      try {
        await load();
      } catch (error) {
        setStatus(error.message, 'error');
      }
    }
  };

  const close = () => {
    if (view.dirty && !window.confirm('Abandonner les modifications non enregistrées ?')) return;
    if (view.dirty) {
      view.settings = clone(view.original);
      view.dirty = false;
      view.errors = [];
    }
    component.hidden = true;
    document.body.classList.remove('settings-open');
    openButton.focus();
  };

  const uniqueId = (prefix, entries) => {
    const ids = new Set(entries.map((entry) => entry.id));
    let id = prefix;
    let suffix = 2;
    while (ids.has(id)) id = `${prefix}-${suffix++}`;
    return id;
  };

  const addItem = (kind) => {
    if (kind === 'criterion') {
      const list = view.settings.criteria.criteria;
      list.push({
        id: uniqueId('nouveau-critere', list), label: 'Nouveau critère', enabled: true, description: '', profileMatch: false,
        queries: { gmail: 'newer_than:{windowHours}h ', proton: '', keywords: [], fromDomains: [] },
      });
    } else if (kind === 'preference') {
      const list = view.settings.preferences.preferences;
      list.push({ id: uniqueId('nouvelle-preference', list), kind: 'pro', strength: 'mild', label: 'Nouvelle préférence', note: '', match: { keywords: [] } });
    } else {
      const list = view.settings.jev.questions;
      list.push({ id: `question${list.length + 1}`, enabled: true, primitive: 'noul', text: 'Nouvelle question', usage: 'À définir', requiresProfile: false });
    }
    markDirty();
    renderContent();
  };

  const listFor = (kind) =>
    kind === 'criterion'
      ? view.settings.criteria.criteria
      : kind === 'preference'
        ? view.settings.preferences.preferences
        : view.settings.jev.questions;

  content.addEventListener('input', (event) => {
    const control = event.target.closest('[data-bind]');
    if (!control) return;
    let value = control.type === 'checkbox' ? control.checked : control.value;
    if (control.dataset.nullableNumber === 'true') value = value === '' ? null : Number(value);
    else if (control.type === 'number') value = Number(value);
    if (control.dataset.valueKind === 'lines') value = value.split('\n').map((item) => item.trim()).filter(Boolean);
    if (control.dataset.valueKind === 'options') value = parseOptions(value);
    setAt(view.settings, control.dataset.bind, value);
    markDirty();
  });

  content.addEventListener('change', (event) => {
    const control = event.target.closest('[data-bind$=".primitive"]');
    if (!control) return;
    const question = getAt(view.settings, control.dataset.bind.replace(/\.primitive$/, ''));
    if (question.primitive === 'choice' && !question.options) question.options = { option_a: 'Première option', option_b: 'Deuxième option' };
    if (question.primitive === 'score' && !question.levels) question.levels = ['niveau faible', 'niveau élevé'];
    renderContent();
  });

  content.addEventListener('click', (event) => {
    const add = event.target.closest('[data-add]');
    if (add) return addItem(add.dataset.add);
    const remove = event.target.closest('[data-remove]');
    if (remove) {
      listFor(remove.dataset.remove).splice(Number(remove.dataset.index), 1);
      markDirty();
      renderContent();
      return;
    }
    const move = event.target.closest('[data-move]');
    if (move) {
      const list = listFor(move.dataset.move);
      const index = Number(move.dataset.index);
      const target = index + Number(move.dataset.direction);
      [list[index], list[target]] = [list[target], list[index]];
      markDirty();
      renderContent();
    }
  });

  nav.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-settings-tab]');
    if (!tab) return;
    view.tab = tab.dataset.settingsTab;
    renderNav();
    renderContent();
  });

  component.addEventListener('click', (event) => {
    if (event.target.closest('[data-settings-close]')) close();
  });
  openButton.addEventListener('click', open);
  cancelButton.addEventListener('click', close);
  reloadButton.addEventListener('click', () => location.reload());
  saveButton.addEventListener('click', async () => {
    saveButton.disabled = true;
    setStatus('Validation → écriture → rebuild…', 'dirty');
    try {
      const { payload } = await request('/api/settings', { method: 'PUT', body: JSON.stringify(view.settings) });
      if (!payload.ok) {
        view.errors = payload.errors ?? [];
        setStatus(`${view.errors.length} erreur(s) · aucun fichier modifié`, 'error');
        renderContent();
        return;
      }
      view.settings = payload.settings;
      view.original = clone(payload.settings);
      view.dirty = false;
      view.errors = [];
      reloadButton.hidden = false;
      setStatus('Enregistré · dashboard reconstruit', 'saved');
      renderContent();
    } catch (error) {
      setStatus(error.message, 'error');
      saveButton.disabled = false;
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !component.hidden) close();
  });
})();
