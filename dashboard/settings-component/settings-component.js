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
    ['criteria', 'Collection'],
    ['preferences', 'Preferences'],
    ['jev', 'JEV'],
    ['system', 'System'],
  ];
  const view = { tab: 'criteria', settings: null, original: null, dirty: false, errors: [], timer: null };

  if (!runtime.enabled) {
    openButton.dataset.readonly = 'true';
    openButton.title = 'Run `node settings/server.mjs`, then open the printed address.';
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
    if (!response.ok && response.status !== 422) throw new Error(payload.error ?? 'The settings service is not responding.');
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
      <button type="button" data-move="${kind}" data-index="${index}" data-direction="-1" ${index === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
      <button type="button" data-move="${kind}" data-index="${index}" data-direction="1" ${index === length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
      <button class="settings-delete" type="button" data-remove="${kind}" data-index="${index}">Delete</button>
    </div>`;

  function renderCriteria() {
    const config = view.settings.criteria;
    const cards = config.criteria
      .map((criterion, index) => {
        const base = `criteria.criteria.${index}`;
        return `<settings-card>
          <settings-card-header><strong>${escapeHtml(criterion.label || criterion.id || 'New criterion')}</strong>${cardActions('criterion', index, config.criteria.length)}</settings-card-header>
          <settings-fields>
            ${field('Identifier', input(`${base}.id`, criterion.id))}
            ${field('Label', input(`${base}.label`, criterion.label))}
            ${field('State', checkbox(`${base}.enabled`, criterion.enabled !== false, 'Criterion enabled'))}
            ${field('Profile fit', checkbox(`${base}.profileMatch`, Boolean(criterion.profileMatch), 'Evaluate profile fit'))}
            ${field('Description', textarea(`${base}.description`, criterion.description ?? ''), true)}
            ${field('Gmail query', textarea(`${base}.queries.gmail`, criterion.queries?.gmail ?? ''), true)}
            ${field('Proton query', textarea(`${base}.queries.proton`, criterion.queries?.proton ?? ''), true)}
            ${field('Keywords, one per line', textarea(`${base}.queries.keywords`, lines(criterion.queries?.keywords), 'lines'), true)}
            ${field('Sender domains, one per line', textarea(`${base}.queries.fromDomains`, lines(criterion.queries?.fromDomains), 'lines'), true)}
          </settings-fields>
        </settings-card>`;
      })
      .join('');

    return `<settings-section>
      <h3>Collection</h3>
      <p>Set the common window and the queries run by each provider.</p>
      ${errorSummary()}
      <settings-card><settings-fields>
        ${field('Collection window (hours)', input('criteria.defaults.windowHours', config.defaults?.windowHours ?? 12, 'number', 'min="1" max="720"'))}
        ${field('Fallback category', input('criteria.fallback.label', config.fallback?.label ?? 'Autre'))}
      </settings-fields></settings-card>
      <div class="settings-section-head"><h4>Criteria</h4><span class="hint">${config.criteria.length} configured</span></div>
      ${cards}
      <button class="settings-add" type="button" data-add="criterion">+ Add a criterion</button>
    </settings-section>`;
  }

  function renderPreferences() {
    const config = view.settings.preferences;
    const cards = config.preferences
      .map((preference, index) => {
        const base = `preferences.preferences.${index}`;
        return `<settings-card>
          <settings-card-header><strong>${escapeHtml(preference.label || preference.id || 'New preference')}</strong>${cardActions('preference', index, config.preferences.length)}</settings-card-header>
          <settings-fields>
            ${field('Identifier', input(`${base}.id`, preference.id))}
            ${field('Label', input(`${base}.label`, preference.label))}
            ${field('Effect', select(`${base}.kind`, preference.kind, [['pro', 'Pro'], ['con', 'Con']]))}
            ${field('Strength', select(`${base}.strength`, preference.strength, [['blocker', 'Blocker'], ['strong', 'Strong'], ['mild', 'Mild']]))}
            ${field('State', checkbox(`${base}.enabled`, preference.enabled !== false, 'Preference enabled'))}
            ${field('Note', textarea(`${base}.note`, preference.note ?? ''), true)}
            ${field('Keywords, one per line', textarea(`${base}.match.keywords`, lines(preference.match?.keywords), 'lines'), true)}
          </settings-fields>
        </settings-card>`;
      })
      .join('');
    return `<settings-section>
      <h3>Preferences</h3>
      <p>Pros attract, cons repel. A blocker preference flags the offer without deleting it.</p>
      ${errorSummary()}
      <settings-card><settings-fields>
        ${field('Blocker weight', input('preferences.weights.blocker', config.weights?.blocker ?? 4, 'number', 'min="0"'))}
        ${field('Strong weight', input('preferences.weights.strong', config.weights?.strong ?? 2, 'number', 'min="0"'))}
        ${field('Mild weight', input('preferences.weights.mild', config.weights?.mild ?? 1, 'number', 'min="0"'))}
      </settings-fields></settings-card>
      <div class="settings-section-head"><h4>Rules</h4><span class="hint">${config.preferences.length} configured</span></div>
      ${cards}
      <button class="settings-add" type="button" data-add="preference">+ Add a preference</button>
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
            ? field('Options: key = description', textarea(`${base}.options`, optionsText(question.options), 'options'), true)
            : question.primitive === 'score'
              ? field('Levels, one per line', textarea(`${base}.levels`, lines(question.levels), 'lines'), true)
              : '';
        return `<settings-card>
          <settings-card-header><strong>${escapeHtml(question.id || 'New question')}</strong>${cardActions('question', index, config.questions.length)}</settings-card-header>
          <settings-fields>
            ${field('State', checkbox(`${base}.enabled`, question.enabled !== false, 'Question enabled'))}
            ${field('Profile', checkbox(`${base}.requiresProfile`, Boolean(question.requiresProfile), 'Profile required'))}
            ${field('Identifier', input(`${base}.id`, question.id))}
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
      <p>Configure the business call and the objects sent to the model. The API key stays in the environment.</p>
      ${errorSummary()}
      <settings-card><settings-fields>
        ${field('State', checkbox('jev.enabled', Boolean(config.enabled), 'Enable JEV'))}
        ${field('Model', input('jev.model', config.model ?? 'jev-latest'))}
        ${field('Question set', input('jev.questionSet', config.questionSet ?? 'mailboard-v1'))}
        ${field('Endpoint', input('jev.endpoint', config.endpoint ?? '', 'url'), true)}
        ${field('Timeout (ms)', input('jev.timeoutMs', config.timeoutMs ?? 8000, 'number', 'min="500" max="120000"'))}
        ${field('Concurrency', input('jev.concurrency', config.concurrency ?? 4, 'number', 'min="1" max="20"'))}
        ${field('Extra retries', input('jev.retriesPerRun', config.retriesPerRun ?? 0, 'number', 'min="0" max="5"'))}
        ${field('Profile', checkbox('jev.profile.send', Boolean(config.profile?.send), 'Send the redacted profile'))}
        ${field('Profile size', input('jev.profile.maxChars', config.profile?.maxChars ?? 4000, 'number', 'min="500"'))}
      </settings-fields></settings-card>
      <div class="settings-section-head"><h4>Thresholds</h4><span class="hint">empty = not calibrated</span></div>
      <settings-card><settings-fields>${thresholds}</settings-fields></settings-card>
      <div class="settings-section-head"><h4>JEV questions</h4><span class="hint">${config.questions.length} configured</span></div>
      ${cards}
      <button class="settings-add" type="button" data-add="question">+ Add a question</button>
    </settings-section>`;
  }

  function renderSystem() {
    return `<settings-section>
      <h3>System</h3>
      <p>This panel exposes no API key, no source CV and no local account registry.</p>
      ${errorSummary()}
      <settings-card>
        <ul class="settings-system-list">
          <li><code>config/criteria.json</code>: collection and categories</li>
          <li><code>config/preferences.json</code>: wants and refusals</li>
          <li><code>config/jev.json</code>: model, questions and thresholds</li>
          <li>Each save validates the objects, writes the three files and runs <code>node ingest/ingest.mjs --rebuild</code>.</li>
          <li>If the rebuild fails, the previous files are restored.</li>
        </ul>
      </settings-card>
    </settings-section>`;
  }

  const renderContent = () => {
    if (!view.settings) {
      content.innerHTML = '<p class="hint">Loading settings…</p>';
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
    setStatus('Unsaved changes · validating…', 'dirty');
    clearTimeout(view.timer);
    view.timer = setTimeout(validate, 250);
  };

  const validate = async () => {
    try {
      const { payload } = await request('/api/settings/validate', { method: 'POST', body: JSON.stringify(view.settings) });
      view.errors = payload.errors ?? [];
      saveButton.disabled = view.errors.length > 0 || !view.dirty;
      setStatus(view.errors.length ? `${view.errors.length} error(s) to fix` : 'Valid JSON · ready to save', view.errors.length ? 'error' : 'valid');
    } catch (error) {
      saveButton.disabled = true;
      setStatus(error.message, 'error');
    }
  };

  const load = async () => {
    setStatus('Loading…');
    const { payload } = await request('/api/settings');
    view.settings = payload.settings;
    view.original = clone(payload.settings);
    view.dirty = false;
    view.errors = [];
    saveButton.disabled = true;
    renderNav();
    renderContent();
    setStatus('No changes');
  };

  const open = async () => {
    if (!runtime.enabled) {
      window.alert('To edit settings, run `node settings/server.mjs`, then open the printed address.');
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
    if (view.dirty && !window.confirm('Discard unsaved changes?')) return;
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
        id: uniqueId('new-criterion', list), label: 'New criterion', enabled: true, description: '', profileMatch: false,
        queries: { gmail: 'newer_than:{windowHours}h ', proton: '', keywords: [], fromDomains: [] },
      });
    } else if (kind === 'preference') {
      const list = view.settings.preferences.preferences;
      list.push({ id: uniqueId('new-preference', list), kind: 'pro', strength: 'mild', label: 'New preference', note: '', match: { keywords: [] } });
    } else {
      const list = view.settings.jev.questions;
      list.push({ id: `question${list.length + 1}`, enabled: true, primitive: 'noul', text: 'New question', usage: 'To be defined', requiresProfile: false });
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
    if (question.primitive === 'choice' && !question.options) question.options = { option_a: 'First option', option_b: 'Second option' };
    if (question.primitive === 'score' && !question.levels) question.levels = ['low level', 'high level'];
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
    setStatus('Validate → write → rebuild…', 'dirty');
    try {
      const { payload } = await request('/api/settings', { method: 'PUT', body: JSON.stringify(view.settings) });
      if (!payload.ok) {
        view.errors = payload.errors ?? [];
        setStatus(`${view.errors.length} error(s) · no file changed`, 'error');
        renderContent();
        return;
      }
      view.settings = payload.settings;
      view.original = clone(payload.settings);
      view.dirty = false;
      view.errors = [];
      reloadButton.hidden = false;
      setStatus('Saved · dashboard rebuilt', 'saved');
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
