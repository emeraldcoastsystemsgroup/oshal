/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Generic ?app= onboarding (replaces the carved-out LM_ONBOARD branch): when the wizard is entered focused on an installed app, its profile's connector allow-list (manifest dependencies.connectors) filters the Connect-accounts step — an empty list drops that step AND the capabilities step entirely (a kids' app must not pitch Facebook or unrelated app installs) — and Finish lands back on /cockpit/?app=<name> instead of dumping the user into the framework cockpit. The mandatory AI-model step is never skipped.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 1 carve #4: dropped 'payments' from the money capability card's hot-load apps — the app carved to the store and is no longer core-loadable by manifest name; the card's finance+trading loads are unchanged.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | First-run fix — the Configuration Status step was a dead end that ended walkthroughs. It sat BEFORE the steps that fix anything, showed a demoralizing score built from optional integrations, and its "Fix" links opened /cockpit#… in a new tab that 302'd right back to /welcome (guarded surface) at a hash the cockpit never routed on. Now: required and optional are split (meter reads required-only), an unmet item the wizard can fix jumps IN-wizard via gotoStep() instead of opening a bouncing tab, items with nothing useful to click render no button at all, and all interpolation goes through escHtml. Renamed to "Setup status" — "Configuration" read like a wall rather than a checklist.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Dropped the percentage from the onboarding step entirely (operator: "20% completed doesn't sound good"). Scoring required-only fixed the ARITHMETIC but not the framing — and made the worst case read worse, since a short required list only yields 0% / 50% / 100%, so a user whose bots were still booting now saw 0%. This screen is the first thing a stranger sees, before they have been offered any chance to act: any score is a grade for work never asked of them. Replaced with a forward-looking checklist ("What your swarm needs" / "Just N things") whose lead line branches on whether the wizard can actually FIX the gap (next step) or it self-clears (bots still booting) — the old single message promised a walkthrough the next step could not deliver for the bot case. The meter stays on the cockpit dashboard, where 100% on an operating swarm is a health signal rather than a verdict on a newcomer.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | New 'notify' step (operator ask 2026-07-31): a per-user text/call/email opt-in that walks through the setup — pick a channel, save a phone number, fire a real confirm-gated test — writing the 'default' topic row via POST /api/notify/prefs (the DEFAULT_TOPIC fallback in the NotificationRouter makes that one answer govern every topic the user hasn't customized). Explicitly declining writes channel 'none'; just clicking Next writes nothing. Saves are best-effort and the step never gates navigation (outward-acting channels are per-user opt-in, default OFF).
 */

/**
 * Onboarding Wizard Controller
 * Steps: Welcome → Features Tour → Config Check → Quick Setup → Done
 */

let STEPS = [
  { id: 'welcome',  title: 'Welcome to OSHAL',  render: renderWelcome },
  { id: 'features', title: 'Platform Features',     render: renderFeatures },
  { id: 'config',   title: 'What your swarm needs', render: renderConfigCheck },
  { id: 'setup',    title: 'Connect an AI model',   render: renderQuickSetup },
  { id: 'capabilities', title: 'Choose what it does', render: renderCapabilities },
  { id: 'connect',  title: 'Connect your accounts', render: renderConnectAccounts },
  { id: 'notify',   title: 'Stay in the loop',      render: renderNotifyStep },
  { id: 'done',     title: "You're All Set!",       render: renderDone },
];

// Generic ?app=<name> focused onboarding (ADR-085): when the wizard is entered for an
// installed app, the app's profile drives what the wizard offers — its declared
// connector allow-list scopes (or drops) the Connect-accounts step, the capabilities
// step (which installs OTHER apps) is dropped, and Finish returns to the app.
let appFocus = null; // { name, displayName, connectors: string[]|undefined }

let currentStep = 0;
let configHealth = null;
// Where Finish sends the user — the clean starter cockpit.
let chosenLanding = '/cockpit';
// Capabilities the user ticked in "Choose what it does". On Finish we hot-load
// each one's swarm app(s) so the cockpit comes up already set up for them.
let selectedCapabilities = new Set();
let availableAppPaths = {};      // app name -> manifest path (from /api/swarm/apps/pending)
let activeAppNames = new Set();  // apps already loaded (skip on install)
// A working LLM is mandatory — bots can't run without one. This flag gates the
// nav so a user cannot leave the setup step (or finish) until a model is connected.
let llmActive = false;
let providersCache = [];
let freeModel = null;

/**
 * @description Checks whether the user has an active LLM and caches the provider roster.
 * `hasActive` is the same signal the server gate uses, so the wizard and the gate agree.
 * @returns True when at least one LLM provider is configured and selected as default.
 */
async function checkLlmActive() {
  try {
    const d = await (await fetch('/api/providers/access', { credentials: 'include' })).json();
    providersCache = d.providers || [];
    freeModel = d.freeModel || null;
    return !!d.hasActive;
  } catch { return false; }
}

document.addEventListener('DOMContentLoaded', async () => {
  // The LLM check overrides the "completed" flag: if a previously-onboarded user has
  // no working model (creds wiped, fresh tenant), we still make them connect one.
  llmActive = await checkLlmActive();
  // ?app=<name>: focused-app onboarding. Resolve the installed app's profile and let it
  // reshape the wizard — connector offers scope to its declared allow-list (an empty
  // declaration drops the whole step), the capabilities step (which installs OTHER
  // apps) is dropped, and Finish lands back on the app instead of the framework cockpit.
  const focusedApp = new URLSearchParams(window.location.search).get('app');
  if (focusedApp && /^[a-z0-9-]+$/i.test(focusedApp)) {
    try {
      const d = await (await fetch('/api/ui/profile?name=' + encodeURIComponent(focusedApp), { credentials: 'include' })).json();
      if (d && d.source === 'swarm-app' && d.profile) {
        appFocus = { name: focusedApp, displayName: d.profile.displayName || focusedApp, connectors: d.profile.connectors };
        chosenLanding = '/cockpit/?app=' + encodeURIComponent(focusedApp);
        STEPS = STEPS.filter((s) => s.id !== 'capabilities');
        if (Array.isArray(appFocus.connectors) && appFocus.connectors.length === 0) {
          STEPS = STEPS.filter((s) => s.id !== 'connect');
        }
      }
    } catch { /* unknown app or profile fetch failed — run the generic wizard */ }
  }
  // Restore ticked capabilities so Back/refresh keeps the selection.
  try { const s = JSON.parse(localStorage.getItem('oshal-onboard-caps') || '[]'); if (Array.isArray(s)) selectedCapabilities = new Set(s); } catch { /* no storage */ }
  try {
    const res = await fetch('/api/user/onboarding');
    const state = await res.json();
    if (state.completed && llmActive) { window.location.href = chosenLanding; return; }
    // Clamp: a saved index from the full wizard may exceed a spliced STEPS list.
    currentStep = Math.min(state.currentStep || 0, STEPS.length - 1);
  } catch { /* first visit */ }
  // No model yet → jump straight to the step that fixes it.
  if (!llmActive) {
    const setupIdx = STEPS.findIndex((s) => s.id === 'setup');
    if (setupIdx >= 0) currentStep = setupIdx;
  }
  renderCurrentStep();
  bindNav();
});

function bindNav() {
  document.getElementById('btnBack').addEventListener('click', () => {
    if (currentStep > 0) { currentStep--; renderCurrentStep(); }
  });
  document.getElementById('btnNext').addEventListener('click', async () => {
    if (currentStep < STEPS.length - 1) {
      currentStep++;
      await saveProgress();
      renderCurrentStep();
    }
  });
  document.getElementById('btnFinish').addEventListener('click', async () => {
    const btn = document.getElementById('btnFinish');
    btn.disabled = true; btn.textContent = 'Setting up…';
    await installSelectedApps(); // hot-load the capabilities the user ticked
    await fetch('/api/user/onboarding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completed: true, currentStep: STEPS.length }),
    });
    window.location.href = chosenLanding; // starter cockpit by default
  });
}

async function saveProgress() {
  await fetch('/api/user/onboarding', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ completed: false, currentStep }),
  }).catch(() => {});
}

function renderCurrentStep() {
  const step = STEPS[currentStep];
  const container = document.getElementById('wizardStep');
  container.innerHTML = '';
  step.render(container);

  const pct = ((currentStep + 1) / STEPS.length) * 100;
  document.getElementById('progressFill').style.width = `${pct}%`;
  document.getElementById('progressLabel').textContent = `Step ${currentStep + 1} of ${STEPS.length}`;

  document.getElementById('btnBack').disabled = currentStep === 0;
  const isLast = currentStep === STEPS.length - 1;
  document.getElementById('btnNext').classList.toggle('hidden', isLast);
  document.getElementById('btnFinish').classList.toggle('hidden', !isLast);

  // Hard requirement: cannot advance past setup, or finish, without a connected model.
  const blockForLlm = (step.id === 'setup' || step.id === 'done') && !llmActive;
  document.getElementById('btnNext').disabled = blockForLlm;
  document.getElementById('btnFinish').disabled = blockForLlm;
}

function renderWelcome(container) {
  container.innerHTML = `
    <div class="step-content step-welcome">
      <div class="welcome-icon">🤖</div>
      <h1>Welcome to OSHAL</h1>
      <p class="subtitle">Multi-Agent Control Plane for Chat, Tooling & Swarm Orchestration</p>
      <p>This wizard will walk you through the key features and help you
         configure your environment so everything works on the first try.</p>
      <p class="welcome-trust" style="opacity:.85;font-size:14px">Everything runs on your machine, on your own accounts.
         Your data stays home — nothing leaves unless you connect it.</p>
      <div class="version-badge">v2.1.0-beta.1</div>
    </div>`;
}

function renderFeatures(container) {
  const features = [
    { icon: '💬', name: 'Chat',            desc: 'Converse with 47+ specialized AI bots' },
    { icon: '🎫', name: 'Tickets',         desc: 'Create, decompose, and track work items' },
    { icon: '🐝', name: 'Swarm',           desc: 'Orchestrate multi-bot pipelines across phases' },
    { icon: '📊', name: 'Dashboard',       desc: 'Real-time metrics, spend tracking, health status' },
    { icon: '📅', name: 'Calendar',        desc: 'Schedule bot tasks and view activity timelines' },
    { icon: '📚', name: 'Knowledge (RAG)', desc: 'Ingest documents and query your knowledge base' },
    { icon: '🎤', name: 'Voice',           desc: 'Voice-to-text interaction with bots' },
    { icon: '⚙️', name: 'Settings',        desc: 'AI providers, API keys, integrations, runtimes' },
  ];
  container.innerHTML = `
    <div class="step-content step-features">
      <h2>Platform Features</h2>
      <div class="feature-grid">
        ${features.map(f => `
          <div class="feature-card">
            <span class="feature-icon">${f.icon}</span>
            <strong>${f.name}</strong>
            <span class="feature-desc">${f.desc}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

/**
 * @description Jumps the wizard to a named step. Used by the Configuration Status step so an
 * unmet item is fixed IN the wizard instead of opening a tab — every old "Fix" link pointed at
 * /cockpit#…, which is behind the onboarding guard and 302s straight back here.
 * @param id - Step id from STEPS (e.g. 'setup', 'connect')
 */
function gotoStep(id) {
  const idx = STEPS.findIndex((s) => s.id === id);
  if (idx < 0) return;
  currentStep = idx;
  saveProgress();
  renderCurrentStep();
}

/** @description One checklist row. `required` items are the only ones scored by the meter. */
function configItemHtml(item) {
  const icon = item.status === 'ok' ? '✅' : item.status === 'missing' ? '❌' : '⚠️';
  // Prefer an in-wizard jump; fall back to an external link ONLY for surfaces that are not
  // behind the onboarding guard (the server picks those). No action at all is fine — an item
  // with nothing to click beats a button that bounces.
  let action = '';
  if (item.wizardStep) {
    action = `<button type="button" class="config-action-link" data-goto="${escHtml(item.wizardStep)}">${escHtml(item.actionLabel || 'Fix')}</button>`;
  } else if (item.actionUrl) {
    action = `<a href="${escHtml(item.actionUrl)}" class="config-action-link" target="_blank" rel="noopener">${escHtml(item.actionLabel || 'Fix')}</a>`;
  }
  return `
    <div class="config-item config-item--${escHtml(item.status)}">
      <span class="config-status-icon">${icon}</span>
      <div class="config-item-body">
        <strong>${escHtml(item.label)}</strong>
        <span class="config-detail">${escHtml(item.detail)}</span>
      </div>
      ${action}
    </div>`;
}

async function renderConfigCheck(container) {
  container.innerHTML = `<div class="step-content step-config"><h2>What your swarm needs</h2><div class="config-loading">Checking…</div></div>`;
  try {
    const res = await fetch('/api/config/health');
    configHealth = await res.json();
  } catch {
    // Only `items` is read here now — the score and the counts belong to the dashboard's meter,
    // not to this screen, so the fallback carries exactly what this render needs.
    configHealth = { items: [] };
  }
  const items = configHealth.items || [];
  // Tolerate an older server that predates `required` — treat the two gating keys as required.
  const isRequired = (i) => (typeof i.required === 'boolean' ? i.required : ['llm-provider', 'active-bots'].includes(i.key));
  const required = items.filter(isRequired);
  const optional = items.filter((i) => !isRequired(i));
  const outstanding = required.filter((i) => i.status !== 'ok');

  // NO percentage here. This screen is the FIRST thing a new user sees, before they have had any
  // chance to act, so any score is a grade for work they were never offered — and with a short
  // required list the coarse values (0% / 50%) read worse than the meaningless number they
  // replaced. A brand-new user needs "here is what's left and here is the button", not a mark.
  // The meter still lives on the cockpit dashboard, where an operating swarm reading 100% is a
  // genuine health signal rather than a verdict on a stranger.
  // Split by whether the WIZARD can actually fix it. Telling someone "the next step walks you
  // through this" when the only gap is bots still booting is a lie the next step then fails to
  // deliver on — and the bot gap clears itself, so it needs reassurance, not an instruction.
  const fixableHere = outstanding.filter((i) => i.wizardStep);
  const selfClearing = outstanding.filter((i) => !i.wizardStep);
  let lead;
  if (outstanding.length === 0) {
    lead = '<div class="config-success">✅ Everything your swarm needs is ready — click Next.</div>';
  } else if (fixableHere.length) {
    lead = `<div class="config-warning">Nothing is wrong — you just haven't set ${fixableHere.length === 1 ? 'this' : 'these'} up yet. The next step walks you through ${fixableHere.length === 1 ? 'it' : 'them'}.</div>`;
  } else {
    lead = `<div class="config-warning">Still starting up — ${selfClearing.length === 1 ? 'this clears' : 'these clear'} on ${selfClearing.length === 1 ? 'its' : 'their'} own within a minute or two. Carry on; you can come back to this screen later.</div>`;
  }

  container.innerHTML = `
    <style>
      .config-group-head { margin: 18px 0 6px; font-size: 13px; opacity: .8; }
      .config-action-link { background: none; border: 1px solid currentColor; border-radius: 6px;
        padding: 4px 10px; font: inherit; font-size: 12px; cursor: pointer; color: var(--wiz-accent, #58a6ff); text-decoration: none; }
      .config-action-link:hover { background: rgba(88,166,255,.12); }
    </style>
    <div class="step-content step-config">
      <h2>What your swarm needs</h2>
      <p>Just ${required.length === 1 ? 'one thing' : `${required.length} things`} — everything else is optional and can wait.</p>
      <div class="config-checklist">${required.map(configItemHtml).join('')}</div>
      ${lead}
      ${optional.length ? `<p class="config-group-head"><strong>Optional add-ons</strong> — none of these are needed to start. Add any of them whenever you like.</p>
      <div class="config-checklist">${optional.map(configItemHtml).join('')}</div>` : ''}
    </div>`;

  container.querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => gotoStep(btn.getAttribute('data-goto')));
  });
}

/** @description HTML-escapes untrusted text for safe interpolation. */
function escHtml(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

/** @description Sets a small status message under a connect control. */
function setSetupMsg(id, text, cls) { const el = document.getElementById(id); if (el) { el.textContent = text || ''; el.className = 'setup-msg' + (cls ? ' ' + cls : ''); } }

/**
 * @description Marks a provider as the active default via the same POST /api/config the
 * Utilities panel uses — this is what flips `hasActive` and releases the gate.
 * @param id - Provider id (e.g. 'openai-codex', 'claude-code')
 * @param model - Model id to pin, or '' to leave the provider default
 */
async function setActiveProvider(id, model) {
  const payload = { actModeApiProvider: id, planModeApiProvider: id, mode: 'act' };
  if (model) {
    payload.actModeApiModelId = model;
    payload.planModeApiModelId = model;
    payload.providerModelPreferences = { [id]: model };
  }
  try { await fetch('/api/config', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); } catch { /* surfaced by the re-check */ }
}

/**
 * @description Re-checks for an active LLM after a connect attempt; on success it flips the
 * gate open and re-renders the step so the nav unlocks and a confirmation shows.
 */
async function confirmConnected(msgId) {
  for (let i = 0; i < 5; i++) {
    if (await checkLlmActive()) { llmActive = true; renderCurrentStep(); return; }
    await new Promise((r) => setTimeout(r, 600));
  }
  setSetupMsg(msgId, 'Saved, but no active model was confirmed — try another option or open Utilities.', 'warn');
}

async function renderQuickSetup(container) {
  container.innerHTML = `<div class="step-content step-setup"><h2>Connect an AI model</h2><div class="config-loading">Checking…</div></div>`;
  llmActive = await checkLlmActive();

  if (llmActive) {
    const active = providersCache.find((p) => p.active);
    container.innerHTML = `<div class="step-content step-setup"><h2>Connect an AI model</h2>
      <div class="setup-success"><span class="big-check">✅</span>
      <p>${active ? escHtml(active.label) + ' is connected.' : 'A model is connected.'} You're ready — click Next.</p></div></div>`;
    return;
  }

  const keyProviders = providersCache.filter((p) => p.kind === 'api-key' && p.secretKey);
  const provOpts = keyProviders.map((p) => `<option value="${escHtml(p.id)}">${escHtml(p.label)}</option>`).join('');
  const freeAvailable = !!(freeModel && freeModel.available);

  container.innerHTML = `
    <div class="step-content step-setup">
      <h2>Connect an AI model</h2>
      <p>Every OSHAL bot runs on an AI model, so this is required. ${freeAvailable ? 'The fastest start is the free shared model — no key, one click.' : 'Pick whichever you have — the API key is the quickest.'}</p>

      ${freeAvailable ? `
      <fieldset class="setup-group">
        <legend>⓪ Use the free ${escHtml(freeModel.label)} — no key needed</legend>
        <p>Start right now on our shared model. No sign-up, no API key. You can switch to your own provider any time in Settings.</p>
        <button class="btn btn-sm" id="btnFree">Use the free model</button>
        <span class="setup-msg" id="freeMsg"></span>
        <p class="setup-hint">Want higher free limits? <a href="/free-models" target="_blank" rel="noopener">Connect
          your own free AI tokens →</a> OpenRouter is one click; four more free tiers take about three.
          The platform rotates across everything you connect.</p>
      </fieldset>` : ''}

      <fieldset class="setup-group">
        <legend>${freeAvailable ? '①' : '①'} Paste an API key${freeAvailable ? '' : ' — easiest'}</legend>
        <label>Provider
          <select id="kpProvider"><option value="">-- Select --</option>${provOpts}</select>
        </label>
        <label>Model <select id="kpModel"></select></label>
        <label>API key <input type="password" id="kpKey" placeholder="Paste your key (e.g. sk-…)" /></label>
        <button class="btn btn-sm" id="btnKpSave">Connect</button>
        <span class="setup-msg" id="kpMsg"></span>
      </fieldset>

      <fieldset class="setup-group">
        <legend>② Use your Codex (ChatGPT) login</legend>
        <p>The "Sign in" button only completes if the Codex CLI is running on this same computer.
           Instead, upload the file the CLI already wrote when you ran <code>codex login</code>:<br>
           <code>~/.codex/auth.json</code> &nbsp;(Windows: <code>C:\\Users\\&lt;you&gt;\\.codex\\auth.json</code>).</p>
        <label>auth.json file <input type="file" id="cxFile" accept="application/json,.json" /></label>
        <label>…or paste its contents <textarea id="cxJson" rows="3" placeholder='{ "tokens": { "access_token": "…", "refresh_token": "…", "id_token": "…" } }'></textarea></label>
        <button class="btn btn-sm" id="btnCxImport">Import credentials</button>
        <span class="setup-msg" id="cxMsg"></span>
      </fieldset>

      <fieldset class="setup-group">
        <legend>③ Sign in with Claude (Anthropic)</legend>
        <p>Opens Anthropic in a new tab; you paste back the short code it shows you.</p>
        <button class="btn btn-sm" id="btnCcStart">Sign in with Claude</button>
        <div id="ccCodeBox" class="hidden">
          <label>Authorization code <input type="text" id="ccCode" placeholder="Paste the code" /></label>
          <button class="btn btn-sm" id="btnCcSubmit">Submit code</button>
        </div>
        <span class="setup-msg" id="ccMsg"></span>
      </fieldset>
    </div>`;

  // ⓪ Free shared model → one click, no key. Backed by the platform's pooled credentials;
  // the user never sees or handles any key.
  const btnFree = document.getElementById('btnFree');
  if (btnFree) {
    btnFree.addEventListener('click', async () => {
      setSetupMsg('freeMsg', 'Setting up…');
      btnFree.disabled = true;
      await setActiveProvider(freeModel.provider, freeModel.model);
      await confirmConnected('freeMsg');
      if (!llmActive) btnFree.disabled = false;
    });
  }

  // ① API key → set as default (flips hasActive)
  const kpProvider = document.getElementById('kpProvider');
  const kpModel = document.getElementById('kpModel');
  function fillModels() {
    const p = keyProviders.find((x) => x.id === kpProvider.value);
    kpModel.innerHTML = ((p && p.models) || []).map((m) =>
      `<option value="${escHtml(m.id)}"${m.id === (p && p.defaultModelId) ? ' selected' : ''}>${escHtml(m.name)}</option>`).join('') || '<option value="">(provider default)</option>';
  }
  kpProvider.addEventListener('change', fillModels);
  document.getElementById('btnKpSave').addEventListener('click', async () => {
    const p = keyProviders.find((x) => x.id === kpProvider.value);
    if (!p) { setSetupMsg('kpMsg', 'Pick a provider first.', 'err'); return; }
    const key = document.getElementById('kpKey').value.trim();
    if (!key) { setSetupMsg('kpMsg', 'Paste your API key first.', 'err'); return; }
    const model = kpModel.value || p.defaultModelId || '';
    setSetupMsg('kpMsg', 'Connecting…');
    const payload = { providerModelPreferences: { [p.id]: model }, actModeApiProvider: p.id, planModeApiProvider: p.id, actModeApiModelId: model, planModeApiModelId: model, mode: 'act' };
    if (p.secretKey) payload[p.secretKey] = key;
    try {
      const r = await (await fetch('/api/config', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json();
      if (!r || r.success === false) throw new Error((r && r.error) || 'save failed');
      await confirmConnected('kpMsg');
    } catch (e) { setSetupMsg('kpMsg', 'Could not connect: ' + e.message, 'err'); }
  });

  // ② Codex auth.json import
  let codexText = '';
  document.getElementById('cxFile').addEventListener('change', (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { codexText = rd.result; setSetupMsg('cxMsg', 'Loaded ' + f.name + ' — click Import.', 'ok'); };
    rd.onerror = () => setSetupMsg('cxMsg', 'Could not read that file.', 'err');
    rd.readAsText(f);
  });
  document.getElementById('btnCxImport').addEventListener('click', async () => {
    const text = codexText || document.getElementById('cxJson').value.trim();
    if (!text) { setSetupMsg('cxMsg', 'Choose your auth.json or paste its contents.', 'err'); return; }
    setSetupMsg('cxMsg', 'Importing…');
    try {
      const r = await (await fetch('/api/openai-codex/oauth/import', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ authJson: text }) })).json();
      if (!r || !r.success) throw new Error((r && r.error) || 'import failed');
      await setActiveProvider('openai-codex', 'gpt-5.3-codex');
      await confirmConnected('cxMsg');
    } catch (e) { setSetupMsg('cxMsg', 'Could not import: ' + e.message, 'err'); }
  });

  // ③ Claude Code paste-code flow
  document.getElementById('btnCcStart').addEventListener('click', async () => {
    setSetupMsg('ccMsg', 'Opening Anthropic…');
    try {
      const r = await (await fetch('/api/claude-code/auth/start', { credentials: 'include' })).json();
      if (!r || !r.success) throw new Error((r && r.error) || 'could not start');
      if (r.pendingAuthUrl) window.open(r.pendingAuthUrl, '_blank', 'noopener');
      document.getElementById('ccCodeBox').classList.remove('hidden');
      document.getElementById('ccCode').focus();
      setSetupMsg('ccMsg', 'Authorize, then paste the code.');
    } catch (e) { setSetupMsg('ccMsg', 'Could not start: ' + e.message, 'err'); }
  });
  document.getElementById('btnCcSubmit').addEventListener('click', async () => {
    const code = document.getElementById('ccCode').value.trim();
    if (!code) { setSetupMsg('ccMsg', 'Paste the code first.', 'err'); return; }
    setSetupMsg('ccMsg', 'Submitting…');
    try {
      const r = await (await fetch('/api/claude-code/auth/submit-code', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json();
      if (!r || !r.success) throw new Error((r && r.error) || 'submit failed');
      const cc = providersCache.find((p) => p.id === 'claude-code');
      await setActiveProvider('claude-code', cc ? cc.defaultModelId : '');
      await confirmConnected('ccMsg');
    } catch (e) { setSetupMsg('ccMsg', 'Could not connect: ' + e.message, 'err'); }
  });
}

// Why each kind of account is worth connecting — shown as the rationale in the connect step.
const CONNECT_CATEGORIES = [
  { key: 'email',    icon: '📧', title: 'Email & Calendar', why: 'Bots can triage your inbox, draft and send replies, and schedule events — so routine correspondence handles itself.' },
  { key: 'social',   icon: '📣', title: 'Social Media',     why: 'Bots can schedule and publish posts and watch for mentions, keeping your presence active without manual effort.' },
  { key: 'storage',  icon: '📦', title: 'Storage',          why: 'Bots can read, organize, and file documents in your cloud drives instead of you hunting through folders.' },
  { key: 'devops',   icon: '☁️', title: 'DevOps & Cloud',   why: 'Bots can work across your repos and cloud resources for code, builds, and infrastructure tasks.' },
  { key: 'iot',      icon: '🏠', title: 'Smart Home',       why: 'Bots can check and control connected devices on your behalf.' },
  { key: 'identity', icon: '🔑', title: 'Sign-in & Identity', why: 'Lets bots act as you across services you have already trusted.' },
];

/**
 * @description Onboarding step that explains WHY connecting accounts matters (so bots can act
 * for you) and the privacy model, then lists the available connectors grouped by purpose.
 * Connecting is optional — the real OAuth flow opens in a new tab so the wizard isn't lost,
 * and everything can also be done later in Utilities.
 */
async function renderConnectAccounts(container) {
  container.innerHTML = `<div class="step-content step-connect"><h2>Connect your accounts</h2><div class="config-loading">Loading connectors…</div></div>`;

  let providers = [];
  try {
    const d = await (await fetch('/api/connect/list', { credentials: 'include' })).json();
    providers = d.providers || [];
  } catch { /* show the explainer even if the list fails */ }
  let marketplaceEntries = [];
  try {
    const d = await (await fetch('/api/connectors/marketplace', { credentials: 'include' })).json();
    marketplaceEntries = d?.data?.entries || [];
  } catch { /* marketplace is additive; legacy connect list still renders */ }

  // Focused-app onboarding: offer ONLY the connectors the app declared it uses.
  if (appFocus && Array.isArray(appFocus.connectors)) {
    providers = providers.filter((p) => appFocus.connectors.includes(p.id));
    marketplaceEntries = marketplaceEntries.filter((e) => appFocus.connectors.includes(e.id));
  }

  const byCat = {};
  providers.forEach((p) => { const k = p.category || 'other'; (byCat[k] = byCat[k] || []).push(p); });

  const sections = CONNECT_CATEGORIES.filter((c) => (byCat[c.key] || []).length).map((c) => {
    const items = byCat[c.key].map((p) => {
      const connected = (p.connections || []).length > 0;
      if (connected) return `<span class="conn-chip conn-chip--on">✓ ${escHtml(p.label)}</span>`;
      const connectable = p.configured && p.auth !== 'token' && p.auth !== 'llm';
      return connectable
        ? `<button class="conn-chip" data-connect="${escHtml(p.id)}">Connect ${escHtml(p.label)}</button>`
        : `<span class="conn-chip conn-chip--soon">${escHtml(p.label)} (set up in Utilities)</span>`;
    }).join('');
    return `<div class="connect-cat"><div class="connect-cat-head"><span>${c.icon}</span><strong>${escHtml(c.title)}</strong></div>
      <p class="connect-why">${escHtml(c.why)}</p><div class="conn-chips">${items}</div></div>`;
  }).join('');

  container.innerHTML = `
    <div class="step-content step-connect">
      <h2>Connect your accounts <span class="optional-tag">optional</span></h2>
      <p>OSHAL bots can do real work for you — but only with the accounts you choose to connect here.
         Each connection is a separate, explicit consent: bots only touch what you grant, access is
         read-only where possible, and you can disconnect any time. Nothing is connected by default.</p>
      ${renderMarketplaceOnboarding(marketplaceEntries)}
      ${sections || '<p class="connect-why">No connectors are available in this deployment yet.</p>'}
      <div class="connect-footer">
        <a class="btn btn-sm" href="/utilities" target="_blank" rel="noopener">Open the full Connectors hub</a>
        <span class="setup-msg">You can skip this and do it later — click Next.</span>
      </div>
    </div>`;

  // Real OAuth flows redirect the whole tab, so open them in a new tab to preserve the wizard.
  container.querySelectorAll('[data-connect]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-connect');
      window.open('/api/connect/' + encodeURIComponent(id) + '/start?tenant=personal', '_blank', 'noopener');
      btn.textContent = 'Opened — finish in the new tab';
    });
  });
}

/**
 * @description "Stay in the loop" step — the per-user notification opt-in (text / call /
 * email / no thanks). Saves ONE row for the 'default' topic via POST /api/notify/prefs;
 * the NotificationRouter's DEFAULT_TOPIC fallback makes that answer govern every topic
 * the user hasn't customized. Text/call reveal a phone walk-through with a real
 * confirm-gated test send. Explicit "No thanks" writes channel 'none'; just clicking
 * Next writes nothing. Never gates navigation.
 */
async function renderNotifyStep(container) {
  container.innerHTML = `<div class="step-content step-connect"><h2>Stay in the loop</h2><div class="config-loading">Loading…</div></div>`;

  let saved = null;
  try {
    const d = await (await fetch('/api/notify/prefs', { credentials: 'include' })).json();
    saved = (d.prefs || []).find((p) => p.topic === 'default') || null;
  } catch { /* first visit or guest — render the fresh form */ }

  const CHOICES = [
    { key: 'sms',   icon: '📱', label: 'Text me',  needsPhone: true },
    { key: 'voice', icon: '📞', label: 'Call me',  needsPhone: true },
    { key: 'email', icon: '✉️', label: 'Email me', needsPhone: false },
    { key: 'none',  icon: '🔕', label: 'No thanks', needsPhone: false },
  ];
  let chosen = saved ? saved.channel : null;

  const draw = () => {
    const chips = CHOICES.map((c) => {
      const on = chosen === c.key;
      return `<button class="conn-chip${on ? ' conn-chip--on' : ''}" data-notify-choice="${c.key}">${c.icon} ${escHtml(c.label)}${on ? ' ✓' : ''}</button>`;
    }).join('');
    const needsPhone = chosen === 'sms' || chosen === 'voice';
    container.innerHTML = `
      <div class="step-content step-connect">
        <h2>Stay in the loop <span class="optional-tag">optional</span></h2>
        <p>When something worth knowing happens — a job finishes, a digest lands, an alert fires —
           oshal can reach you off-screen. Your choice here covers everything unless you customize a
           specific topic later; nothing is sent without it. Telegram can be added later in Settings.</p>
        <div class="conn-chips">${chips}</div>
        ${needsPhone ? `
        <div class="setup-group" style="margin-top:1rem;max-width:22rem;">
          <label for="notifyPhone">Your mobile number</label>
          <input id="notifyPhone" type="tel" placeholder="+15551234567" value="${escHtml((saved && saved.phone) || '')}" autocomplete="tel" />
          <div style="margin-top:0.6rem;">
            <button class="btn btn-sm btn-primary" id="notifySave">Save</button>
            <button class="btn btn-sm" id="notifyTest" ${saved && saved.phone && saved.channel === chosen ? '' : 'disabled'}>Send me a test</button>
            <span class="setup-msg" id="notifyMsg"></span>
          </div>
        </div>` : ''}
        ${chosen === 'email' ? `<p class="setup-msg" id="notifyEmailNote">Uses your connected Gmail — connect Google on the previous step if you haven't.</p>
          <button class="btn btn-sm btn-primary" id="notifySave" style="margin-top:0.4rem;">Save</button>
          <button class="btn btn-sm" id="notifyTest" ${saved && saved.channel === 'email' ? '' : 'disabled'}>Send me a test</button>
          <span class="setup-msg" id="notifyMsg"></span>` : ''}
        ${chosen === 'none' ? `<p class="setup-msg">Got it — nothing will be sent. Click Next to continue.</p>` : ''}
        <div class="connect-footer"><span class="setup-msg">You can change this any time — or skip with Next.</span></div>
      </div>`;
    bind();
  };

  const setMsg = (text, cls) => {
    const el = container.querySelector('#notifyMsg');
    if (el) { el.textContent = text; el.className = 'setup-msg' + (cls ? ' ' + cls : ''); }
  };

  const savePref = async (channel, phone) => {
    const body = { topic: 'default', channel, enabled: true, phone: phone || null, telegramChatId: (saved && saved.telegramChatId) || null };
    const res = await fetch('/api/notify/prefs', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || ('save failed (' + res.status + ')'));
    saved = d.pref || body;
  };

  const bind = () => {
    container.querySelectorAll('[data-notify-choice]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        chosen = btn.getAttribute('data-notify-choice');
        if (chosen === 'none') {
          // An explicit decline is a real answer — persist it so even the email default stays quiet.
          try { await savePref('none', null); } catch { /* best-effort; never blocks Next */ }
        }
        draw();
      });
    });
    const saveBtn = container.querySelector('#notifySave');
    if (saveBtn) saveBtn.addEventListener('click', async () => {
      const phoneEl = container.querySelector('#notifyPhone');
      const phone = phoneEl ? phoneEl.value.trim() : null;
      if ((chosen === 'sms' || chosen === 'voice') && !/^\+[1-9]\d{6,14}$/.test(phone || '')) {
        setMsg('Enter your number in international format, e.g. +15551234567', 'err');
        return;
      }
      setMsg('Saving…');
      try {
        await savePref(chosen, phone);
        setMsg('Saved ✓ — try a test!', 'ok');
        const t = container.querySelector('#notifyTest');
        if (t) t.disabled = false;
      } catch (e) { setMsg(String(e.message || e), 'err'); }
    });
    const testBtn = container.querySelector('#notifyTest');
    if (testBtn) testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      setMsg(chosen === 'voice' ? 'Calling you…' : 'Sending…');
      try {
        const res = await fetch('/api/notify/test', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true, topic: 'default' }),
        });
        const d = await res.json().catch(() => ({}));
        if (res.ok && d.delivered) setMsg(chosen === 'voice' ? 'Your phone should ring ✓' : chosen === 'sms' ? 'Check your phone 📳' : 'Check your inbox ✓', 'ok');
        else setMsg('Not delivered — ' + (d.reason || d.error || 'unknown') + '. You can finish setup later in Settings.', 'warn');
      } catch { setMsg('Test failed to send — you can finish setup later in Settings.', 'warn'); }
      testBtn.disabled = false;
    });
  };

  draw();
}

function renderMarketplaceOnboarding(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return '';
  }
  const count = (predicate) => entries.filter(predicate).length;
  const stats = [
    { label: 'Catalog', value: entries.length, detail: 'audited definitions' },
    { label: 'Self-serve', value: count((entry) => entry.onboarding?.setupLevel === 'self-serve'), detail: 'user key/basic paths' },
    { label: 'OAuth apps', value: count((entry) => entry.onboarding?.mode === 'oauth-app'), detail: 'operator app + consent' },
    { label: 'No credential', value: count((entry) => entry.onboarding?.mode === 'no-auth'), detail: 'ready after enable' },
    { label: 'Write-capable', value: count((entry) => (entry.writeCount || 0) > 0), detail: 'confirmation required' },
  ];
  return `<div class="connect-marketplace">
    <div class="connect-marketplace-head">
      <strong>Connector setup paths</strong>
      <a href="/cockpit" target="_blank" rel="noopener">Open marketplace</a>
    </div>
    <div class="connect-marketplace-grid">
      ${stats.map((stat) => `<div class="connect-marketplace-stat"><b>${Number(stat.value).toLocaleString()}</b><span>${escHtml(stat.label)}</span><em>${escHtml(stat.detail)}</em></div>`).join('')}
    </div>
    <p>Enable a connector definition first, then each user adds their own credential through the broker. OAuth providers still need a provider app registration before normal users can consent.</p>
  </div>`;
}

// Each capability maps to one or more swarm apps (manifests in swarm-apps/).
// Ticking a capability hot-loads its app(s) on Finish so the cockpit arrives
// already set up. "build" has no app to load — the Bot Forge is core.
const CAPABILITIES = [
  { key: 'home',  icon: '🏠', title: 'Smart Home & IoT',          desc: 'Check and control your connected devices.',                    apps: ['home'] },
  { key: 'money', icon: '💰', title: 'Money & Finance',            desc: 'Net worth, holdings, spend, payments, and trading.',           apps: ['trading'] },
  { key: 'media', icon: '🎬', title: 'Media & Going Out',          desc: 'Movies, music, food, rides, and travel.',                      apps: ['travel'] },
  { key: 'comms', icon: '📣', title: 'Email, Social & Feeds',      desc: 'Triage your inbox, post and watch social, news feeds.',        apps: ['email-summarizer', 'social', 'feeds'] },
  { key: 'jobs',  icon: '💼', title: 'Job Opportunities',          desc: 'Surface roles you fit and strengthen your resume.',            apps: ['career-hunter'] },
  { key: 'office', icon: '📊', title: 'Documents & Presentations',  desc: 'Draft decks, documents, and spreadsheets — edit in Office, Docs, or LibreOffice.', apps: ['presentations'] },
  { key: 'build', icon: '🛠️', title: 'Build My Own Bots',          desc: 'Describe a bot in plain language; it goes live in the swarm.',  apps: [] },
];

/**
 * @description "Choose what it does" step — multi-select capability checkboxes.
 * Each ticked capability's swarm app(s) are hot-loaded on Finish via the existing
 * POST /api/swarm/apps/load, so the new user lands in a cockpit already set up for
 * what they care about. Reads the live pending/active app lists so we only offer
 * to install apps that exist and aren't already loaded.
 */
async function renderCapabilities(container) {
  container.innerHTML = `<div class="step-content step-features"><h2>Choose what it does</h2><div class="config-loading">Loading…</div></div>`;
  try {
    const [pend, act] = await Promise.all([
      fetch('/api/swarm/apps/pending', { credentials: 'include' }).then((r) => r.json()).catch(() => ({ pending: [] })),
      fetch('/api/swarm/apps', { credentials: 'include' }).then((r) => r.json()).catch(() => ({ apps: [] })),
    ]);
    availableAppPaths = {};
    (pend.pending || []).forEach((p) => { availableAppPaths[p.name] = p.path; });
    activeAppNames = new Set((act.apps || []).map((a) => a.name));
  } catch { /* offer everything; install is best-effort */ }

  const toggle = (key) => {
    if (selectedCapabilities.has(key)) selectedCapabilities.delete(key); else selectedCapabilities.add(key);
    try { localStorage.setItem('oshal-onboard-caps', JSON.stringify([...selectedCapabilities])); } catch { /* no storage */ }
    container.querySelectorAll('[data-cap]').forEach((el) => {
      const on = selectedCapabilities.has(el.getAttribute('data-cap'));
      el.classList.toggle('cap-card--on', on);
      const chk = el.querySelector('.cap-check'); if (chk) chk.textContent = on ? '✓' : '+';
    });
  };
  const statusFor = (cap) => {
    if (cap.apps.length && cap.apps.every((n) => activeAppNames.has(n))) return '<span class="cap-note">already installed</span>';
    return '';
  };

  container.innerHTML = `
    <style>
      .cap-card { border: 1px solid transparent; cursor: pointer; text-align: left; position: relative; transition: border-color .15s ease, background .15s ease; }
      .cap-card--on { border-color: var(--wiz-accent, #58a6ff) !important; background: rgba(88,166,255,.12); }
      .cap-check { position: absolute; top: 10px; right: 12px; opacity: .35; font-weight: 700; }
      .cap-card--on .cap-check { opacity: 1; color: var(--wiz-accent, #58a6ff); }
      .cap-note { display: inline-block; margin-top: 6px; font-size: 11px; opacity: .7; }
      .cap-foot { margin-top: 16px; font-size: 12px; opacity: .75; line-height: 1.5; }
    </style>
    <div class="step-content step-features">
      <h2>Choose what it does</h2>
      <p>Tick what you want and we'll set those apps up now. Add or remove any of it later from Explore Apps — nothing is locked in.</p>
      <div class="feature-grid">
        ${CAPABILITIES.map((c) => `
          <button type="button" class="feature-card cap-card${selectedCapabilities.has(c.key) ? ' cap-card--on' : ''}" data-cap="${c.key}" style="cursor:pointer;text-align:left;">
            <span class="cap-check">${selectedCapabilities.has(c.key) ? '✓' : '+'}</span>
            <span class="feature-icon">${c.icon}</span>
            <strong>${escHtml(c.title)}</strong>
            <span class="feature-desc">${escHtml(c.desc)}</span>
            ${statusFor(c)}
          </button>`).join('')}
      </div>
      <p class="cap-foot">↻ Apps you turn on keep themselves up to date on a schedule once their account is connected — you're always in control; pause any of it later in Settings.</p>
    </div>`;

  container.querySelectorAll('[data-cap]').forEach((el) => {
    el.addEventListener('click', () => toggle(el.getAttribute('data-cap')));
  });
}

/**
 * @description Hot-loads the swarm app(s) for every ticked capability via the
 * existing POST /api/swarm/apps/load {path}. Best-effort and idempotent: skips
 * apps already active or without a known manifest path, and a failed install
 * never blocks finishing onboarding. Called on Finish.
 */
async function installSelectedApps() {
  const paths = new Set();
  for (const key of selectedCapabilities) {
    const cap = CAPABILITIES.find((c) => c.key === key);
    if (!cap) continue;
    for (const name of cap.apps) {
      if (!activeAppNames.has(name) && availableAppPaths[name]) paths.add(availableAppPaths[name]);
    }
  }
  for (const path of paths) {
    try {
      await fetch('/api/swarm/apps/load', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
    } catch { /* best-effort */ }
  }
}

function renderDone(container) {
  container.innerHTML = `
    <div class="step-content step-done">
      <div class="done-icon">🚀</div>
      <h2>You're All Set!</h2>
      <p>Your OSHAL control plane is ready. Click below to go to your dashboard.</p>
      <div class="done-tips">
        <h3>Quick Tips</h3>
        <ul>
          <li>Use the <strong>ribbon nav</strong> on the left to switch between views</li>
          <li>The <strong>right rail</strong> is your always-available bot chat panel</li>
          <li>Press <kbd>Ctrl+K</kbd> to open the command palette</li>
          <li>Check the <strong>Dashboard</strong> for spend tracking and swarm health</li>
        </ul>
      </div>
      <div class="done-tips">
        <h3>Run it anywhere</h3>
        <ul>
          <li><strong>Install as an app</strong> — in the cockpit, use your browser's <em>Install</em> / Add to Home Screen. Works on phone and desktop (PWA).</li>
          <li><strong>Desktop app</strong> — an Electron build lives in <code>packages/oshal-chat</code> (also turns the machine into a swarm worker).</li>
          <li><strong>Run it at home</strong> — one command on your own box: <code>bash scripts/install.sh</code>.</li>
          <li><strong>Native iOS / Android</strong> — on the roadmap; the installable PWA above is the mobile path today.</li>
        </ul>
      </div>
    </div>`;
}
