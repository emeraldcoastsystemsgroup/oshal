/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Shared shell kernel for every experience layout: the experience chooser bar, device-local pins, the application directory, application and work-item panels over live summaries, the people and provenance panels, and the Jarvis conversation engine (history + ask/result) that Studio, Jarvis, Orbit, Commons, the homebases and the central assistant all reuse instead of fixtures.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Render the assistant's markdown links to same-origin paths and http(s) URLs as anchors after escaping, so an answer that names an application opens it instead of showing raw brackets.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Audience-aware hosting: one withAudience helper appends the layout's `?audience=` to every in-place frame (existing query, hash and audience kept), behind a device-remembered Summary view / Full application switch whose copy leaves the choice of view to the hosted page. The app panel reads the package record lazily (GET /api/swarm/apps/:name, and each installed member of a group) to list declared assistants by name with the concierge marked and online state only where the overview roster joins, and labels relationships as group members or Required / Optional app dependencies (not installed when absent from the catalog; a mixed dependency block shows a neutral note instead of tiers). The Commons game predicate moves here as isGameApp so the directory's Games chip and the Game room share it, and a layout may opt its People panel into the swarm roster from GET /api/user-directory with the non-admin fallback to the caller's own identity.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | A dependency absent from the caller's catalog is labelled 'not in your catalog': the catalog lists active apps visible to this viewer, so an installed but inactive or person-scoped app is not proof of 'not installed'
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Integration review: every server-provided link the shell puts in an href (the shared hand-off chip, a '/' link in an answer, a file download) goes through LIVE.localHref, so a target that resolves off this origin ('//host', '/\host', a tab-split path) is never linked; the Games chip's visible label carries the hedge ('Looks like a game'); a roster 403 with roster_scope_denied says this session is not permitted to read the roster instead of blaming a missing admin role.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Fix round 1: states the one exception to row 5. Only '/' answer links, hand-off chips, file downloads and admitted workspace links go through LIVE.localHref; an absolute http(s) answer link is outside the same-origin guard by design and opens in a new tab with noopener noreferrer. A dot-segment answer link such as '[x](/..//host/y)' now stays literal text because the guard refuses it.
 * 7 | maintainer@emeraldcoastsystemsgroup.com | The attention list reads the shared status groups (LIVE.STATUS_GROUPS.attention), so an approval gate, a customer action and a parked (dead-letter) ticket lead the briefing with the other items that wait on the person.
 * 8 | maintainer@emeraldcoastsystemsgroup.com | Work panels for layouts that opt in (hooks.workActions, with shell-panels.js loaded): a ticket, or the ticket behind a swarm task, reads its workflow (GET /api/v1/tickets/:id/workflow) and state (GET /api/tickets/:id) once per panel; the panel shows recorded progress and stages, a full ticket-workflow panel, Approve (approval_required to approved through PUT /api/tickets/:id/status, only when a person is what it waits for) and Cancel behind a confirmation (PUT /api/tickets/:id/cancel). A refusal is shown in the panel as returned; a success reloads the caller's work and re-renders through hooks.onWorkChanged. Working rows carry an indeterminate bar. Homebase and the central assistant do not opt in and are unchanged.
 * 9 | maintainer@emeraldcoastsystemsgroup.com | Routines panel (kind 'routines', layouts that opt in): reads the caller's schedules and the Workflow Studio definitions once per page, and each own prompt schedule's switch pauses or resumes it through POST /api/v1/agent/schedules/:id/pause|resume; a refusal puts the switch back and says why. The application panel offers 'Its routines' (that application's routines first).
 * 10 | maintainer@emeraldcoastsystemsgroup.com | Day focus picker in the study bar for layouts that opt in (hooks.scenes): 'A workday' or 'An evening at home', saved per layout on this device (oshal-experience:scene:<layout>, ADR-164 D9), never sent to a server; setScene re-renders the layout through hooks.onSceneChanged.
 * 11 | maintainer@emeraldcoastsystemsgroup.com | Visual cards for layouts that opt in: visualFor(app, latest) pictures an application or a work item (the application panel and the work panel carry one) and fillVisuals draws the Finance picture from one GET /api/finance/summary per page, only for a Finance the caller's plan admits.
 * 12 | maintainer@emeraldcoastsystemsgroup.com | The application panel carries its package facts (a 'facts' detail part for layouts with shell-panels.js); a detail slot can render related applications with another action (select-app navigates instead of opening a panel); pinning in the directory keeps the keyboard on the same application's pin after the grid is rebuilt; appCard is exported for the Commons room grid.
 * 13 | maintainer@emeraldcoastsystemsgroup.com | Household and team membership and the caller's own place for layouts with shell-panels.js: fillPeople reads GET /api/tenants, the chosen tenant's GET /api/tenants/:id/members and the caller's GET /api/location/state once per page; the People panel adds 'Your household or team', the caller's roster row carries their place, and a roster read afterwards names the members it knows.
 * 14 | maintainer@emeraldcoastsystemsgroup.com | 'What is live in this view' lists the reads a layout makes on demand (routines, Workflow Studio definitions, households and teams, the caller's own place, Finance spend, a ticket's workflow) with each one's status once made or 'read when you open it', and says only the caller's own place is shown; a game-like application's panel lists the other games on this swarm (the demo's game room offered them).
 * 15 | maintainer@emeraldcoastsystemsgroup.com | The experience list gains Simple chat (/simple, docs/architecture/simple-chat.md), the opt-in plain text screen over the caller's Jarvis thread; every other entry is unchanged.
 * 16 | maintainer@emeraldcoastsystemsgroup.com | Discover and host installed experience packages through current authorization, preserving member visibility and supported assets.
 * 17 | maintainer@emeraldcoastsystemsgroup.com | Select the current package identity in the chooser before interpreting legacy layout names.
 * 18 | maintainer@emeraldcoastsystemsgroup.com | Distinguish loading, partial and unavailable work from successful empty reads; preserve admitted rows and unknown counts with accessible retry.
 * 19 | maintainer@emeraldcoastsystemsgroup.com   | Describe caller-bound communications and calendar separately from intentionally omitted global assistant status using the same overview receipt.
 * 20 | maintainer@emeraldcoastsystemsgroup.com | Carry read-only selected-app context, revalidate foreground member navigation and every reopened tool frame before loading, and retain backward draft selection during retry.
 */
(() => {
  'use strict';
  const LIVE = window.OSHAL_LIVE;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const button = (label, action, cls = 'action', data = '') => `<button type="button" class="${cls}" data-action="${action}" ${data}>${label}</button>`;
  const primary = (label, action, data = '') => button(label, action, 'action primary', data);
  const link = (label, href, cls = 'action', extra = '') => `<a class="${cls}" href="${esc(href)}" ${extra}>${label}</a>`;
  const avatar = (text, cls = 'bot') => `<span class="avatar ${cls}" aria-hidden="true">${esc(text)}</span>`;
  const badge = (text, neutral = false) => `<span class="badge${neutral ? ' neutral' : ''}">${esc(text)}</span>`;

  /** The selectable experiences. Order is the chooser order; `skin` is the palette each opens with. */
  const LEGACY_EXPERIENCES = [
    { id: 'studio', label: 'Studio', href: '/studio', skin: 'studio', family: 'full', tagline: 'Conversation first', palette: 'Graphite & mint' },
    { id: 'jarvis', label: 'Jarvis', href: '/jarvis', skin: 'jarvis', family: 'full', tagline: 'Assistant first', palette: 'Parchment & ember' },
    { id: 'orbit', label: 'Orbit', href: '/orbit', skin: 'orbit', family: 'full', tagline: 'Connections first', palette: 'Arctic & cobalt' },
    { id: 'commons', label: 'Commons', href: '/commons', skin: 'commons', family: 'full', tagline: 'People first', palette: 'Aubergine & lilac' },
    { id: 'family', label: 'Home · family homebase', href: '/homebase?preset=family', skin: 'family', family: 'homebase', tagline: 'Shared life, personal space', palette: 'Cozy sage' },
    { id: 'classroom', label: 'Little Monsters · classroom', href: '/homebase?preset=classroom', skin: 'classroom', family: 'homebase', tagline: 'Teacher and learner views', palette: 'Playful violet' },
    { id: 'company', label: 'Business · company swarm', href: '/homebase?preset=company', skin: 'company', family: 'homebase', tagline: 'Projects, people, workspace', palette: 'Slate & teal' },
    { id: 'nexus', label: 'Central assistant', href: '/nexus', skin: 'nexus', family: 'assistant', tagline: 'Intent first', palette: 'Luminous cyan' },
    { id: 'simple', label: 'Simple chat', href: '/simple', skin: 'simple', family: 'assistant', tagline: 'Just type', palette: 'Your theme' }
  ];
  const EXPERIENCES = [];
  const readyExperiences = fetch('/api/ui/experiences', { credentials: 'same-origin', cache: 'no-store' })
    .then(async response => {
      if (!response.ok) throw new Error('Experience discovery unavailable');
      const data = await response.json();
      if (!Array.isArray(data.experiences)) throw new Error('Invalid experience discovery');
      for (const row of data.experiences) {
        if (typeof row.app !== 'string' || typeof row.label !== 'string' || typeof row.skin !== 'string') continue;
        const style = LEGACY_EXPERIENCES.find(e => e.skin === row.skin);
        EXPERIENCES.push({ ...style, id: row.app, label: row.label, skin: row.skin,
          href: `/api/ui/experiences/${encodeURIComponent(row.app)}/open`, skinCssUrl: LIVE.localHref(row.skinCssUrl || '') });
      }
      window.dispatchEvent(new CustomEvent('oshal-experiences-ready', { detail: EXPERIENCES }));
      document.querySelectorAll('[data-role="experience-picker"]').forEach(picker => {
        const selected = currentExperience();
        picker.outerHTML = pickerMarkup(selected?.id || '', picker.id);
      });
      return EXPERIENCES;
    }).catch(() => null);
  const experienceFor = id => EXPERIENCES.find(e => e.id === id || e.skin === id) || null;
  function currentExperience() {
    const packageApp = document.body.dataset.experienceApp;
    if (packageApp) return experienceFor(packageApp);
    const preset = new URLSearchParams(location.search).get('preset');
    return experienceFor(preset || document.body.dataset.layout || '');
  }
  function pickerMarkup(currentId, id = 'experience-picker') {
    const selectedId = experienceFor(document.body.dataset.experienceApp || currentId)?.id || '';
    const options = EXPERIENCES.map(e => `<option value="${esc(e.id)}"${e.id === selectedId ? ' selected' : ''}>${esc(e.label)}</option>`).join('');
    return `<select aria-label="Experience" id="${id}" class="layout-picker" data-role="experience-picker"${EXPERIENCES.length < 2 ? ' hidden' : ''}>${options}</select>`;
  }
  function skinPicker(currentSkin) {
    const switcher = window.OSHAL_STYLE_SWITCHER;
    return switcher ? switcher.buildSelectMarkup(currentSkin || switcher.currentSkin()) : '';
  }
  /** @description Light, safe rendering of an assistant answer: escaped paragraphs, bullet lists and bold. */
  function answerHtml(text) {
    const inline = s => esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      // [label](/path) or [label](https://…) as the assistant writes them; a path that resolves off this origin, and anything else, stays literal text.
      // Only '/' links are same-origin-guarded; an absolute http(s) link is outside that guard by design and opens in a new tab with noopener noreferrer.
      .replace(/\[([^\]\n]{1,120})\]\(((?:\/(?!\/)|https?:\/\/)[^\s()<>"']{1,400})\)/g, (whole, label, href) => {
        if (!href.startsWith('/')) return `<a href="${href}" rel="noopener noreferrer" target="_blank">${label}</a>`;
        const local = LIVE.localHref(href);
        return local ? `<a href="${local}">${label}</a>` : whole;
      });
    return String(text || '').trim().split(/\n{2,}/).filter(Boolean).map(block => {
      const lines = block.split('\n');
      if (lines.every(l => /^\s*[-*•]\s+/.test(l))) return `<ul class="artifact-steps">${lines.map(l => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>`).join('')}</ul>`;
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    }).join('') || '<p class="muted">No answer text was returned.</p>';
  }
  const chip = h => { const href = h ? LIVE.localHref(h.deepLink) : ''; return href ? link(`Open ${esc(h.name || 'application')} ↗`, href, 'mini-app') : ''; };
  const fileLink = f => { const href = f ? LIVE.localHref(f.downloadUrl || f.url) : ''; return href.startsWith('/api/') ? link(`↓ ${esc(f.name || 'file')}`, href, 'quiet-link', 'download') : ''; };

  /**
   * @description Ask a hosted page for an audience view (ADR-164 D6). The parameter is a request the page may
   * honour, never authority, so the URL's own query and hash are kept as written and an audience the URL
   * already names is never overridden.
   * @param {string} url The application surface to frame.
   * @param {string} audience The layout's audience id (family, company, ...); empty leaves the URL as is.
   * @returns {string} The URL with `audience=` appended once.
   */
  function withAudience(url, audience) {
    const raw = String(url || '');
    if (!raw || !audience) return raw;
    const hashAt = raw.indexOf('#'), base = hashAt < 0 ? raw : raw.slice(0, hashAt), hash = hashAt < 0 ? '' : raw.slice(hashAt);
    const queryAt = base.indexOf('?');
    if (queryAt >= 0 && new URLSearchParams(base.slice(queryAt + 1)).has('audience')) return raw;
    const joiner = queryAt < 0 ? '?' : /[?&]$/.test(base) ? '' : '&';
    return `${base}${joiner}audience=${encodeURIComponent(audience)}${hash}`;
  }
  /** Chip title for the Games filter: it is a name match inside the Creative & games suite, not a manifest marker. */
  const GAMES_TITLE = 'Creative apps that look like games';
  /**
   * @description The one games predicate the directory chip and the Commons Game room share. No manifest field
   * marks a game, so this is a heuristic: a Creative & games suite member whose name reads like a game.
   * @param {object} app A catalog entry.
   * @returns {boolean} True when the entry looks like a game.
   */
  const isGameApp = app => Boolean(app) && app.suite === 'ai-creative' && /game|dungeon|arcade|show/i.test(`${app.name} ${app.id}`);
  const ASSISTANT_STATE = { working: 'working now', online: 'online', offline: 'offline', declared: 'declared in the package' };
  /**
   * @description Why the swarm roster is not listed, from the directory route's own refusal code: roster_scope_denied
   * means this session's permission scope excludes the read (the account may well be an admin); roster_administrator_required,
   * or any other 403, means only a swarm admin may list everyone.
   * @param {{status: number, error: string}} roster The refused directory read.
   * @returns {string} The sentence the roster slot shows beside the caller's own identity.
   */
  function rosterRefusal(roster) {
    if (roster.status !== 403) return `The swarm roster could not be read (HTTP ${roster.status || 'network'}), so only your own identity is shown.`;
    return roster.error === 'roster_scope_denied' ? 'This session is not permitted to read the roster. Only your own identity is shown.' : 'Only a swarm admin can list everyone on this swarm, so only your own identity is shown.';
  }

  /** @description Keep unsent own-shell fields through a recovery repaint, including edits made while reads are pending. @param {Function} repaint Current renderer callback. @returns {boolean} Whether an active edit retained focus. */
  function repaintWithDrafts(repaint) {
    const active = document.activeElement && document.activeElement.id;
    const drafts = ['composer-input', 'shopping-input', 'home-search-input', 'message-input', 'ask-input'].flatMap(id => {
      const input = document.getElementById(id);
      return input ? [{ id, value: input.value, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection }] : [];
    });
    repaint();
    let editing = false;
    drafts.forEach(draft => {
      const input = document.getElementById(draft.id); if (!input) return;
      input.value = draft.value;
      if (draft.id === active && !input.disabled) { input.focus(); input.setSelectionRange(draft.start, draft.end, draft.direction); editing = true; }
    });
    return editing;
  }

  /** @description Bind source-state presentation and read-only recovery. @param {object} snapshot Current live snapshot. @param {Function} repaint Current renderer callback. @param {Function} canRetry Whether repaint would preserve an open member view. @returns {object} Presentation helpers. */
  function createWorkPresentation(snapshot, repaint, canRetry) {
    /** @description Read current source readiness. @param {string[]} [keys] Source names. @returns {object} Presentation state. */
    const workState = keys => LIVE.sourceState(snapshot, keys);
    /** @description Scope counts to loaded work. @param {number} count Visible rows. @param {string} label Count label. @returns {string} Exact, partial or unknown count. */
    function workCount(count, label = 'items') {
      const read = workState();
      return read.complete ? `${count} ${label}` : read.kind === 'partial' && count ? `${count} ${label} loaded` : read.kind === 'loading' ? 'Work loading' : 'Work unavailable';
    }
    /** @description Never infer online assistants from failed overview reads. @param {string} label Successful count text. @returns {string} Exact count or unknown state. */
    const overviewCount = label => workState(['overview']).complete ? label : workState(['overview']).kind === 'loading' ? 'Assistant status loading' : 'Assistant status unavailable';
    /** @description Show genuine empty only after successful reads. @param {string} empty Successful empty wording. @param {string[]} [keys] Required sources. @returns {string} Escaped status markup. */
    const workEmpty = (empty, keys) => `<p class="note-line">${esc(workState(keys).complete ? empty : workState(keys).message)}</p>`;
    /** @description Display incomplete sources and accessible recovery. @param {string[]} [keys] Required sources. @returns {string} Notice or nothing on success. */
    function workNotice(keys = ['tickets', 'tasks', 'overview']) {
      const read = workState(keys); if (read.complete) return '';
      const blocked = !canRetry();
      return `<div class="note-line work-source-status" data-work-source-state="${read.kind}" role="status"><p>${esc(read.message)}</p>${read.kind === 'loading' ? '' : button('Retry work sources', 'retry-work', 'action button', blocked ? 'disabled' : '')}${blocked ? '<p>Close the application view before retrying work sources.</p>' : ''}</div>`;
    }
    /** @description Retry current read-only paths, retaining keyboard focus after repaint. @returns {Promise<void>} Resolves after refreshed states and rows. */
    async function retryWork() {
      if (snapshot.workLoading || !canRetry()) return;
      snapshot.workLoading = true;
      repaintWithDrafts(repaint);
      try { await LIVE.loadWork(snapshot); }
      finally {
        snapshot.workLoading = false;
        const editing = repaintWithDrafts(repaint);
        if (!editing) {
          const focus = document.querySelector('#full-dialog [data-action="retry-work"]') || document.querySelector('#full-dialog h2') || document.querySelector('[data-action="retry-work"]') || document.querySelector('main h1');
          if (focus) { if (!focus.matches('button')) focus.setAttribute('tabindex', '-1'); focus.focus(); }
        }
      }
    }
    /** @description Compact unknown values preserve numeric layouts. @param {number} count Loaded value. @param {string[]} [keys] Required sources. @returns {string} Exact value or unknown marker. */
    const workValue = (count, keys) => workState(keys).complete ? String(count) : '—';
    return { workState, workCount, overviewCount, workEmpty, workNotice, retryWork, workValue };
  }

  /** @description Create the per-page shell kernel over a loaded snapshot. */
  function createShell(options) {
    const snapshot = options.snapshot, layoutId = options.layoutId, hooks = options.hooks || {};
    const dialogClass = options.dialogClass || 'dialog-backdrop', drawerClass = options.drawerClass || 'drawer';
    const apps = snapshot.apps, suites = snapshot.suites, work = snapshot.work;
    const byId = id => apps.find(a => a.id === id) || null;
    const suiteOf = id => suites.find(s => s.id === id) || LIVE.SUITE_META[id] && Object.assign({ id, count: 0, apps: [] }, LIVE.SUITE_META[id]) || suites[suites.length - 1];
    const state = { modal: null, dirSuite: 'all', dirQuery: '', returnFocus: null, pins: null, summaries: new Map(), embed: false, details: new Map(), detailReads: new Map(), roster: null, rosterRead: null, workFlows: new Map(), workReads: new Set(), routines: null, workflowsList: null, routinesRead: false, spend: null, spendRead: null, membership: null, membershipRead: null, place: null, placeRead: null };
    state.embedView = LIVE.prefs.get('embed-view:' + layoutId, 'summary') === 'full' ? 'full' : 'summary';
    state.scene = window.OSHAL_LIVE_VIEWS ? window.OSHAL_LIVE_VIEWS.sceneOf(LIVE.prefs.get('scene:' + layoutId, 'workday')).id : 'workday';
    const savedPins = LIVE.prefs.get('pins:' + layoutId, null);
    const busiest = s => s.apps.map(a => [a, work.filter(w => w.app === a.id).length]).sort((x, y) => y[1] - x[1] || Number(y[0].probes.length > 0) - Number(x[0].probes.length > 0))[0];
    const defaultPins = suites.map(s => (busiest(s) || [])[0] || s.spotlight).filter(a => a && a.navigable).map(a => a.id).slice(0, 6);
    state.pins = (Array.isArray(savedPins) ? savedPins : defaultPins).filter(byId);
    const savePins = () => LIVE.prefs.set('pins:' + layoutId, state.pins);
    const pinned = () => state.pins.map(byId).filter(Boolean);
    const isPinned = id => state.pins.includes(id);
    const workFor = appId => work.filter(w => w.app === appId);
    const openWork = () => work.filter(w => w.status.open);
    const needsYou = w => LIVE.STATUS_GROUPS.attention.includes(w.status.label);
    const attention = () => work.filter(needsYou).concat(openWork().filter(w => !needsYou(w)));
    const { workState, workCount, overviewCount, workEmpty, workNotice, retryWork, workValue } = createWorkPresentation(snapshot, () => { if (hooks.onWorkChanged) hooks.onWorkChanged(); else if (state.modal) renderModal(); }, () => !(state.modal && state.modal.kind === 'embed') && (!hooks.canRetryWork || hooks.canRetryWork()));
    const timeAgo = item => LIVE.relativeTime(item.at);
    let toastTimer = 0;

    const appMark = (app, cls = '') => `<span class="app-mark ${cls}" style="--suite-color:${suiteOf(app.suite).accent}" aria-hidden="true">${esc(LIVE.initials(app.name))}</span>`;
    const statusBadge = status => `<span class="badge neutral tone-${status.tone}">${esc(status.label)}</span>`;
    const miniApp = (app, action = 'open-app') => button(`${appMark(app)}<span><strong>${esc(app.name)}</strong><small>${esc(latestLine(app))}</small></span>`, action, 'mini-app', `data-app="${esc(app.id)}"`);
    function latestLine(app) {
      const latest = workFor(app.id)[0];
      if (latest) return `${latest.status.label} · ${latest.title}`;
      return app.navigable ? suiteOf(app.suite).name : 'Not available in this workspace';
    }
    /** The full-swarm work panel extras (workflow, actions, progress) load only where the layout opts in and ships shell-panels.js. */
    const panels = () => (hooks.workActions && window.OSHAL_SHELL_PANELS) || null;
    const workRow = item => button(`${item.app && byId(item.app) ? appMark(byId(item.app)) : avatar(item.kind === 'task' ? 'J' : 'Q')}<span><strong>${esc(item.title)}</strong><small>${esc(item.appName)} · ${esc(item.typeLabel)} · ${esc(timeAgo(item))}</small></span><span class="work-status">${esc(item.status.label)}</span>${panels() ? panels().movingBar(item) : ''}`, 'work-item', 'work-item', `data-work="${esc(item.id)}"`);
    const artifactTile = item => button(`<span class="file-icon">${item.kind === 'task' ? 'TASK' : 'TKT'}</span><span><strong>${esc(item.title)}</strong><small>${esc(item.appName)} · ${esc(item.status.label)} · ${esc(timeAgo(item))}</small></span><span class="arrow">↗</span>`, 'work-item', 'file-tile', `data-work="${esc(item.id)}"`);

    /** The day focus picker, for layouts that opt in (hooks.scenes): a device-local ordering choice, never a server setting. */
    function scenePicker() {
      const V = window.OSHAL_LIVE_VIEWS; if (!hooks.scenes || !V) return '';
      return `<label class="screenreader" for="scene-picker">Day focus</label><select id="scene-picker" class="layout-picker scene-picker" title="Orders your work and suites for this part of the day; hides nothing">${Object.values(V.SCENES).map(sc => `<option value="${sc.id}"${state.scene === sc.id ? ' selected' : ''}>${esc(sc.label)}</option>`).join('')}</select>`;
    }
    /** @description Change the day focus: saved on this device per layout, then the layout re-renders through hooks.onSceneChanged. */
    function setScene(id) {
      state.scene = window.OSHAL_LIVE_VIEWS.sceneOf(id).id;
      LIVE.prefs.set('scene:' + layoutId, state.scene);
      if (hooks.onSceneChanged) hooks.onSceneChanged(state.scene);
    }
    function studyBar(caption = '') {
      const current = experienceFor(layoutId);
      return `<div class="study-bar"><div class="study-links"><a href="/cockpit/">← Cockpit</a>${pickerMarkup(current ? current.id : layoutId)}<span class="full-label">LIVE SWARM / ${apps.length} APPS</span></div><div class="study-caption">${caption}<span>${esc(snapshot.me.name)} · ${esc(workCount(openWork().length, 'open'))} · ${esc(overviewCount(`${snapshot.botsOnline}/${snapshot.bots.length} assistants online`))}</span>${scenePicker()}${skinPicker()}<a href="/portal">All experiences</a></div></div>`;
    }

    /** Summary section for an application panel; filled asynchronously from the app's own probes. */
    async function summaryFor(app) { return LIVE.probeSummary(app); }
    function summaryMarkup(app, summary) {
      if (!summary) return '<p class="note-line">Reading this application’s own summary…</p>';
      if (summary.none) return '<p class="note-line">This application publishes no summary. Open it for details.</p>';
      if (!summary.ok) return `<p class="note-line">Summary unavailable right now (HTTP ${summary.status || 'network'}). Nothing is assumed in its place.</p>`;
      const tiles = summary.tiles.length ? `<div class="run-strip">${summary.tiles.map(t => `<span class="tone-${t.tone}"><strong>${esc(t.value)}</strong> ${esc(t.label)}</span>`).join('')}</div>` : '';
      const items = summary.items.length ? `<ul class="artifact-steps">${summary.items.map(i => `<li class="tone-${i.tone}">${esc(i.text)}${i.detail ? `<small class="muted" style="display:block">${esc(i.detail)}</small>` : ''}</li>`).join('')}</ul>` : '';
      const foot = summary.asOf ? `<p class="note-line">As of ${esc(new Date(summary.asOf).toLocaleString())}${summary.partial ? ' · partial' : ''}</p>` : (summary.partial ? '<p class="note-line">Partial summary.</p>' : '');
      return tiles + items + foot || '<p class="note-line">Nothing to report from this application yet.</p>';
    }
    function fillSummary(app) {
      summaryFor(app).then(summary => {
        state.summaries.set(app.id, summary);
        document.querySelectorAll(`[data-summary-slot="${CSS.escape(app.id)}"]`).forEach(slot => { slot.innerHTML = summaryMarkup(app, summary); });
      });
    }

    const memberViews = new Map(), memberReferences = new Map();
    let memberNavigation = 0;
    const admittedApp = id => { const app = byId(id); return app && app.inPlan && app.navigable ? app : null; };
    const memberReference = app => memberReferences.has(app.id)
      ? memberReferences.get(app.id)
      : hooks.memberToolFor ? hooks.memberToolFor(app.id) : undefined;
    const retainMemberView = (app, view) => {
      memberViews.set(app.id, view); memberReferences.set(app.id, { id: view.id, query: view.query });
    };
    /** In-place hosting keeps the admitted tool's owned query and fragment across view changes. */
    const hostedUrl = app => {
      const url = LIVE.localHref((memberViews.get(app.id) || {}).url || app.surface);
      return state.embedView === 'full' ? url : withAudience(url, options.audience);
    };
    /** Read-only, bounded ContextSchema snapshot; member ownership and execution grants stay with their APIs. */
    function contextFor(app) {
      if (!app || !admittedApp(app.id)) return undefined;
      const view = memberViews.get(app.id);
      return { channel: 'oshal-surface-bridge', v: 1, op: 'context', app: app.id,
        surface: String(view ? view.id.replace(/^tool-/, '') : app.surfaceName || 'experience-context').slice(0, 80),
        title: String(view ? view.label : app.name).slice(0, 200), can: [],
        fields: { experience: layoutId, view: view ? 'member-page' : 'application-summary' },
        digest: ('Selected application: ' + app.name + '. ' + app.description).slice(0, 4000),
        ...(view && view.recordId ? { recordId: view.recordId } : {}) };
    }
    /** The foreground frame alone may request another currently admitted named member tool. */
    function activeMemberFrame() {
      if (state.modal) return state.modal.kind === 'embed' ? document.querySelector('#full-dialog iframe[data-hosted-app]') : null;
      return document.querySelector('iframe[data-hosted-app]');
    }
    /** A WindowProxy survives navigation; current document and safe URL must remain the requesting ones. */
    function memberDocumentState(frame) {
      try {
        const url = frame.contentWindow.location.href, parsed = new URL(url), document = frame.contentDocument;
        return document && parsed.origin === location.origin && LIVE.localHref(parsed.pathname + parsed.search + parsed.hash) ? { document, url } : null;
      } catch (_) { return null; }
    }
    const pendingMemberFrame = frame => {
      try { return frame.getAttribute('src') === 'about:blank' && frame.contentWindow.location.href === 'about:blank'; }
      catch (_) { return false; }
    };
    /** Resolve navigation through a fresh caller-scoped profile, never an event-supplied URL. */
    async function readMemberTool(app, id, query) {
      const r = await LIVE.packages.profile(app.id), p = r.ok && r.body && r.body.profile;
      const item = p && p.name === app.id && p.ribbon && Array.isArray(p.ribbon.items) && p.ribbon.items.find(t => t.id === id);
      const url = item && item.toolUi && LIVE.localHref(item.toolUi.iframeUrl);
      if (!url) return null;
      const parsed = new URL(url, location.origin), extra = new URLSearchParams();
      if (typeof query === 'string' && query.length <= 1200) {
        const params = [...new URLSearchParams(query)];
        if (params.length > 16 || params.some(([k, v]) => !/^[\w.-]{1,80}$/.test(k) || v.length > 400)) return null;
        params.forEach(([k, v]) => { if (!parsed.searchParams.has(k) && k !== 'audience') { parsed.searchParams.append(k, v); extra.append(k, v); } });
      } else if (query !== undefined) return null;
      if (extra.toString().length > 1200) return null;
      return { id: item.id, query: extra.toString(), label: String(item.label || app.name), url: LIVE.localHref(parsed.pathname + parsed.search + parsed.hash),
        recordId: String(parsed.searchParams.get('classId') || parsed.searchParams.get('class') || '').slice(0, 120) };
    }
    /** Mark this exact pending frame, with no refused member document loaded. */
    function memberFrameUnavailable(frame, app, message) {
      frame.dataset.memberPending = 'denied'; frame.hidden = true; frame.style.display = 'none'; memberViews.delete(app.id);
      const notice = frame.previousElementSibling;
      if (notice && notice.dataset.memberState === app.id) { notice.hidden = false; notice.style.removeProperty('display'); notice.textContent = message; }
    }
    /** Revalidate saved and in-memory tool references for every new foreground frame before loading its URL. */
    async function restoreMemberTool(app, reference) {
      const frame = activeMemberFrame();
      if (!app || !frame || frame.dataset.hostedApp !== app.id || frame.dataset.memberPending !== 'true') return;
      reference = reference || memberReference(app);
      const id = typeof reference === 'string' ? reference : reference && reference.id;
      if (!admittedApp(app.id) || typeof id !== 'string' || !/^tool-[\w.-]{1,160}$/.test(id)) {
        memberFrameUnavailable(frame, app, 'That saved application view is no longer available to you.'); return;
      }
      const sequence = ++memberNavigation; frame.dataset.memberPending = 'loading';
      try {
        const view = await readMemberTool(app, id, typeof reference === 'string' ? undefined : reference.query);
        if (sequence !== memberNavigation || frame !== activeMemberFrame() || !frame.isConnected || frame.dataset.hostedApp !== app.id || !pendingMemberFrame(frame)) return;
        if (!view || !admittedApp(app.id)) { memberFrameUnavailable(frame, app, 'That saved application view is no longer available to you.'); return; }
        retainMemberView(app, view); frame.dataset.memberPending = 'ready'; frame.src = hostedUrl(app); frame.title = view.label;
        const notice = frame.previousElementSibling;
        if (notice && notice.dataset.memberState === app.id) { notice.hidden = true; notice.style.display = 'none'; }
      } catch (_) {
        if (sequence === memberNavigation && frame === activeMemberFrame() && frame.isConnected && pendingMemberFrame(frame)) {
          memberFrameUnavailable(frame, app, 'That saved application view could not be checked. Close and reopen it to try again.');
        }
      }
    }
    /** Legacy Little Monsters and generic app requests share the same exact-frame/current-profile check. */
    async function onMemberMessage(e) {
      const frame = activeMemberFrame(), d = e.data;
      if (!frame || e.source !== frame.contentWindow || e.origin !== location.origin || !d || typeof d !== 'object') return;
      if (frame.dataset.memberPending && frame.dataset.memberPending !== 'ready') return;
      const app = admittedApp(frame.dataset.hostedApp); if (!app) return;
      const requesting = memberDocumentState(frame); if (!requesting) return;
      let id = '';
      if (d.type === 'app-navigate' && typeof d.tool === 'string') id = 'tool-' + d.tool;
      else if (app.id === 'little-monsters' && d.type === 'lm-navigate' && typeof d.view === 'string') id = d.view.startsWith('class-') ? 'tool-lm-class-' + d.view.slice(6, 14) : 'tool-lm-' + d.view;
      else if (app.id === 'little-monsters' && d.type === 'lm-open-class' && typeof d.classId === 'string') id = 'tool-lm-class-' + d.classId.slice(0, 8);
      if (!/^tool-[\w.-]{1,160}$/.test(id)) return;
      const sequence = ++memberNavigation, previous = frame.getAttribute('src');
      try {
        const view = await readMemberTool(app, id, d.type === 'app-navigate' ? d.query : undefined);
        if (sequence !== memberNavigation || previous !== frame.getAttribute('src') || frame !== activeMemberFrame() || e.source !== frame.contentWindow || !admittedApp(app.id)) return;
        const current = memberDocumentState(frame);
        if (!current || current.document !== requesting.document || current.url !== requesting.url) return;
        if (!view) { toast('That view is not available to you here.'); return; }
        retainMemberView(app, view); frame.src = hostedUrl(app); frame.title = view.label;
        if (hooks.onMemberNavigation) hooks.onMemberNavigation(app.id, { id: view.id, query: view.query });
      } catch (_) { toast('That view could not be checked. Try again.'); }
    }
    function embedControls(app) {
      if (!options.audience) return '';
      const choice = (view, label) => button(label, 'embed-view', '', `data-view="${view}" aria-pressed="${state.embedView === view}"`);
      const note = state.embedView === 'full' ? `Full application opens ${esc(app.name)} without an audience request.` : `Summary view asks ${esc(app.name)} for its ${esc(options.audience)} view. The application decides: a page without that view runs its full UI.`;
      return `<div class="embed-switch"><div class="segmented" role="group" aria-label="How ${esc(app.name)} opens here">${choice('summary', 'Summary view')}${choice('full', 'Full application')}</div><p class="note-line">${note} Saved on this device.</p></div>`;
    }
    function embedFrame(app, cls = '') {
      if (!admittedApp(app.id)) return '<p class="note-line">That application view is not available to you here.</p>';
      const pending = Boolean(memberReference(app)), url = pending ? 'about:blank' : hostedUrl(app);
      if (!url) return '<p class="note-line">That application view is not available to you here.</p>';
      return `${pending ? `<p class="note-line" data-member-state="${esc(app.id)}" role="status">Checking your saved application view…</p>` : ''}<iframe class="embed-frame${cls ? ` ${cls}` : ''}" data-hosted-app="${esc(app.id)}"${pending ? ' data-member-pending="true"' : ''} src="${esc(url)}" title="${esc(app.name)}" loading="lazy"></iframe>`;
    }
    function setEmbedView(view) {
      state.embedView = view === 'full' ? 'full' : 'summary';
      LIVE.prefs.set('embed-view:' + layoutId, state.embedView);
      if (state.modal && state.modal.kind === 'embed') {
        renderModal();
        const pressed = document.querySelector(`#full-dialog [data-action="embed-view"][data-view="${state.embedView}"]`); if (pressed) pressed.focus();
      }
      if (hooks.onEmbedViewChanged) hooks.onEmbedViewChanged();
    }

    /** Package record: one viewer-scoped GET /api/swarm/apps/:name per application (and per installed member of a group), read when a panel first shows it. */
    async function readDetail(app) {
      const read = async name => { const r = await LIVE.packages.appDetail(name); return { name, status: r.status, record: r.ok && r.body && r.body.app ? r.body.app : null }; };
      const [own, members] = await Promise.all([read(app.id), app.kind === 'group' ? Promise.all(app.related.map(read)) : Promise.resolve([])]);
      return { own, members };
    }
    /** One part of the package record: assistants, relationships (each related application opens its panel, or navigates with `action`), or the package facts (layouts with shell-panels.js). */
    function detailPart(app, part, action = 'open-app') {
      const detail = state.details.get(app.id) || null;
      if (part === 'facts') return panels() ? panels().packageFacts(app, detail, a => suiteOf(a.suite)) : '';
      return part === 'assistants' ? assistantsMarkup(app, detail) : relationsMarkup(app, detail, action);
    }
    const detailSlot = (app, part, action = 'open-app') => `<div class="detail-slot" data-detail-slot="${esc(app.id)}" data-detail-part="${part}" data-detail-action="${esc(action)}">${detailPart(app, part, action)}</div>`;
    function fillDetail(app) {
      if (!app || state.details.has(app.id)) return;
      if (!state.detailReads.has(app.id)) state.detailReads.set(app.id, readDetail(app).then(detail => { state.details.set(app.id, detail); return detail; }));
      state.detailReads.get(app.id).then(() => document.querySelectorAll(`[data-detail-slot="${CSS.escape(app.id)}"]`).forEach(slot => { slot.innerHTML = detailPart(app, slot.dataset.detailPart, slot.dataset.detailAction || 'open-app'); }));
    }
    const nameOf = id => (byId(id) || { name: id }).name;
    const unreadNote = read => read.status === 404 ? `${nameOf(read.name)}: its package record is not visible to you.` : `${nameOf(read.name)}: package record unavailable (HTTP ${read.status || 'network'}).`;
    function assistantsMarkup(app, detail) {
      if (!detail) return '<p class="note-line">Reading the package declaration…</p>';
      const group = app.kind === 'group', manifest = (detail.own.record && detail.own.record.manifest) || {};
      const concierge = typeof manifest.chatBot === 'string' ? manifest.chatBot : '', reads = group ? detail.members : [detail.own];
      const rows = reads.flatMap(read => read.record ? LIVE.declaredAssistants(read.record, snapshot.bots, concierge).map(r => Object.assign(r, { from: group ? nameOf(read.name) : '' })) : []);
      const notes = (group && !detail.own.record ? [detail.own] : []).concat(reads.filter(read => !read.record)).map(unreadNote);
      if (concierge && !rows.some(r => r.concierge)) notes.push(`${concierge} is named as the concierge but is not declared in ${group ? 'an installed member' : 'this package'}.`);
      const list = rows.map(r => personRow(LIVE.initials(r.name), r.name, [r.concierge ? 'Concierge' : '', r.role, r.from ? `from ${r.from}` : '', ASSISTANT_STATE[r.state]].filter(Boolean).join(' · '), r.state === 'working' ? 'bot active' : 'bot')).join('');
      const empty = rows.length || notes.length ? '' : `<p class="note-line">${group ? 'Its installed members declare no assistants.' : 'This package declares no assistants.'}</p>`;
      const foot = rows.length ? '<p class="note-line">Names come from the package manifest; online state appears only where the assistant is registered in the swarm overview.</p>' : '';
      return list + empty + notes.map(n => `<p class="note-line">${esc(n)}</p>`).join('') + foot;
    }
    const relationRow = (id, label, absent, action = 'open-app') => byId(id) ? button(`${appMark(byId(id))}<span>${esc(byId(id).name)}</span><small>${esc(label)}</small>`, action, 'dependency-row', `data-app="${esc(id)}"`) : `<div class="dependency-row"><span>${esc(id)}</span><small>${esc(`${label} · ${absent}`)}</small></div>`;
    function relationsMarkup(app, detail, action = 'open-app') {
      const rows = app.related.map(id => relationRow(id, 'Member (required)', 'not in your catalog', action)), shown = new Set([app.id, ...app.related]);
      let note = '';
      if (!detail) note = 'Reading declared dependencies…';
      else if (!detail.own.record) note = detail.own.status === 404 ? 'The package record is not visible to you, so declared dependencies are not listed.' : `Declared dependencies could not be read (HTTP ${detail.own.status || 'network'}).`;
      else {
        const tiers = LIVE.dependencyTiers(detail.own.record.manifest);
        if (tiers.form === 'mixed') note = 'This package mixes the flat and tiered dependency forms, so no tiers are shown.';
        else [['required', 'Required'], ['optional', 'Optional']].forEach(([tier, label]) => tiers[tier].apps.forEach(id => { if (!shown.has(id)) { shown.add(id); rows.push(relationRow(id, label, 'not in your catalog', action)); } }));
      }
      const empty = !rows.length && !note ? '<p class="note-line">No application relationships declared.</p>' : '';
      return `<div class="dependency-list">${rows.join('')}${empty}${note ? `<p class="note-line">${esc(note)}</p>` : ''}</div>`;
    }

    /** Swarm roster (layouts that opt in): GET /api/user-directory once per page; a refusal keeps the caller's own identity only. */
    function fillRoster() {
      if (state.roster) return;
      if (!state.rosterRead) state.rosterRead = LIVE.packages.people(snapshot.me.sub).then(r => { state.roster = r; return r; });
      state.rosterRead.then(r => { document.querySelectorAll('[data-roster-slot]').forEach(slot => { slot.innerHTML = rosterMarkup(r, slot.dataset.rosterSlot); }); document.querySelectorAll('[data-membership-slot]').forEach(slot => { slot.innerHTML = membershipMarkup(slot.dataset.membershipSlot); }); });
    }
    const rosterSlot = variant => `<div class="roster-slot" data-roster-slot="${variant}">${rosterMarkup(state.roster, variant)}</div>`;
    function rosterMarkup(roster, variant) {
      const self = personRow(snapshot.me.initials, `${snapshot.me.name} · you`, [snapshot.me.email || 'Signed in', state.place ? state.place.text : ''].filter(Boolean).join(' · '), 'person');
      if (!roster) return `${self}<p class="note-line">Reading the swarm roster…</p>`;
      if (!roster.ok) return `${self}<p class="note-line">${rosterRefusal(roster)}</p>`;
      const others = roster.people.filter(p => !p.self), limit = variant === 'room' ? 6 : 40;
      const more = others.length > limit ? `<p class="note-line">…and ${others.length - limit} more on the roster.</p>` : '';
      return `${self}${others.slice(0, limit).map(p => personRow(LIVE.initials(p.name), p.name, p.detail || 'Account', 'person')).join('')}${more}<p class="note-line">${others.length ? `${roster.people.length} accounts on this swarm’s user directory.` : 'Nobody else is on this swarm’s user directory.'} A roster, not presence or room membership.</p>`;
    }

    /** @description Membership of the caller's household or team, then the members of the chosen one (the route answers members only). */
    async function readMembership() {
      const V = window.OSHAL_LIVE_VIEWS, tenants = await LIVE.packages.tenants();
      const chosen = V.membershipView(tenants, null, snapshot.me.sub).tenant;
      return V.membershipView(tenants, chosen ? await LIVE.packages.tenantMembers(chosen.id) : null, snapshot.me.sub);
    }
    /**
     * @description Read the caller's household/team membership and their own place once per page (layouts with shell-panels.js),
     * then repaint every membership and roster slot. The place is the caller's own location overview (ADR-169), never anyone else's.
     * @returns {Promise<void>} Resolves once both reads have answered and the slots are painted.
     */
    function fillPeople() {
      if (!panels()) return Promise.resolve();
      if (!state.membershipRead) state.membershipRead = readMembership().then(m => { state.membership = m; });
      if (!state.placeRead) state.placeRead = LIVE.packages.locationState().then(r => { state.place = window.OSHAL_LIVE_VIEWS.placeView(r); });
      return Promise.all([state.membershipRead, state.placeRead]).then(paintPeople);
    }
    const membershipMarkup = variant => panels() ? panels().membershipRows(state.membership, state.place, { me: snapshot.me, roster: state.roster, personRow, limit: variant === 'room' ? 6 : 40 }) : '';
    const membershipSlot = variant => `<div class="membership-slot" data-membership-slot="${variant}">${membershipMarkup(variant)}</div>`;
    function paintPeople() {
      document.querySelectorAll('[data-membership-slot]').forEach(slot => { slot.innerHTML = membershipMarkup(slot.dataset.membershipSlot); });
      document.querySelectorAll('[data-roster-slot]').forEach(slot => { slot.innerHTML = rosterMarkup(state.roster, slot.dataset.rosterSlot); });
    }
    function appPanel(id) {
      const app = byId(id); if (!app) return '<p>That application is not in your catalog.</p>';
      const suite = suiteOf(app.suite), items = workFor(app.id).slice(0, 4);
      const availability = app.navigable ? 'Available in your workspace.' : app.inPlan ? 'Installed; opens through the cockpit.' : 'Installed, but not available to you in this workspace.';
      return `<div class="app-detail-header">${appMark(app)}<div><span class="eyebrow muted">${esc(suite.name)}</span><p class="app-package">${esc(app.id)}${app.version ? ` · v${esc(app.version)}` : ''}</p></div>${button(isPinned(app.id) ? '★ Pinned' : '☆ Pin app', 'pin', 'action', `data-app="${esc(app.id)}" aria-pressed="${isPinned(app.id)}"`)}</div>
<p class="app-description">${esc(app.description)}</p>
<div class="scope-callout">${availability}<small>${app.botCount} assistant${app.botCount === 1 ? '' : 's'} · ${app.toolCount} tool${app.toolCount === 1 ? '' : 's'} declared${app.theme ? ` · ${esc(app.theme)} skin` : ''}</small></div>
${visualFor(app)}
<h3>From the application</h3><div data-summary-slot="${esc(app.id)}">${summaryMarkup(app, state.summaries.get(app.id) || null)}</div>
${app.todos.length ? `<h3>Setup steps</h3><ol class="artifact-steps">${app.todos.map(t => `<li>${esc(t.label)}</li>`).join('')}</ol>` : ''}
${items.length ? `<h3>Recent work</h3>${items.map(workRow).join('')}` : ''}
<div class="drawer-actions">${app.navigable ? link('Open ↗', app.href, 'action primary') : ''}${app.surface && hooks.allowEmbed ? button('Open here', 'embed', 'action', `data-app="${esc(app.id)}"`) : ''}${hooks.contextAction ? button(hooks.contextAction, 'use-context', 'action', `data-app="${esc(app.id)}"`) : ''}${panels() ? button('Its routines', 'routines', 'action', `data-app="${esc(app.id)}"`) : ''}</div>
${panels() && isGameApp(app) && gameApps().length > 1 ? `<h3>Other games on this swarm</h3><div class="drawer-actions">${gameApps().filter(g => g.id !== app.id).map(g => button(esc(g.name), 'open-app', 'action', `data-app="${esc(g.id)}"`)).join('')}</div>` : ''}
<h3>Declared assistants</h3>${detailSlot(app, 'assistants')}
<h3>Declared application relationships</h3>${detailSlot(app, 'relations')}
${panels() ? detailSlot(app, 'facts') : ''}
${(app.connectors.required || []).length || (app.connectors.optional || []).length ? `<h3>Providers</h3><p class="bot-identifiers">${esc([...(app.connectors.required || []).map(c => `${c} (required)`), ...(app.connectors.optional || [])].join(' · '))}</p>` : ''}`;
    }
    function embedPanel(id) {
      const app = byId(id); if (!app || !app.surface) return '<p>This application has no embeddable surface.</p>';
      return `<p class="note-line">${esc(app.name)} running in place. It keeps its own navigation; use Open ↗ for the full cockpit view.</p>${embedControls(app)}${embedFrame(app)}<div class="drawer-actions">${link('Open ↗', app.href, 'action primary')}</div>`;
    }
    function workPanel(id) {
      const item = work.find(w => w.id === id); if (!item) return '<p>That item is no longer in your recent work.</p>';
      const app = item.app ? byId(item.app) : null;
      const body = item.kind === 'task' ? (item.error ? `<p class="tone-warn">${esc(item.error)}</p>` : answerHtml(item.result)) : `<p>${esc(item.detail || 'No description was recorded on this ticket.')}</p>`;
      return `<div class="row between">${statusBadge(item.status)}<span class="small-label">${esc(item.appName)} · ${esc(item.typeLabel)} · ${esc(item.at ? item.at.toLocaleString() : '')}</span></div>
${item.app && byId(item.app) ? visualFor(byId(item.app), item) : ''}<h2 class="artifact-title">${esc(item.title)}</h2>${body}
${item.files.length ? `<h3>Files</h3><ul class="artifact-steps">${item.files.map(f => `<li>${fileLink(f) || esc(f.name || 'file')}</li>`).join('')}</ul>` : ''}
${workExtras(item)}
<div class="drawer-actions">${link(item.kind === 'task' && !item.ticketId ? 'Open in Jarvis ↗' : 'Open in cockpit ↗', item.href, 'action primary')}${app ? button(`About ${esc(app.name)}`, 'open-app', 'action', `data-app="${esc(app.id)}"`) : ''}${button('Ask Jarvis about this', 'prompt', 'action', `data-prompt="${esc(`Tell me about ${item.kind === 'task' ? 'the task' : 'ticket'} “${item.title}” (${item.ref}).`)}"`)}</div>
<p class="note-line">${item.kind === 'task' ? 'Recorded on your Jarvis shelf' : 'Recorded in the swarm ticket queue'} · ${esc(item.ref)}</p>`;
    }
    /**
     * @description The picture beside an application or a work item, for layouts that opt in (shell-panels.js).
     * @param {object} app The catalog entry.
     * @param {object|null} [latest] The work item the picture speaks for; defaults to the application's newest work.
     * @returns {string} Markup, empty where the layout does not opt in.
     */
    function visualFor(app, latest) {
      const P = panels(); if (!P || !app) return '';
      return P.visual(app, latest === undefined ? workFor(app.id)[0] || null : latest, a => suiteOf(a.suite), state.spend || undefined);
    }
    /** @description Fill every Finance picture on screen from one GET /api/finance/summary per page (only drawn for a Finance the caller's plan admits). */
    async function fillVisuals() {
      const P = panels(); if (!P || !document.querySelector('[data-visual-finance]')) return;
      if (!state.spendRead) state.spendRead = LIVE.packages.finance.summary().then(r => { state.spend = window.OSHAL_LIVE_VIEWS.spendBars(r); return state.spend; });
      const spend = await state.spendRead;
      document.querySelectorAll('[data-visual-finance]').forEach(el => { el.innerHTML = P.financeInner(spend); });
    }
    /** The workflow and action slots of a work panel, filled from the ticket's own reads once the panel shows. */
    function workExtras(item) {
      const P = panels(); if (!P) return '';
      if (!P.ticketOf(item)) return item.status.label === 'Working' ? `<p class="note-line">In progress on your Jarvis shelf ${P.movingBar(item)}</p>` : '';
      const flow = state.workFlows.get(item.id);
      return `<div class="work-flow" data-work-flow="${esc(item.id)}">${flow ? P.workflowSection(flow.view, item) : '<p class="note-line">Reading this ticket’s workflow…</p>'}</div><div class="work-state" data-work-state="${esc(item.id)}">${flow ? P.actionsMarkup(item, flow.ticket) : ''}</div>`;
    }
    /** @description Read one ticket's workflow and state (GET /api/v1/tickets/:id/workflow, GET /api/tickets/:id) and paint every slot showing it. */
    async function fillWork(item) {
      const P = panels(), ref = P && P.ticketOf(item); if (!ref || state.workReads.has(item.id)) return;
      state.workReads.add(item.id);
      const [flow, ticket] = await Promise.all([LIVE.packages.tickets.workflow(ref), LIVE.packages.tickets.get(ref)]);
      state.workReads.delete(item.id);
      state.workFlows.set(item.id, { view: window.OSHAL_LIVE_VIEWS.workflowView(flow), ticket });
      paintWork(item);
    }
    function paintWork(item) {
      const P = panels(), flow = state.workFlows.get(item.id); if (!P || !flow) return;
      document.querySelectorAll(`[data-work-flow="${CSS.escape(item.id)}"]`).forEach(slot => { slot.innerHTML = P.workflowSection(flow.view, item); });
      document.querySelectorAll(`[data-work-state="${CSS.escape(item.id)}"]`).forEach(slot => { slot.innerHTML = P.actionsMarkup(item, flow.ticket); });
      if (state.modal && state.modal.kind === 'ticket-workflow' && state.modal.id === item.id) { const body = document.getElementById('ticket-workflow-body'); if (body) body.innerHTML = P.workflowPanel(flow.view, item); }
    }
    const refusalOf = r => r && r.body && (r.body.error || r.body.message) ? `: ${r.body.error || r.body.message}` : '';
    function ticketWorkflowPanel(id) {
      const item = work.find(w => w.id === id), P = panels(); if (!item || !P) return '<p>That item is no longer in your recent work.</p>';
      const flow = state.workFlows.get(id);
      return `<div id="ticket-workflow-body">${P.workflowPanel(flow ? flow.view : null, item)}</div>`;
    }
    /** @description Swap a panel's actions for the cancel confirmation, or back. */
    function workCancelStep(target, ask) {
      const item = work.find(w => w.id === target.dataset.work), P = panels(), flow = item && state.workFlows.get(item.id); if (!item || !P || !flow) return;
      document.querySelectorAll(`[data-work-state="${CSS.escape(item.id)}"]`).forEach(slot => { slot.innerHTML = ask ? P.cancelConfirm(item) : P.actionsMarkup(item, flow.ticket); });
      const next = document.querySelector(`[data-work-state="${CSS.escape(item.id)}"] [data-action="${ask ? 'work-cancel-keep' : 'work-cancel'}"]`); if (next) next.focus();
    }
    /**
     * @description Send one ticket action (approve: approval_required → approved; cancel: the owner-checked cancel route).
     * The route decides; a refusal is shown in the panel as returned, a success reloads the caller's work.
     * @param {HTMLElement} target The clicked action (carries data-work).
     * @param {'approve'|'cancel'} kind Which action.
     * @returns {Promise<void>} Resolves once the refusal is shown or the work is reloaded.
     */
    async function ticketAction(target, kind) {
      const item = work.find(w => w.id === target.dataset.work), P = panels(); if (!item || !P) return;
      target.disabled = true;
      const r = kind === 'approve' ? await LIVE.packages.tickets.setStatus(P.ticketOf(item), 'approved') : await LIVE.packages.tickets.cancel(P.ticketOf(item));
      if (!r.ok) {
        paintWork(item);
        const feedback = document.getElementById('work-feedback');
        if (feedback) feedback.textContent = `Could not ${kind === 'approve' ? 'approve' : 'cancel'} this ticket (HTTP ${r.status || 'network'}${refusalOf(r)}).`;
        return;
      }
      await LIVE.loadWork(snapshot);
      state.workFlows.delete(item.id);
      if (hooks.onWorkChanged) hooks.onWorkChanged(); else if (state.modal) renderModal();
      toast(kind === 'approve' ? `Approved: ${item.title} waits for the queue.` : `Cancelled: ${item.title}.`);
    }
    /** @description Read the caller's schedules and the Workflow Studio definitions once per page and paint the Routines panel. */
    async function fillRoutines() {
      if (state.routinesRead) return;
      state.routinesRead = true;
      const V = window.OSHAL_LIVE_VIEWS;
      const [routines, workflows] = await Promise.all([LIVE.packages.routines.list(), LIVE.packages.workflows()]);
      state.routines = V.routinesView(routines); state.workflowsList = V.workflowsView(workflows);
      const body = document.getElementById('routines-body');
      if (body && state.modal && state.modal.kind === 'routines') body.innerHTML = panels().routinesPanel(state.routines, state.workflowsList, byId(state.modal.id));
    }
    /**
     * @description Pause or resume one of the caller's routines from its switch. The schedules route decides (404 for a
     * schedule that is not theirs, 403 for a managed one); a refusal puts the switch back and says why.
     * @param {HTMLInputElement} input The routine's checkbox.
     * @returns {Promise<void>} Resolves once the row is repainted or the refusal is shown.
     */
    async function toggleRoutine(input) {
      const id = input.dataset.routine, on = input.checked, list = state.routines ? state.routines.routines : [];
      const at = list.findIndex(r => r.id === id); if (at < 0) return;
      input.disabled = true;
      const r = await LIVE.packages.routines.setOn(id, on);
      const note = () => document.querySelector(`[data-routine-note="${CSS.escape(id)}"]`);
      if (!r.ok || !r.body || !r.body.schedule) {
        input.checked = !on; input.disabled = false;
        const n = note(); if (n) n.textContent = `Could not ${on ? 'resume' : 'pause'} this routine (HTTP ${r.status || 'network'}${refusalOf(r)}).`;
        return;
      }
      list[at] = window.OSHAL_LIVE_VIEWS.routineView(r.body.schedule);
      const row = document.querySelector(`[data-routine-row="${CSS.escape(id)}"]`);
      if (row) { row.outerHTML = panels().routineRow(list[at]).replace(/<p class="note-line routine-note"[\s\S]*$/, ''); }
      const n = note(); if (n) n.textContent = list[at].on ? 'Resumed for you.' : 'Paused for you. Nobody else’s routines changed.';
      const fresh = document.querySelector(`[data-routine="${CSS.escape(id)}"]`); if (fresh) fresh.focus();
    }
    function filtered() {
      const q = state.dirQuery.toLowerCase().trim();
      const inFilter = a => state.dirSuite === 'all' || (state.dirSuite === 'pinned' ? isPinned(a.id) : state.dirSuite === 'games' ? isGameApp(a) : a.suite === state.dirSuite);
      return apps.filter(a => inFilter(a) && `${a.name} ${a.id} ${a.description} ${suiteOf(a.suite).name}`.toLowerCase().includes(q));
    }
    const gameApps = () => apps.filter(isGameApp);
    const appCard = a => `<article class="catalog-card" data-catalog-app="${esc(a.id)}"><div class="row between">${appMark(a)}${button(isPinned(a.id) ? '★' : '☆', 'pin', 'pin-button', `data-app="${esc(a.id)}" aria-label="${isPinned(a.id) ? 'Unpin' : 'Pin'} ${esc(a.name)}" aria-pressed="${isPinned(a.id)}"`)}</div>${button(`<h3>${esc(a.name)}</h3><span class="app-package">${esc(a.id)}</span><p>${esc(a.description)}</p>`, 'open-app', 'catalog-main', `data-app="${esc(a.id)}"`)}<div class="catalog-card-foot"><span>${esc(suiteOf(a.suite).name)}</span><span>${a.navigable ? (workFor(a.id)[0] ? `Latest: ${esc(workFor(a.id)[0].status.label.toLowerCase())}` : 'Available') : 'Not available here'}</span></div></article>`;
    function directoryPanel() {
      const games = gameApps().length ? [['games', 'Looks like a game', gameApps().length, `title="${esc(GAMES_TITLE)}"`]] : [];
      const filters = [['all', 'All apps', apps.length], ...suites.map(s => [s.id, s.name, s.count]), ...games, ['pinned', 'Pinned', state.pins.length]];
      return `<div class="directory-intro"><p>Every application installed on this swarm that you can see, with its declared suite, version and current availability to you.</p><span>${apps.length} applications · ${suites.length} suites</span></div><div class="directory-search"><span aria-hidden="true">⌕</span><label class="screenreader" for="app-search">Search all applications</label><input id="app-search" type="search" placeholder="Find an application or capability…" value="${esc(state.dirQuery)}" autocomplete="off"></div><nav class="directory-filters" aria-label="Filter applications">${filters.map(([k, n, c, extra = '']) => button(`${esc(n)}<span>${c}</span>`, 'filter', 'filter-chip', `data-suite="${k}" aria-pressed="${state.dirSuite === k}" ${extra}`)).join('')}</nav><div class="directory-results-head"><span id="catalog-result-count" role="status"></span><span>★ Pins are saved on this device only</span></div><div id="catalog-results" class="catalog-grid"></div><footer class="directory-foot">Membership, availability and versions come from your installed swarm. Nothing here installs, enables or grants an application. ${button('What is live here?', 'provenance', 'quiet-link')}</footer>`;
    }
    function updateDirectory() {
      const result = filtered(), host = document.getElementById('catalog-results');
      if (!host) return;
      host.innerHTML = result.map(appCard).join('') || '<p class="empty-note">No matching applications. Try another name or clear the filter.</p>';
      document.getElementById('catalog-result-count').textContent = `${result.length} of ${apps.length} applications`;
      document.querySelectorAll('[data-action="filter"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.suite === state.dirSuite)));
    }
    function workListPanel() {
      const grouped = suites.map(s => [s, work.filter(w => w.app && byId(w.app) && byId(w.app).suite === s.id)]).filter(([, items]) => items.length);
      const rest = work.filter(w => !w.app || !byId(w.app));
      return `<div class="directory-intro"><p>Your tickets in the swarm queue and the tasks on your Jarvis shelf, newest first.</p><span>${esc(workCount(work.length))} · ${esc(workCount(openWork().length, 'open'))}</span></div>${workNotice()}<div class="work-by-suite">${grouped.map(([s, items]) => `<section><div class="section-head"><h3>${esc(s.name)}</h3><span class="small-label">${items.length} items</span></div>${items.slice(0, 12).map(workRow).join('')}</section>`).join('')}${rest.length ? `<section><div class="section-head"><h3>Assistant & queue</h3><span class="small-label">${rest.length} items</span></div>${rest.slice(0, 20).map(workRow).join('')}</section>` : ''}${work.length ? '' : workEmpty('No tickets or assistant tasks yet. Ask Jarvis for something and it will appear here.')}</div>`;
    }
    function peoplePanel() {
      const bots = [...snapshot.bots].sort((a, b) => Number(b.active) - Number(a.active) || Number(b.online) - Number(a.online)).slice(0, 14);
      const people = hooks.peopleDirectory
        ? `<p>People listed here come from this swarm’s user directory, read in your session. It is an account roster: it shows nobody’s presence and no room membership.</p><h3>People on this swarm</h3>${rosterSlot('panel')}`
        : `<p>People appear here when an installed application publishes membership you belong to (a classroom roster, a team workspace). This deployment does not expose a general people directory to this view.</p><h3>You</h3>${personRow(snapshot.me.initials, snapshot.me.name, snapshot.me.email || (snapshot.me.authenticated ? 'Signed in' : 'Not signed in'), 'person')}`;
      const household = panels() ? `<h3>Your household or team</h3>${membershipSlot('panel')}` : '';
      return `${people}${household}<hr class="rule"><h3>Assistants in this swarm</h3><p class="note-line">${esc(overviewCount(`${snapshot.botsOnline} of ${snapshot.bots.length} registered assistants are online`))}${bots.some(b => b.active) ? '; highlighted ones worked in the last two minutes' : ''}.</p>${bots.map(b => personRow(LIVE.initials(b.name), b.name, `${b.role || 'assistant'}${b.active ? ' · working now' : b.online ? ' · online' : ' · offline'}`, b.active ? 'bot active' : 'bot')).join('') || workEmpty('No assistants are listed in the overview.', ['overview'])}`;
    }
    const personRow = (mark, name, status, cls = 'bot') => `<div class="person-row">${avatar(mark, cls)}<span><strong>${esc(name)}</strong><small>${esc(status)}</small></span></div>`;
    /** @description The reads a layout with shell-panels.js makes on demand, each with its status once made (null: read when opened). */
    function onDemandSources() {
      if (!panels()) return [];
      const st = v => v ? v.status : null;
      return [['Your routines', '/api/v1/agent/schedules', st(state.routines)], ['Workflow Studio definitions', '/api/workflow-studio/definitions', st(state.workflowsList)],
        ['Your households and teams', '/api/tenants', st(state.membership)], ['Your own place (ADR-169)', '/api/location/state', state.place ? (state.place.state === 'refused' ? state.place.status : 200) : null],
        ['Finance spend (Finance only, when admitted)', '/api/finance/summary', state.spend ? (state.spend.state === 'no-data' ? 404 : state.spend.status) : null],
        ['A ticket’s workflow and state', '/api/v1/tickets/:id/workflow', state.workFlows.size ? 200 : null]];
    }
    function provenancePanel() {
      const s = snapshot.sources, rows = [['Signed-in identity', '/api/auth/user', s.auth], ['Authorized home plan', '/api/swarm/apps/home-plan', s.plan], ['Installed applications', '/api/swarm/apps', s.apps], ['Admitted navigation', '/api/ui/workspaces', s.workspaces], ['Your Jarvis shelf', '/api/jarvis/tasks', s.tasks, 'tasks'], ['Your tickets', '/api/tickets', s.tickets, 'tickets'], ['Assistant roster', '/api/jarvis/overview', s.overview, 'overview'], ['Your communications', '/api/jarvis/overview', s.overview, 'overviewComms'], ['Calendar feed', '/api/jarvis/overview', s.overview, 'overviewCalendar']].concat(onDemandSources());
      const statusText = (status, key) => status !== 200 ? status === null ? 'read when you open it' : `HTTP ${status || 'unreachable'}`
        : key === 'overview' && snapshot.overviewRosterOmitted ? 'HTTP 200 · global assistant status not provided to this session'
        : key && snapshot.sourcePartial && snapshot.sourcePartial[key] ? 'HTTP 200 · only readable events shown'
        : key && snapshot.sourceValidity && snapshot.sourceValidity[key] === false ? 'HTTP 200 · unreadable response' : 'live';
      const detail = workState(['tickets', 'tasks', 'overview', 'overviewComms', 'overviewCalendar']).detail;
      const calendar = workState(['overviewCalendar']);
      const calendarNote = !calendar.complete ? calendar.message : snapshot.calendarEvents.length ? 'A shared calendar feed is present.' : 'No application contributes a shared calendar feed yet, so calendar modules show only what a package (such as a classroom) publishes.';
      return `<h3>What this screen reads</h3><dl class="provenance-facts">${rows.map(([label, path, status, key]) => `<dt>${esc(label)}</dt><dd><code>${esc(path)}</code> · ${esc(statusText(status, key))}</dd>`).join('')}</dl>${detail ? `<p>${esc(detail)}</p>` : ''}<h3>What is live</h3><p>Application names, suites, versions, availability and summaries come from the packages installed on this swarm and their own summary routes, read in your session. Work items are your real tickets and Jarvis tasks. Conversations go to the same Jarvis thread the cockpit uses and are answered by the accountable assistant, not a script.</p><h3>What is not available on this deployment</h3><p>${esc(calendarNote)} ${!workState(['overview']).complete ? esc(workState(['overview']).message) : ''} ${panels() ? 'People are your household or team (membership, not presence) and, in Commons, the account roster; only your own place is shown, never anyone else’s.' : 'People appear only where an application publishes membership.'} Pins, skin, day focus and density choices are saved on this device and never change permissions.</p><p class="note-line">Loaded ${esc(snapshot.loadedAt.toLocaleTimeString())}${snapshot.unavailable.length ? ` · unavailable: ${esc(snapshot.unavailable.join(', '))}` : ''}</p>`;
    }

    function open(kind, id = '') {
      state.returnFocus = document.activeElement; state.modal = { kind, id }; renderModal();
    }
    function close() {
      const d = document.getElementById('full-dialog'); if (d && d.open) d.close();
      const host = document.getElementById('modal-host'); if (host) host.replaceChildren();
      const wasOpen = Boolean(state.modal); state.modal = null;
      if (wasOpen && hooks.afterClose) hooks.afterClose();
      if (state.returnFocus && state.returnFocus.isConnected) state.returnFocus.focus();
    }
    function titleFor(kind, id) {
      const titles = { directory: 'Your application swarm', app: byId(id) ? byId(id).name : 'Application', embed: byId(id) ? byId(id).name : 'Application', work: (work.find(w => w.id === id) || {}).title || 'Work item', 'work-list': 'Work across the swarm', people: 'People & assistants', provenance: 'What is live in this view', routines: 'Routines and workflows', 'ticket-workflow': `Workflow · ${(work.find(w => w.id === id) || {}).title || 'work item'}` };
      return titles[kind] || (hooks.modalTitle ? hooks.modalTitle(kind, id) : '');
    }
    function contentFor(kind, id) {
      if (kind === 'directory') return directoryPanel();
      if (kind === 'app') return appPanel(id);
      if (kind === 'embed') return embedPanel(id);
      if (kind === 'work') return workPanel(id);
      if (kind === 'work-list') return workListPanel();
      if (kind === 'ticket-workflow') return ticketWorkflowPanel(id);
      if (kind === 'routines' && panels()) return `<div id="routines-body">${panels().routinesPanel(state.routines, state.workflowsList, byId(id))}</div>`;
      if (kind === 'people') return peoplePanel();
      if (kind === 'provenance') return provenancePanel();
      return hooks.modalContent ? hooks.modalContent(kind, id) : '';
    }
    function renderModal() {
      if (!state.modal) return;
      const { kind, id } = state.modal, wide = ['directory', 'work-list', 'embed'].includes(kind);
      const host = document.getElementById('modal-host'); if (!host) return;
      host.innerHTML = `<dialog id="full-dialog" class="${dialogClass}" aria-labelledby="full-dialog-title"><section class="${drawerClass}${wide ? ' directory-panel' : ''}"><div class="drawer-head"><div><h2 id="full-dialog-title">${esc(titleFor(kind, id))}</h2>${wide ? '<p class="panel-kicker">LIVE SWARM / YOUR WORKSPACE</p>' : ''}</div>${button('×', 'close', 'icon-button', 'aria-label="Close panel"')}</div>${contentFor(kind, id)}</section></dialog>`;
      const dialog = document.getElementById('full-dialog');
      dialog.showModal();
      dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
      dialog.addEventListener('click', e => { if (e.target === dialog) close(); });
      if (kind === 'directory') { updateDirectory(); document.getElementById('app-search').focus(); }
      if (kind === 'embed') restoreMemberTool(byId(id));
      if (kind === 'app' && byId(id)) { fillSummary(byId(id)); fillDetail(byId(id)); }
      if (kind === 'routines' && panels()) fillRoutines();
      if (kind === 'app' || kind === 'work') fillVisuals();
      if ((kind === 'work' || kind === 'ticket-workflow') && panels()) { const item = work.find(w => w.id === id); if (item && !state.workFlows.has(id)) fillWork(item); }
      if (kind === 'people' && hooks.peopleDirectory) fillRoster();
      if (kind === 'people') fillPeople();
    }
    function togglePin(id) {
      state.pins = isPinned(id) ? state.pins.filter(x => x !== id) : [...state.pins, id];
      savePins();
      if (state.modal && state.modal.kind === 'directory') {
        updateDirectory(); const chip = document.querySelector('[data-action="filter"][data-suite="pinned"] span'); if (chip) chip.textContent = state.pins.length;
        // The grid was rebuilt: keep the keyboard on the same application's pin (or its card when a filter removed it).
        const again = document.querySelector(`[data-catalog-app="${CSS.escape(id)}"] [data-action="pin"]`) || document.getElementById('app-search'); if (again) again.focus();
      }
      else if (state.modal) renderModal();
      if (hooks.onPinsChanged) hooks.onPinsChanged();
    }
    /** @description Handle the actions every layout shares. Returns true when consumed. */
    function handle(action, target) {
      const id = target.dataset.app, suite = target.dataset.suite;
      if (action === 'close') { close(); return true; }
      if (action === 'retry-work') { retryWork(); return true; }
      if (action === 'directory' || action === 'suite') { state.dirSuite = suite || 'all'; state.dirQuery = ''; open('directory'); return true; }
      if (action === 'filter') { state.dirSuite = suite; updateDirectory(); return true; }
      if (action === 'pin') { togglePin(id); return true; }
      if (action === 'open-app') { open('app', id); return true; }
      if (action === 'embed') { open('embed', id); return true; }
      if (action === 'embed-view') { setEmbedView(target.dataset.view); return true; }
      if (action === 'work-item') { open('work', target.dataset.work); return true; }
      if (action === 'all-work') { open('work-list'); return true; }
      if (action === 'people' || action === 'provenance') { open(action); return true; }
      if (action === 'work-approve' || action === 'work-cancel-confirm') { ticketAction(target, action === 'work-approve' ? 'approve' : 'cancel'); return true; }
      if (action === 'work-cancel' || action === 'work-cancel-keep') { workCancelStep(target, action === 'work-cancel'); return true; }
      if (action === 'ticket-workflow') { open('ticket-workflow', target.dataset.work); return true; }
      if (action === 'routines' && panels()) { open('routines', id || ''); return true; }
      return false;
    }
    function bind(root) {
      window.addEventListener('message', onMemberMessage);
      root.addEventListener('input', e => { if (e.target.id === 'app-search') { state.dirQuery = e.target.value; updateDirectory(); } });
      root.addEventListener('change', e => {
        if (e.target.dataset.role === 'experience-picker') { const exp = experienceFor(e.target.value); if (exp) location.href = exp.href; }
        if (e.target.id === 'scene-picker' && hooks.scenes) setScene(e.target.value);
        if (e.target.dataset.routine && panels()) toggleRoutine(e.target);
        if (e.target.id === 'universal-skin-picker' && window.OSHAL_STYLE_SWITCHER) window.OSHAL_STYLE_SWITCHER.applySkin(e.target.value);
      });
      document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); state.dirSuite = 'all'; state.dirQuery = ''; open('directory'); } });
    }
    function toast(text) {
      const el = document.getElementById('toast'); if (!el) return;
      el.textContent = text; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.textContent = ''; }, 4200);
    }

    /** Conversation engine: one thread per context, persisted on the server, rendered by the layout. */
    function createThread(sessionId, label) {
      const thread = { sessionId, label, turns: [], loaded: false, busy: false };
      thread.load = async () => {
        const r = await LIVE.packages.jarvis.history(sessionId);
        thread.turns = r.ok && r.body && Array.isArray(r.body.turns) ? r.body.turns.map(t => ({ role: t.role === 'user' ? 'user' : 'jarvis', text: t.text })) : [];
        thread.unavailable = !r.ok; thread.loaded = true; return thread;
      };
      thread.send = async (prompt, onUpdate, context) => {
        const text = String(prompt || '').trim(); if (!text || thread.busy) return null;
        thread.busy = true;
        thread.turns.push({ role: 'user', text });
        const pending = { role: 'jarvis', text: 'Sending to Jarvis…', pending: true }; thread.turns.push(pending); onUpdate();
        const result = await LIVE.ask(text, { context, sessionId: thread.explicit ? sessionId : undefined, onPhase: p => {
          if (p.phase === 'accepted') pending.text = 'Jarvis accepted the request and is working…';
          if (p.phase === 'waiting' && p.poll % 8 === 0) pending.text = `Still working (${Math.round(p.poll * 1.5)} s). Tool-using answers can take a minute.`;
          if (p.phase === 'rolled') pending.text = 'Your previous thread was not available under this sign-in; continuing in a fresh one.';
          onUpdate();
        } });
        Object.assign(pending, { pending: false, error: result.status !== 'done', text: result.status === 'done' ? (result.answer || '') : result.error, handoffs: result.handoffs || [], files: result.files || [], taskId: result.taskId || '' });
        thread.busy = false; onUpdate(); return result;
      };
      return thread;
    }
    const threadHtml = thread => thread.turns.map(t => t.role === 'user'
      ? `<div class="user-message">${esc(t.text)}</div>`
      : `<div><div class="message-header">${avatar('J')}Jarvis ${t.pending ? badge('Working', true) : t.error ? badge('Could not answer', true) : ''}</div><div class="message-content">${t.pending ? `<p class="muted">${esc(t.text)}</p>` : t.error ? `<p class="tone-warn">${esc(t.text)}</p>` : answerHtml(t.text)}${(t.handoffs || []).map(chip).join('')}${(t.files || []).map(fileLink).join('')}</div></div>`).join('');
    const threadNote = thread => thread.unavailable ? 'Earlier turns could not be loaded.' : thread.turns.length ? `${thread.turns.length} turns in this thread` : 'A new conversation. Ask anything across your swarm.';

    return { state, apps, suites, work, workState, workCount, overviewCount, workEmpty, workNotice, retryWork, workValue, byId, suiteOf, pinned, isPinned, togglePin, workFor, openWork, attention, timeAgo, appMark, statusBadge, miniApp, workRow, artifactTile, personRow, studyBar, appPanel, workPanel, open, close, renderModal, handle, bind, toast, createThread, threadHtml, threadNote, summaryFor, summaryMarkup, fillSummary,
      gameApps, hostedUrl, embedControls, embedFrame, contextFor, activeMemberFrame, restoreMemberTool, detailSlot, fillDetail, rosterSlot, fillRoster, scene: () => state.scene, setScene, visualFor, fillVisuals, appCard, fillPeople, membershipSlot, membership: () => state.membership };
  }

  window.OSHAL_SHELL = { esc, button, primary, link, avatar, badge, chip, fileLink, answerHtml, withAudience, isGameApp, GAMES_TITLE, EXPERIENCES, readyExperiences, experienceFor, currentExperience, pickerMarkup, skinPicker, createShell };
})();
