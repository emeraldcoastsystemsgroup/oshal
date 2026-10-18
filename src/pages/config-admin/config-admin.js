/** CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Replace legacy configuration drafts with native current-authority controls and verified runtime receipts.
 */
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const query = new URLSearchParams(window.location.search);
  const audienceReadOnly = ['company', 'family'].includes(query.get('audience'));
  const paths = Object.freeze({
    config: '/api/admin/config', fleet: '/api/agents/provider-switch', providers: '/api/providers',
    capabilities: '/api/capability-providers', role: '/api/swarm/roles/me', logging: '/api/admin/logging',
  });
  const state = { answers: {}, busy: false, canWrite: false, requiresRefresh: false, mutationAttempted: false, fallbackText: '' };
  const text = (id, value) => { byId(id).textContent = value; };
  const map = value => value && typeof value === 'object' && !Array.isArray(value);
  const errorText = error => error?.message || String(error);
  const operator = role => role?.isRoot === true || role?.isOperator === true;
  const configuredSpeech = provider => provider.configured === true && provider.status !== 'unimplemented';
  function status(message, tone = 'info') {
    text('statusBanner', message); byId('statusBanner').dataset.tone = tone;
  }
  async function request(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin', cache: 'no-store',
      ...options, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
    let data;
    try { data = JSON.parse(await response.text()); }
    catch { throw new Error(`Native ${path} returned no valid JSON receipt (HTTP ${response.status})`); }
    if (!response.ok) {
      const error = new Error(data?.detail || data?.message || `Native read/write refused (HTTP ${response.status})`);
      error.status = response.status; throw error;
    }
    if (!map(data) && !Array.isArray(data)) throw new Error(`Invalid native response from ${path}`);
    return data;
  }
  function validate(name, data) {
    if (name === 'config' && !(map(data.effective) && map(data.effective.inference) && map(data.effective.voice_tts))) throw new Error('Invalid effective configuration receipt');
    if (name === 'fleet' && !(map(data.fleetDefault) && typeof data.fleetDefault.providerId === 'string' && data.fleetDefault.providerId && typeof data.fleetDefault.modelId === 'string' && data.fleetDefault.modelId && Array.isArray(data.fleetDefault.fallbackOrder) && data.fleetDefault.fallbackOrder.every(id => typeof id === 'string' && id))) throw new Error('Invalid effective fleet receipt');
    if (name === 'providers' && !(Array.isArray(data) && data.every(provider => map(provider) && typeof provider.id === 'string' && provider.id && Array.isArray(provider.models) && provider.models.every(model => map(model) && typeof model.id === 'string' && model.id)))) throw new Error('Invalid registered provider roster');
    if (name === 'capabilities' && !Array.isArray(data.capabilities)) throw new Error('Invalid native capability roster');
    if (name === 'role' && !(typeof data.principalId === 'string' && typeof data.sub === 'string' && typeof data.role === 'string' && typeof data.isOperator === 'boolean' && typeof data.isRoot === 'boolean')) throw new Error('Invalid current native authority receipt');
    if (name === 'logging' && !(['error', 'warn', 'info', 'debug', 'trace'].includes(data.level) && map(data.module_levels) && data.audit_always_enabled === true && typeof data.source === 'string')) throw new Error('Invalid native logging receipt');
    return data;
  }
  async function read(name) {
    try { return { ok: true, data: validate(name, await request(paths[name])) }; }
    catch (error) { return { ok: false, error: errorText(error), status: error.status }; }
  }
  function option(select, value, label, disabled = false) {
    const node = document.createElement('option'); node.value = value; node.textContent = label; node.disabled = disabled; select.appendChild(node);
  }
  function providers() { return state.answers.providers?.ok ? state.answers.providers.data.filter(provider => typeof provider.id === 'string' && Array.isArray(provider.models)) : []; }
  function speechSection() { return state.answers.capabilities?.ok ? state.answers.capabilities.data.capabilities.find(cap => cap.capability === 'tts') : null; }
  function renderModels(selected) {
    const select = byId('fleetModelSelect'); select.replaceChildren();
    const provider = providers().find(provider => provider.id === byId('fleetProviderSelect').value);
    for (const model of provider?.models || []) if (typeof model.id === 'string') option(select, model.id, model.name || model.id);
    if (selected && !Array.from(select.options).some(option => option.value === selected)) option(select, selected, `${selected} (current value outside selectable roster)`, true);
    if (!select.options.length) option(select, '', 'No registered model', true);
    select.value = selected || provider?.defaultModelId || select.options[0].value;
    updateControls();
  }
  function updateControls() {
    const writable = state.canWrite && !state.busy && !state.requiresRefresh;
    const fleet = writable && state.answers.fleet?.ok && state.answers.providers?.ok && providers().length > 0;
    for (const id of ['fleetProviderSelect', 'fleetModelSelect', 'fleetFallbackInput', 'fleetSaveButton']) byId(id).disabled = !fleet;
    const tts = speechSection();
    const speech = writable && tts?.providers?.some(provider => configuredSpeech(provider) && (provider.providerId || provider.id) === tts.swarmDefault?.providerId);
    for (const id of ['ttsProviderSelect', 'ttsVoiceInput', 'ttsSaveButton']) byId(id).disabled = !speech;
    for (const id of ['loggingLevelSelect', 'loggingSaveButton']) byId(id).disabled = !(writable && state.answers.logging?.ok);
    byId('refreshButton').disabled = state.busy;
  }
  function render() {
    const { config, fleet, providers: roster, capabilities, role, logging } = state.answers;
    state.canWrite = role?.ok && operator(role.data) && !audienceReadOnly;
    text('deploymentValue', config?.ok ? config.data.deployment || 'Not reported' : 'Unavailable');
    text('fleetValue', fleet?.ok ? fleet.data.fleetDefault.providerId : 'Unavailable');
    text('providersValue', roster?.ok ? String(roster.data.length) : 'Unavailable');
    text('authorityValue', role?.ok ? (audienceReadOnly ? `${role.data.role} · preview` : role.data.role || (operator(role.data) ? 'admin' : 'read only')) : 'Unverified');
    text('identitySummary', role?.ok ? `Account: ${role.data.sub}. Principal: ${role.data.principalId}. Saves require current native administrator authority.` : `Current authority could not be read: ${role?.error || 'not loaded'}. Editing is disabled.`);
    const fleetSelect = byId('fleetProviderSelect'); fleetSelect.replaceChildren();
    for (const provider of providers()) option(fleetSelect, provider.id, provider.displayName || provider.name || provider.id);
    const row = fleet?.ok ? fleet.data.fleetDefault : null;
    if (row && !providers().some(provider => provider.id === row.providerId)) option(fleetSelect, row.providerId, `${row.providerId} (current value outside selectable roster)`, true);
    if (!fleetSelect.options.length) option(fleetSelect, '', 'No registered provider', true);
    if (row) fleetSelect.value = row.providerId;
    renderModels(row?.modelId);
    state.fallbackText = row ? (row.fallbackOrder.length ? row.fallbackOrder.join(', ') : 'none') : '';
    byId('fleetFallbackInput').value = state.fallbackText;
    text('fleetSummary', row ? `Effective fleet: ${row.providerId} / ${row.modelId}. Fallback: ${row.fallbackOrder.length ? row.fallbackOrder.join(' → ') : 'none'}. The next native call uses saved deployment defaults.` : `Fleet configuration unavailable: ${fleet?.error || 'not loaded'}.`);
    const tts = speechSection(); const speechSelect = byId('ttsProviderSelect'); speechSelect.replaceChildren();
    for (const provider of tts?.providers || []) {
      const id = provider.providerId || provider.id;
      if (typeof id === 'string') option(speechSelect, id, `${provider.displayName || provider.name || id} · ${provider.status || 'health unmeasured'}`, !configuredSpeech(provider));
    }
    if (!speechSelect.options.length) option(speechSelect, '', 'No configured native speech adapter', true);
    speechSelect.value = tts?.swarmDefault?.providerId || '';
    byId('ttsVoiceInput').value = tts?.swarmDefault?.voice || '';
    byId('ttsVoiceOptions').replaceChildren();
    for (const voice of tts?.providers?.find(provider => (provider.providerId || provider.id) === speechSelect.value)?.voices || []) option(byId('ttsVoiceOptions'), voice.id, voice.displayName || voice.name || voice.id);
    text('speechSummary', tts?.swarmDefault?.providerId ? `Deployment speech default: ${tts.swarmDefault.providerId} / ${tts.swarmDefault.voice || 'voice not reported'}. Health is unmeasured.` : `Speech configuration unavailable: ${capabilities?.error || tts?.swarmDefault?.reason || 'no configured adapter'}.`);
    const callerSpeech = config?.ok ? config.data.effective.voice_tts : null;
    text('speechEffectiveSummary', callerSpeech ? `Your effective speech selection: ${callerSpeech.provider} / ${callerSpeech.model} / ${callerSpeech.default_voice}. This includes your individual speech preference.` : 'Your effective speech selection could not be read.');
    const log = logging?.ok ? logging.data : null;
    byId('loggingLevelSelect').value = log?.level || '';
    text('loggingSummary', log ? `Effective level: ${log.level}. Source: ${log.source}. Required audit output is enabled.` : `Logging administration unavailable: ${logging?.error || 'not loaded'}.`);
    byId('loggingOverrides').replaceChildren();
    if (log) {
      const entries = Object.entries(log.module_levels);
      if (!entries.length) { const p = document.createElement('p'); p.textContent = 'No module overrides.'; byId('loggingOverrides').appendChild(p); }
      for (const [module, level] of entries) { const p = document.createElement('p'); p.textContent = `${module}: ${level}`; byId('loggingOverrides').appendChild(p); }
    }
    byId('configSources').replaceChildren();
    for (const [name, path] of Object.entries(paths)) {
      const answer = state.answers[name]; const row = document.createElement('tr');
      for (const value of [path, answer?.ok ? 'Native response received' : `Unavailable: ${answer?.error || 'not loaded'}`]) {
        const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell);
      }
      byId('configSources').appendChild(row);
    }
    updateControls();
  }
  async function load() {
    state.busy = true; updateControls(); status('Loading native configuration…');
    const names = Object.keys(paths);
    const answers = await Promise.all(names.map(read));
    state.answers = Object.fromEntries(names.map((name, index) => [name, answers[index]]));
    state.busy = false; state.requiresRefresh = false; render();
    const main = ['config', 'fleet', 'providers', 'capabilities', 'role'];
    if (main.every(name => state.answers[name].ok)) status(`Native configuration loaded. ${state.canWrite ? 'Administrator controls are available.' : 'Read-only for this account or portal preview.'}`);
    else status('Some native configuration could not be read. Unavailable sections are disabled; each source shows its refusal.', 'error');
  }
  async function freshAuthority() {
    const role = validate('role', await request(paths.role));
    state.answers.role = { ok: true, data: role };
    if (audienceReadOnly || !operator(role)) { state.canWrite = false; updateControls(); throw new Error('Current native administrator authority is required; this view is read-only'); }
  }
  async function mutate(path, payload) {
    await freshAuthority();
    const confirmation = await request('/confirmations', { method: 'POST' });
    if (typeof confirmation.confirmation !== 'string' || !confirmation.confirmation) throw new Error('No native confirmation token was issued');
    state.mutationAttempted = true;
    return request(path, { method: 'PUT', headers: { 'x-oshal-confirm': confirmation.confirmation }, body: JSON.stringify(payload) });
  }
  async function save(action) {
    if (state.requiresRefresh) { status('Refresh to verify the current configuration before another explicit save.', 'error'); return; }
    if (!state.canWrite || state.busy) { status('Editing requires current native administrator authority and an explicit save.', 'error'); return; }
    state.busy = true; state.mutationAttempted = false; updateControls(); status('Saving and checking native readback…');
    try { const message = await action(); state.busy = false; await load(); status(message, 'success'); }
    catch (error) {
      state.busy = false; state.requiresRefresh = state.mutationAttempted;
      if (error.status === 401 || error.status === 403) {
        state.answers.role = { ok: false, error: errorText(error), status: error.status }; render();
      } else updateControls();
      status(`Change not confirmed: ${errorText(error)}. Refresh to verify the current configuration before another explicit save.`, 'error');
    }
  }
  byId('fleetForm').addEventListener('submit', event => {
    event.preventDefault();
    const providerId = byId('fleetProviderSelect').value; const modelId = byId('fleetModelSelect').value;
    const typed = byId('fleetFallbackInput').value.trim();
    save(async () => {
      if (!providers().some(provider => provider.id === providerId && provider.models.some(model => model.id === modelId))) throw new Error('Select a registered provider and model');
      const old = state.answers.fleet.data.fleetDefault;
      const payload = { providerId, modelId };
      if (typed !== state.fallbackText) {
        const order = ['none', 'off', 'false', ''].includes(typed.toLowerCase()) ? [] : typed.split(',').map(id => id.trim()).filter(Boolean);
        if (order.length > 16 || new Set(order).size !== order.length || order.some(id => !providers().some(provider => provider.id === id))) throw new Error('Fallback must list at most 16 distinct registered provider IDs');
        payload.fallbackOrder = order;
      }
      if (providerId === old.providerId && modelId === old.modelId && payload.fallbackOrder === undefined) return 'No fleet changes to save.';
      const receipt = validate('fleet', await mutate(`${paths.fleet}/fleet-default`, payload));
      if (receipt.fleetDefault.providerId !== providerId || receipt.fleetDefault.modelId !== modelId
          || payload.fallbackOrder && JSON.stringify(receipt.fleetDefault.fallbackOrder) !== JSON.stringify(payload.fallbackOrder)) throw new Error('Fleet write receipt differs from the requested change');
      const actual = validate('fleet', await request(paths.fleet));
      if (JSON.stringify(actual.fleetDefault) !== JSON.stringify(receipt.fleetDefault)) throw new Error('Effective fleet readback differs from the write receipt');
      return `Fleet defaults saved and read back: ${providerId} / ${modelId}. The next native call uses them.`;
    });
  });
  byId('ttsForm').addEventListener('submit', event => {
    event.preventDefault(); const providerId = byId('ttsProviderSelect').value; const voice = byId('ttsVoiceInput').value.trim();
    save(async () => {
      const tts = speechSection();
      if (!voice || voice.length > 128 || /[\r\n]/.test(voice) || !tts?.providers?.some(provider => configuredSpeech(provider) && (provider.providerId || provider.id) === providerId)) throw new Error('Use a bounded voice with the configured native speech provider');
      if (tts.swarmDefault.providerId === providerId && tts.swarmDefault.voice === voice) return 'No speech changes to save.';
      const receipt = await mutate(`${paths.capabilities}/swarm/tts`, { providerId, voice });
      if (receipt.ok !== true || receipt.capability !== 'tts' || !['updated', 'unchanged'].includes(receipt.result?.status)) throw new Error('No acknowledged native speech update');
      const actual = validate('capabilities', await request(paths.capabilities)).capabilities.find(cap => cap.capability === 'tts');
      if (actual?.swarmDefault?.providerId !== providerId || actual.swarmDefault.voice !== voice) throw new Error('Deployment speech readback differs from the request');
      return `Deployment voice saved and read back: ${providerId} / ${voice}. Individual speech preferences can take precedence.`;
    });
  });
  byId('loggingForm').addEventListener('submit', event => {
    event.preventDefault(); const level = byId('loggingLevelSelect').value;
    save(async () => {
      const old = state.answers.logging?.ok ? state.answers.logging.data : null;
      if (!old) throw new Error('Native logging configuration must be read before changing it');
      if (old.level === level) return 'No logging changes to save.';
      const expected = { level: old.level, module_levels: old.module_levels };
      const receipt = validate('logging', await mutate(paths.logging, { level, module_levels: old.module_levels, expected_config: expected }));
      const actual = validate('logging', await request(paths.logging));
      if (receipt.level !== level || actual.level !== level || JSON.stringify(receipt.module_levels) !== JSON.stringify(old.module_levels) || JSON.stringify(actual.module_levels) !== JSON.stringify(old.module_levels)) throw new Error('Logging readback differs from the requested level and preserved overrides');
      return `Runtime log level saved and read back: ${level}. Required audit output remains enabled.`;
    });
  });
  byId('fleetProviderSelect').addEventListener('change', () => renderModels());
  byId('refreshButton').addEventListener('click', load);
  byId('audienceNotice').hidden = !audienceReadOnly;
  byId('agentScopeNotice').hidden = query.get('scope') !== 'agent';
  load();
})();
