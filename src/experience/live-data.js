/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Live data adapter for the experience shells. Joins the caller-scoped home plan, active app listing and admitted navigation into one catalog, merges tickets and Jarvis tasks into work items, wraps Jarvis ask/result polling on the shared browser thread, reads per-package home-summary probes with the Home view's pointer caps, and exposes Little Monsters, Purchasing, Finance and voice reads. It replaces every fixture the design prototypes rendered; nothing here invents data when a source is unavailable, callers get the HTTP status and render the honest state.
 */
(function attach(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.OSHAL_LIVE = api;
})(typeof window !== 'undefined' ? window : globalThis, function build() {
  'use strict';

  /** ADR-097 primary suites. Display copy only; membership comes from each manifest's `suite:`. */
  var SUITE_META = {
    'ai-finance': { name: 'Finance', symbol: 'F', line: 'Money, markets & ventures', accent: '#679682' },
    'ai-engineering': { name: 'Engineering', symbol: 'E', line: 'Design, simulate & build', accent: '#5c85b2' },
    'ai-creative': { name: 'Creative & games', symbol: 'C', line: 'Make something. Play together.', accent: '#aa7ca2' },
    'ai-productivity': { name: 'Productivity', symbol: 'P', line: 'Office, communication & business', accent: '#b99255' },
    'ai-home': { name: 'Home & life', symbol: 'H', line: 'People, places & everyday life', accent: '#849b60' },
    'ai-knowledge': { name: 'Knowledge & career', symbol: 'K', line: 'Understand the world. Find what’s next.', accent: '#8b86b4' },
    platform: { name: 'Platform', symbol: 'O', line: 'Kernel tools, probes & fixtures', accent: '#8a8f98' }
  };
  var SUITE_ORDER = ['ai-finance', 'ai-engineering', 'ai-creative', 'ai-productivity', 'ai-home', 'ai-knowledge', 'platform'];

  /** Raw ticket / Jarvis task statuses seen on the platform, folded to the vocabulary the shells show. */
  var STATUS_LABELS = {
    complete: 'Ready', completed: 'Ready', done: 'Ready', resolved: 'Ready', delivered: 'Ready', closed: 'Closed',
    in_process: 'Working', in_progress: 'Working', running: 'Working', processing: 'Working', summarizing: 'Working', active: 'Working',
    pending: 'Queued', queued: 'Queued', backlog: 'Queued', created: 'Queued', new: 'Queued', open: 'Queued', scheduled: 'Queued',
    review: 'Review', in_review: 'Review', pending_approval: 'Review', awaiting_approval: 'Review', approval: 'Review',
    escalated: 'Escalated', blocked: 'Blocked', paused: 'Paused',
    error: 'Failed', failed: 'Failed', cancelled: 'Cancelled', canceled: 'Cancelled'
  };
  var TONE_BY_LABEL = { Ready: 'good', Working: 'neutral', Queued: 'neutral', Review: 'warn', Escalated: 'warn', Blocked: 'warn', Paused: 'neutral', Failed: 'warn', Cancelled: 'neutral', Closed: 'neutral' };
  var CLOSED_LABELS = { Ready: true, Closed: true, Cancelled: true, Failed: true };

  /** @description Fold a raw platform status into a display label, tone and open/closed flag. */
  function statusOf(raw) {
    var key = String(raw || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    var label = STATUS_LABELS[key] || (key ? key.replace(/_/g, ' ').replace(/^\w/, function (c) { return c.toUpperCase(); }) : 'Unknown');
    return { raw: String(raw || ''), label: label, tone: TONE_BY_LABEL[label] || 'neutral', open: !CLOSED_LABELS[label] };
  }

  /** @description Two-letter mark for a person or application name. */
  function initials(name) {
    var parts = String(name || '').split(/[\s&\-_/·.]+/).filter(Boolean);
    return (parts.slice(0, 2).map(function (s) { return s[0]; }).join('') || '?').toUpperCase();
  }

  /** @description Read the signed-in identity from GET /api/auth/user. Guests and anonymous sessions stay honest. */
  function deriveIdentity(payload) {
    var user = payload && payload.user ? payload.user : null;
    if (!payload || !payload.authenticated || !user) {
      return { authenticated: false, name: 'Guest', initials: '?', sub: '', email: '', mode: payload && payload.mode ? String(payload.mode) : '', guest: Boolean(payload && payload.guestMode) };
    }
    var email = String(user.email || '');
    var handle = function (v) { v = String(v || '').trim(); return v.indexOf('@') > 0 ? v.split('@')[0] : v; };
    var name = String(user.name || user.given_name || handle(user.preferred_username) || user.nickname || handle(email) || 'You').trim();
    return { authenticated: true, name: name, initials: initials(name), sub: String(user.sub || ''), email: email, mode: String(payload.mode || ''), guest: Boolean(payload.guestMode), picture: user.picture || null };
  }

  function suiteId(raw) { return raw && SUITE_META[raw] ? raw : 'platform'; }
  function cockpitHref(name) { return '/cockpit/?app=' + encodeURIComponent(name); }

  /** @description One catalog entry from the plan (authorized facts), the listing (package metadata) and navigation (admitted href). */
  function catalogEntry(plan, summary, workspace) {
    var name = plan ? plan.name : summary.name;
    return {
      id: name,
      name: (plan && plan.displayName) || summary.displayName || name,
      description: (plan && plan.description) || summary.description || '',
      version: summary.version || '',
      suite: suiteId((plan && plan.suite) || summary.suite),
      icon: (plan && plan.icon) || summary.icon || '',
      kind: plan && plan.kind === 'group' ? 'group' : 'app',
      members: plan && Array.isArray(plan.members) ? plan.members : [name],
      surface: plan && typeof plan.firstSurfaceUrl === 'string' ? plan.firstSurfaceUrl : '',
      surfaceName: plan && typeof plan.firstSurface === 'string' ? plan.firstSurface : '',
      href: workspace && typeof workspace.href === 'string' ? workspace.href : cockpitHref(name),
      theme: workspace && workspace.theme ? String(workspace.theme) : '',
      navigable: Boolean(workspace || (plan && plan.firstSurfaceUrl)),
      inPlan: Boolean(plan),
      botCount: Number(summary.botCount || 0),
      toolCount: Number(summary.toolCount || 0),
      ticketType: String(summary.ticketType || '').toLowerCase(),
      queueId: summary.queueId || '',
      connectors: summary.connectors && typeof summary.connectors === 'object' ? summary.connectors : { required: [], optional: [] },
      probes: plan && Array.isArray(plan.summary) ? plan.summary : [],
      todos: plan && Array.isArray(plan.todos) ? plan.todos : [],
      related: plan && Array.isArray(plan.integrationSources)
        ? plan.integrationSources.map(function (s) { return s && s.app; }).filter(function (a, i, arr) { return a && a !== name && arr.indexOf(a) === i; })
        : []
    };
  }

  /** @description Join the three caller-scoped catalog reads. Plan entries carry authority; listed-but-unadmitted apps stay visible as unavailable. */
  function mergeApps(input) {
    var plan = Array.isArray(input.plan) ? input.plan : [];
    var apps = Array.isArray(input.apps) ? input.apps : [];
    var workspaces = Array.isArray(input.workspaces) ? input.workspaces : [];
    var byName = new Map(), summaries = new Map(), navigation = new Map();
    apps.forEach(function (a) { if (a && typeof a.name === 'string') summaries.set(a.name, a); });
    workspaces.forEach(function (w) { if (w && typeof w.name === 'string') navigation.set(w.name, w); });
    plan.forEach(function (entry) {
      if (!entry || typeof entry.name !== 'string') return;
      byName.set(entry.name, catalogEntry(entry, summaries.get(entry.name) || { name: entry.name }, navigation.get(entry.name)));
    });
    apps.forEach(function (summary) {
      if (!summary || typeof summary.name !== 'string' || byName.has(summary.name)) return;
      byName.set(summary.name, catalogEntry(null, summary, navigation.get(summary.name)));
    });
    return Array.from(byName.values()).sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  /** @description Group the catalog by primary suite; the six canonical suites always appear, Platform only when populated. */
  function buildSuites(apps) {
    return SUITE_ORDER.map(function (id) {
      var members = apps.filter(function (a) { return a.suite === id; });
      var spotlight = members.filter(function (a) { return a.probes.length && a.navigable; })[0] || members.filter(function (a) { return a.navigable; })[0] || members[0] || null;
      return Object.assign({ id: id, count: members.length, apps: members, spotlight: spotlight }, SUITE_META[id]);
    }).filter(function (s) { return s.id !== 'platform' || s.count > 0; });
  }

  function parseDate(value) { if (!value) return null; var d = new Date(value); return isNaN(d.getTime()) ? null : d; }

  /** @description Human relative time; the absolute value stays available for titles. */
  function relativeTime(date, now) {
    if (!date) return '';
    var ref = now || new Date();
    var s = Math.round((ref.getTime() - date.getTime()) / 1000);
    if (s < 45) return 'just now';
    var m = Math.round(s / 60); if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60); if (h < 24) return h + ' h ago';
    var d = Math.round(h / 24); if (d < 7) return d + ' d ago';
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function clockTime(date) { return date ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''; }

  /** @description A ticket as a work item. The owning app is inferred from the queue's declared ticket type. */
  function normalizeTicket(t, appByTicketType) {
    var status = statusOf(t.status);
    var app = appByTicketType.get(String(t.ticketType || '').toLowerCase()) || null;
    return {
      id: 'ticket:' + t.ticketId, kind: 'ticket', ref: String(t.ticketId), title: String(t.title || 'Untitled ticket'),
      status: status, typeLabel: String(t.ticketType || 'ticket').replace(/[-_]/g, ' '),
      app: app ? app.id : null, appName: app ? app.name : 'Swarm queue',
      at: parseDate(t.updatedAt || t.createdAt), detail: String(t.description || '').slice(0, 400),
      href: '/cockpit/?ticket=' + encodeURIComponent(t.ticketId), priority: t.priority || null, agent: t.assignedAgentId || null, files: []
    };
  }

  /** @description A Jarvis shelf task as a work item. Complex tasks link to their ticket; simple ones carry their result text. */
  function normalizeTask(t, apps) {
    var status = statusOf(t.status);
    var title = String(t.title || 'Assistant task');
    var prefix = title.split(':')[0].trim().toLowerCase();
    var app = apps.filter(function (a) { return a.name.toLowerCase() === prefix || a.id === prefix; })[0] || null;
    return {
      id: 'task:' + t.id, kind: 'task', ref: String(t.id), title: title, status: status,
      typeLabel: t.kind === 'complex' ? 'swarm task' : 'assistant task',
      app: app ? app.id : null, appName: app ? app.name : 'Jarvis',
      at: parseDate(t.finishedAt || t.createdAt), detail: String(t.result || t.error || '').slice(0, 400),
      result: String(t.result || ''), error: String(t.error || ''), files: Array.isArray(t.files) ? t.files : [],
      href: t.ticketId ? '/cockpit/?ticket=' + encodeURIComponent(t.ticketId) : '/api/jarvis/', ticketId: t.ticketId || null
    };
  }

  /** @description Merge tickets and tasks newest first. */
  function mergeWork(input, apps) {
    var byType = new Map();
    apps.forEach(function (a) { if (a.ticketType) byType.set(a.ticketType, a); });
    var tickets = (Array.isArray(input.tickets) ? input.tickets : []).map(function (t) { return normalizeTicket(t, byType); });
    var tasks = (Array.isArray(input.tasks) ? input.tasks : []).map(function (t) { return normalizeTask(t, apps); });
    return tickets.concat(tasks).sort(function (a, b) { return (b.at ? b.at.getTime() : 0) - (a.at ? a.at.getTime() : 0); });
  }

  /** @description RFC 6901 pointer lookup that distinguishes "missing" from "null". */
  function atPointer(value, pointer) {
    if (pointer === '') return { found: true, value: value };
    if (typeof pointer !== 'string' || pointer.charAt(0) !== '/') return { found: false };
    var current = value, parts = pointer.split('/').slice(1);
    for (var i = 0; i < parts.length; i++) {
      var key = parts[i].replace(/~1/g, '/').replace(/~0/g, '~');
      if (current === null || typeof current !== 'object' || !(key in current)) return { found: false };
      current = current[key];
    }
    return { found: true, value: current };
  }
  function toneOf(t) { return t === 'good' || t === 'warn' ? t : 'neutral'; }

  /** @description Apply the Home view's ADR-145 caps to one package summary response. */
  function normalizeSummary(body, probe) {
    var tiles = [], items = [];
    var tilePointer = probe.metricsPointer || probe.tilesPointer;
    if (tilePointer) {
      var at = atPointer(body, tilePointer);
      if (at.found && Array.isArray(at.value)) at.value.slice(0, 4).forEach(function (t) {
        if (t && typeof t.label === 'string' && typeof t.value === 'string') tiles.push({ label: t.label.slice(0, 24), value: t.value.slice(0, 16), tone: toneOf(t.tone) });
      });
    }
    if (probe.itemsPointer) {
      var list = atPointer(body, probe.itemsPointer);
      if (list.found && Array.isArray(list.value)) list.value.slice(0, 5).forEach(function (it) {
        if (it && typeof it.text === 'string') items.push({ text: it.text.slice(0, 120), detail: typeof it.detail === 'string' ? it.detail.slice(0, 400) : '', tone: toneOf(it.tone), fix: typeof it.fix === 'string' ? it.fix : '', highlight: it.highlight === true });
      });
    }
    return { tiles: tiles, items: items, partial: Boolean(body && body.partial === true), asOf: body && typeof body.asOf === 'string' ? body.asOf : '' };
  }

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(16) + '-' + Math.random().toString(16).slice(2);
  }
  function defaultSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** @description Build the adapter over an injectable fetch and storage so tests can drive it headlessly. */
  function createClient(options) {
    var opts = options || {};
    var fetchImpl = opts.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    var storage = opts.storage || (typeof localStorage !== 'undefined' ? localStorage : { getItem: function () { return null; }, setItem: function () {} });
    var snapshot = null, summaryCache = new Map();

    async function getJson(path, extra) {
      var timeoutMs = extra && extra.timeoutMs ? extra.timeoutMs : 12000;
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
      try {
        var res = await fetchImpl(path, { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: controller ? controller.signal : undefined });
        var body = null; try { body = await res.json(); } catch (_) { body = null; }
        return { ok: res.ok, status: res.status, body: body };
      } catch (err) { return { ok: false, status: 0, body: null, error: err }; }
      finally { if (timer) clearTimeout(timer); }
    }
    async function sendJson(path, method, payload) {
      try {
        var res = await fetchImpl(path, { method: method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) });
        var body = null; try { body = await res.json(); } catch (_) { body = null; }
        return { ok: res.ok, status: res.status, body: body };
      } catch (err) { return { ok: false, status: 0, body: null, error: err }; }
    }
    function list(res, key) { return res.ok && res.body && Array.isArray(res.body[key]) ? res.body[key] : []; }

    /** @description Load everything the shells share, in parallel; a failed source is reported, never faked. */
    async function load() {
      var results = await Promise.all([
        getJson('/api/auth/user'), getJson('/api/swarm/apps/home-plan'), getJson('/api/swarm/apps?status=active'),
        getJson('/api/ui/workspaces'), getJson('/api/jarvis/tasks'), getJson('/api/tickets?limit=100'), getJson('/api/jarvis/overview')
      ]);
      var auth = results[0], plan = results[1], apps = results[2], ws = results[3], tasks = results[4], tickets = results[5], overview = results[6];
      var sources = { auth: auth.status, plan: plan.status, apps: apps.status, workspaces: ws.status, tasks: tasks.status, tickets: tickets.status, overview: overview.status };
      var catalog = mergeApps({ plan: list(plan, 'apps'), apps: list(apps, 'apps'), workspaces: list(ws, 'workspaces') });
      var work = mergeWork({ tickets: list(tickets, 'tickets'), tasks: list(tasks, 'tasks') }, catalog);
      var ov = overview.ok && overview.body ? overview.body : {};
      var bots = Array.isArray(ov.bots) ? ov.bots : [];
      var openFromWork = work.filter(function (w) { return w.kind === 'ticket' && w.status.open; }).length;
      snapshot = {
        me: deriveIdentity(auth.body), apps: catalog, suites: buildSuites(catalog), work: work, bots: bots,
        botsOnline: bots.filter(function (b) { return b.online; }).length,
        openTickets: ov.activity && typeof ov.activity.openCount === 'number' ? ov.activity.openCount : openFromWork,
        comms: ov.comms || null, calendarEvents: ov.calendar && Array.isArray(ov.calendar.events) ? ov.calendar.events : [],
        sources: sources, loadedAt: new Date(),
        unavailable: Object.keys(sources).filter(function (k) { return sources[k] !== 200; })
      };
      return snapshot;
    }

    /** @description Ask the app's own home-summary probes in the viewer's session; cached briefly per app. */
    async function probeSummary(app) {
      if (!app || !app.probes.length) return { tiles: [], items: [], ok: false, none: true, status: 0, partial: false, asOf: '' };
      var cached = summaryCache.get(app.id);
      if (cached && Date.now() - cached.at < 60000) return cached.value;
      var responses = await Promise.all(app.probes.map(function (probe) { return getJson(probe.path, { timeoutMs: 8000 }).then(function (r) { return { probe: probe, res: r }; }); }));
      var out = { tiles: [], items: [], ok: false, none: false, status: responses[0] ? responses[0].res.status : 0, partial: false, asOf: '' };
      responses.forEach(function (entry) {
        if (!entry.res.ok || !entry.res.body) return;
        var s = normalizeSummary(entry.res.body, entry.probe);
        out.ok = true; out.tiles = out.tiles.concat(s.tiles).slice(0, 4); out.items = out.items.concat(s.items).slice(0, 5);
        out.partial = out.partial || s.partial; out.asOf = out.asOf || s.asOf;
      });
      summaryCache.set(app.id, { at: Date.now(), value: out });
      return out;
    }

    function sessionId() {
      try { var s = storage.getItem('jarvisSessionId'); if (!s) { s = 'jarvis-' + uuid(); storage.setItem('jarvisSessionId', s); } return s; }
      catch (_) { return 'jarvis-' + Date.now(); }
    }
    function rollSession() { var s = 'jarvis-' + uuid(); try { storage.setItem('jarvisSessionId', s); } catch (_) { /* device storage unavailable */ } return s; }

    function finishAsk(d, jobId, session) {
      if (d.status === 'expired') return { status: 'error', error: 'That request expired before an answer arrived.', jobId: jobId, sessionId: session };
      if (d.status === 'error') return { status: 'error', error: String(d.error || 'That did not work.'), code: d.code || '', jobId: jobId, taskId: d.taskId || '', sessionId: session };
      return {
        status: 'done', answer: String(d.answer || ''), handoffs: Array.isArray(d.handoffs) ? d.handoffs : [], files: Array.isArray(d.files) ? d.files : [],
        visual: d.visual || null, brainFallback: d.brainFallback || null, taskId: d.taskId || '', label: d.label || '', jobId: jobId, sessionId: session
      };
    }

    /** @description POST /api/jarvis/ask and poll /ask/result to a terminal state. Mirrors the Jarvis page: a refused persisted thread rolls to a fresh id once. */
    async function ask(message, config) {
      var c = config || {}, onPhase = c.onPhase || function () {}, sleep = c.sleep || defaultSleep;
      var text = String(message || '').trim();
      if (!text) return { status: 'error', error: 'Say what you need first.' };
      var session = c.sessionId || sessionId();
      onPhase({ phase: 'sending', sessionId: session });
      var payload = { message: text, sessionId: session };
      var r = await sendJson('/api/jarvis/ask', 'POST', payload);
      if (r.status === 404 && r.body && r.body.error === 'session_not_found' && !c.sessionId) {
        session = rollSession(); payload.sessionId = session; onPhase({ phase: 'rolled', sessionId: session });
        r = await sendJson('/api/jarvis/ask', 'POST', payload);
      }
      if (!r.ok || !r.body || !r.body.jobId) {
        var reason = r.status === 0 ? 'The swarm could not be reached.' : (r.body && (r.body.message || r.body.error)) ? String(r.body.message || r.body.error) : 'HTTP ' + r.status;
        return { status: 'error', error: reason, httpStatus: r.status, sessionId: session };
      }
      var jobId = r.body.jobId;
      onPhase({ phase: 'accepted', jobId: jobId, sessionId: session });
      var maxPolls = c.maxPolls || 200, pollMs = c.pollMs || 1500;
      for (var i = 0; i < maxPolls; i++) {
        var p = await getJson('/api/jarvis/ask/result?jobId=' + encodeURIComponent(jobId));
        var d = p.ok && p.body ? p.body : null;
        if (d && d.status && d.status !== 'pending') return finishAsk(d, jobId, session);
        onPhase({ phase: 'waiting', jobId: jobId, sessionId: session, poll: i + 1 });
        await sleep(pollMs);
      }
      return { status: 'error', error: 'This is taking unusually long. It may still finish; check Jarvis later.', jobId: jobId, sessionId: session };
    }

    /** @description Speak text through the swarm's voice route, falling back to the browser engine. Level callbacks are amplitude when an analyser is available, lifecycle pulses otherwise. */
    function speak(text, hooks) {
      var h = hooks || {}, onLevel = h.onLevel || function () {}, onStart = h.onStart || function () {}, onEnd = h.onEnd || function () {};
      var state = { stopped: false, audio: null, frame: 0, timer: 0, context: null };
      function end() {
        if (state.stopped) return;
        state.stopped = true;
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(state.frame);
        clearInterval(state.timer);
        if (state.audio) { try { state.audio.pause(); } catch (_) { /* already stopped */ } }
        if (state.context) { try { state.context.close(); } catch (_) { /* closed */ } }
        if (typeof speechSynthesis !== 'undefined') { try { speechSynthesis.cancel(); } catch (_) { /* no engine */ } }
        onLevel(0); onEnd();
      }
      function browserEngine() {
        if (typeof SpeechSynthesisUtterance === 'undefined' || typeof speechSynthesis === 'undefined') { onStart('unavailable'); setTimeout(end, 1200); return; }
        onStart('lifecycle');
        var u = new SpeechSynthesisUtterance(text); u.rate = 1.02;
        var level = 0.3;
        state.timer = setInterval(function () { level = Math.max(0.15, level * 0.82); onLevel(level); }, 120);
        u.onboundary = function () { level = Math.min(1, level + 0.45); };
        u.onend = end; u.onerror = end;
        try { speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (_) { end(); }
      }
      function attachAnalyser(audio) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return false;
        state.context = new Ctx();
        var source = state.context.createMediaElementSource(audio), analyser = state.context.createAnalyser();
        analyser.fftSize = 256; source.connect(analyser); analyser.connect(state.context.destination);
        var data = new Uint8Array(analyser.frequencyBinCount);
        var tick = function () {
          if (state.stopped) return;
          analyser.getByteTimeDomainData(data);
          var sum = 0;
          for (var i = 0; i < data.length; i++) { var v = (data[i] - 128) / 128; sum += v * v; }
          onLevel(Math.min(1, Math.sqrt(sum / data.length) * 3));
          state.frame = requestAnimationFrame(tick);
        };
        state.frame = requestAnimationFrame(tick);
        return true;
      }
      sendJson('/api/voice/synthesize', 'POST', { text: text }).then(function (r) {
        var d = r.ok && r.body && r.body.data ? r.body.data : null;
        if (!d || !d.audioData) throw new Error('no audio');
        var fmt = String(d.format || 'wav'), mime = fmt.indexOf('/') >= 0 ? fmt : 'audio/' + fmt;
        var audio = new Audio('data:' + mime + ';base64,' + d.audioData); state.audio = audio;
        audio.onended = end; audio.onerror = end;
        var amplitude = false;
        try { amplitude = attachAnalyser(audio); } catch (_) { amplitude = false; }
        if (!amplitude) { state.timer = setInterval(function () { onLevel(0.35 + Math.random() * 0.4); }, 140); }
        onStart(amplitude ? 'amplitude' : 'lifecycle');
        return audio.play();
      }).catch(function () { if (!state.stopped) browserEngine(); });
      return { stop: end };
    }

    /** Device-local display preferences (ADR-164 D9: session/device scope, never a server setting). */
    var prefs = {
      get: function (key, fallback) { try { var v = storage.getItem('oshal-experience:' + key); return v === null ? fallback : JSON.parse(v); } catch (_) { return fallback; } },
      set: function (key, value) { try { storage.setItem('oshal-experience:' + key, JSON.stringify(value)); return true; } catch (_) { return false; } }
    };

    var packages = {
      education: {
        me: function () { return getJson('/api/education/me'); },
        classes: function () { return getJson('/api/education/classes'); },
        students: function (id) { return getJson('/api/education/classes/' + encodeURIComponent(id) + '/students'); },
        assignments: function () { return getJson('/api/education/assignments'); },
        calendar: function (month) { return getJson('/api/education/calendar' + (month ? '?month=' + encodeURIComponent(month) : '')); },
        addEvent: function (payload) { return sendJson('/api/education/calendar', 'POST', payload); }
      },
      purchasing: {
        lists: function () { return getJson('/api/purchasing/lists'); },
        items: function (id) { return getJson('/api/purchasing/lists/' + encodeURIComponent(id) + '/items'); },
        add: function (id, title, quantity) { return sendJson('/api/purchasing/lists/' + encodeURIComponent(id) + '/items', 'POST', { title: title, quantity: quantity || 1 }); },
        remove: function (id, itemId) { return sendJson('/api/purchasing/lists/' + encodeURIComponent(id) + '/items/' + encodeURIComponent(itemId), 'DELETE'); }
      },
      finance: {
        summary: function () { return getJson('/api/finance/summary'); },
        homeSummary: function () { return getJson('/api/finance/home-summary'); }
      },
      jarvis: {
        history: function (sid) { return getJson('/api/jarvis/history' + (sid ? '?sessionId=' + encodeURIComponent(sid) : '')); },
        tasks: function () { return getJson('/api/jarvis/tasks'); }
      },
      directory: function () { return getJson('/api/user-directory'); }
    };

    return {
      load: load, get snapshot() { return snapshot; }, probeSummary: probeSummary, ask: ask, speak: speak,
      sessionId: sessionId, rollSession: rollSession, prefs: prefs, packages: packages, getJson: getJson, sendJson: sendJson
    };
  }

  var api = {
    SUITE_META: SUITE_META, SUITE_ORDER: SUITE_ORDER, statusOf: statusOf, initials: initials, deriveIdentity: deriveIdentity,
    mergeApps: mergeApps, buildSuites: buildSuites, mergeWork: mergeWork, normalizeTicket: normalizeTicket, normalizeTask: normalizeTask,
    atPointer: atPointer, normalizeSummary: normalizeSummary, relativeTime: relativeTime, clockTime: clockTime, parseDate: parseDate,
    createClient: createClient
  };
  if (typeof window !== 'undefined' && typeof fetch === 'function') {
    var client = createClient();
    Object.keys(client).forEach(function (k) {
      if (!(k in api)) Object.defineProperty(api, k, { get: function () { return client[k]; }, enumerable: true });
    });
    api.ready = client.load();
  }
  return api;
});
