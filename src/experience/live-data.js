/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Two-phase snapshot: identity and catalog first (readyCore) so a home can paint at once; work, tasks and overview merge into the same snapshot afterwards (ready). Adds the ribbon-profile read an experience uses to host an application's admitted tools.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Live data adapter for the experience shells. Joins the caller-scoped home plan, active app listing and admitted navigation into one catalog, merges tickets and Jarvis tasks into work items, wraps Jarvis ask/result polling on the shared browser thread, reads per-package home-summary probes with the Home view's pointer caps, and exposes Little Monsters, Purchasing, Finance and voice reads. It replaces every fixture the design prototypes rendered; nothing here invents data when a source is unavailable, callers get the HTTP status and render the honest state.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Catalog `related` now means a group's installed required members (plan.members), not the plan's integrationSources, which list surfaces and outbound offers rather than a dependency. Adds the viewer-scoped app-detail read (GET /api/swarm/apps/:name) with two pure readers over it: dependencyTiers (the two-form rule of scripts/oshal-app-dependencies.js, a mixed block yields no tiers) and declaredAssistants (manifest bots by name, the explicit chatBot as concierge, online state only where the agentId joins the overview roster). Adds the swarm roster read over GET /api/user-directory (label without its account parenthetical, account source and sign-in status, never presence) and the Little Monsters agenda read (this month and next from /api/education/calendar, de-duplicated and dated) so Commons and Jarvis share them without touching the homebase.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Central-assistant gap closure over existing contracts only. ask() takes an AbortSignal threaded through the POST, every /ask/result poll and the sleep between them, so a page that stops, starts over or goes home ends the wait at once (status 'aborted') instead of polling a request nobody is watching; a refused /ask now carries the route's machine `code` (the 503 ai_disabled posture), and a done payload passes through the well-formed `dispatched` hand-offs and the `packageToolProposal` the route already returns. New helpers: transcribe() posts one recording as multipart field `audio` to /api/voice/transcribe and folds the route's envelope into text / unconfigured / empty / failed; jarvis.markDelivered() and jarvis.cancelWork() reach POST /api/jarvis/tasks/:id/delivered and the owner-checked PUT /api/tickets/:ticketId/cancel.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Package adapters for the homebase gap closure over existing routes only: Little Monsters class activity (teacher analytics) and classwork creation through the route that also writes the class calendar event, a ticket read and its status transition, and the caller's saved content drafts. Each returns the route's own answer, refusals included.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | JSDoc for the background-work client members (markDelivered, cancelWork)
 * 7 | maintainer@emeraldcoastsystemsgroup.com | Integration review: one same-origin guard, localHref, resolves a server-provided link against the page origin the way the browser will (tab/CR/LF stripped, a backslash read as a slash) and keeps only a path that stays on this origin, so '//host', '/\host' and a tab-split '/<TAB>/host' can never become a link. ask()'s poll-limit result carries code 'poll_limit' so a caller can say the page stopped checking instead of calling the request failed. The roster read keeps the route's refusal code (roster_scope_denied vs roster_administrator_required). markDelivered is removed: the Jarvis page stays the one surface that announces and marks results.
 * 8 | maintainer@emeraldcoastsystemsgroup.com | Fix round 1: localHref checks the path it returns as well as the URL it resolved. Dot segments normalise '/..//host', '/.//host' and '/%2e%2e//host' to a pathname that starts with '//', which the guard returned as a protocol-relative link that opens another origin; now a returned path must not start with '//' and must itself resolve to the page origin. The admitted navigation href from GET /api/ui/workspaces goes through the same guard and falls back to the cockpit link when refused, so every catalog Open link stays on this origin.
 * 9 | maintainer@emeraldcoastsystemsgroup.com | Acceptance fixes: calendarDay reads a date-only field ('YYYY-MM-DD' or exactly UTC midnight, how a Postgres DATE reaches JSON) as that local calendar day, so a Little Monsters due date no longer prints a day early west of Greenwich (due_date was the only field read through `new Date(iso)`); event and last-active dates were already read as local days and now share the helper, as do the agenda's class events. probeSummary carries the first probe's refusal code as `error`, and littleMonstersRefusal names an application-authorization refusal (403 app_access_* / authorization_*) apart from the package's no-school-profile sentence, so a shell stops telling an unadmitted caller to open Little Monsters.
 * 10 | maintainer@emeraldcoastsystemsgroup.com | Every canonical ticket state now folds to a label a shell can place: approved (Approved, waiting for the queue), approval_required (Approval required) and customer_action (Needs you) wait on a person, dead_letter reads Blocked, and every in_process_* phase is Working (they printed as "In process build" and fell off the Commons board, and an approval gate was never counted as needing you). STATUS_GROUPS names the attention / moving / done label sets the shells share for briefings and board columns.
 * 12 | maintainer@emeraldcoastsystemsgroup.com | speak(): a readback stopped while POST /api/voice/synthesize is still answering never starts (the answer is dropped before any Audio element or browser utterance is created), and progress is reported through an onProgress hook where it is known (the audio element's time over its duration; the utterance's boundary index over the text length).
 * 11 | maintainer@emeraldcoastsystemsgroup.com | Adapters for the full-swarm build over existing routes: one ticket's workflow read model (GET /api/v1/tickets/:id/workflow) and its owner-checked cancel, the caller's schedules with pause/resume (GET /api/v1/agent/schedules, POST /:id/pause|resume), Workflow Studio definitions, household/team membership (GET /api/tenants, /:id/members) and the caller's own location overview (GET /api/location/state). The catalog keeps the listing's package status for the package-facts panel.
 * 13 | maintainer@emeraldcoastsystemsgroup.com | Distinguish loading, partial and unavailable work from successful empty reads; preserve admitted rows and unknown counts with accessible retry.
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Keep readable personal overview fields when the global roster is intentionally omitted; qualify calendar readiness separately without inventing assistant totals.
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

  /**
   * Raw ticket / Jarvis task statuses seen on the platform, folded to the vocabulary the shells show. The canonical
   * ticket states (OshalTicketStateSchema) are all named: approved waits for the queue, approval_required and
   * customer_action wait on a person, dead_letter is parked until an operator requeues it, and every in_process_*
   * phase is Working (statusOf folds the prefix).
   */
  var STATUS_LABELS = {
    complete: 'Ready', completed: 'Ready', done: 'Ready', resolved: 'Ready', delivered: 'Ready', closed: 'Closed',
    in_process: 'Working', in_progress: 'Working', running: 'Working', processing: 'Working', summarizing: 'Working', active: 'Working',
    pending: 'Queued', queued: 'Queued', backlog: 'Queued', created: 'Queued', new: 'Queued', open: 'Queued', scheduled: 'Queued',
    approved: 'Approved', approval_required: 'Approval required', customer_action: 'Needs you', dead_letter: 'Blocked',
    review: 'Review', in_review: 'Review', pending_approval: 'Review', awaiting_approval: 'Review', approval: 'Review',
    escalated: 'Escalated', blocked: 'Blocked', paused: 'Paused',
    error: 'Failed', failed: 'Failed', cancelled: 'Cancelled', canceled: 'Cancelled'
  };
  var TONE_BY_LABEL = { Ready: 'good', Working: 'neutral', Queued: 'neutral', Approved: 'neutral', Review: 'warn', 'Approval required': 'warn', 'Needs you': 'warn', Escalated: 'warn', Blocked: 'warn', Paused: 'neutral', Failed: 'warn', Cancelled: 'neutral', Closed: 'neutral' };
  var CLOSED_LABELS = { Ready: true, Closed: true, Cancelled: true, Failed: true };
  /**
   * The three places a work item belongs on a board or in a briefing: it waits on a person (attention), it is moving
   * through the swarm (moving), or it is finished (done). Every label statusOf can produce for a known state is in one.
   */
  var STATUS_GROUPS = {
    attention: ['Review', 'Approval required', 'Needs you', 'Escalated', 'Blocked', 'Failed'],
    moving: ['Working', 'Queued', 'Approved', 'Paused'],
    done: ['Ready', 'Closed', 'Cancelled']
  };

  /** @description Fold a raw platform status into a display label, tone and open/closed flag. */
  function statusOf(raw) {
    var key = String(raw || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    var label = STATUS_LABELS[key] || (/^in_process_/.test(key) ? 'Working' : key ? key.replace(/_/g, ' ').replace(/^\w/, function (c) { return c.toUpperCase(); }) : 'Unknown');
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

  /**
   * @description The one same-origin guard for links a server or model hands the page (hand-off deepLinks, '/'
   * answer links, file downloads, admitted workspace navigation). The URL is resolved exactly as the browser will
   * resolve an href, which strips tab/CR/LF and reads a backslash as a slash, so '/\t/host', '/\\host' and '//host'
   * all resolve to another origin and are refused. The string handed back is checked again: dot segments can
   * normalise a same-origin path to one that starts with '//' ('/..//host', '/%2e%2e//host'), which as an href is
   * protocol-relative and leaves the origin, so the returned path must not start with '//' and must itself resolve
   * to the page origin. Only a string that starts with '/' and stays on the page origin is kept.
   * @param {unknown} u Candidate link from a payload.
   * @param {string} [origin] Page origin; defaults to location.origin in a browser.
   * @returns {string} pathname + search + hash of the resolved same-origin URL, or '' when it is not one.
   */
  function localHref(u, origin) {
    if (typeof u !== 'string' || u.charAt(0) !== '/') return '';
    var page = origin || (typeof location !== 'undefined' && location.origin && location.origin !== 'null' ? location.origin : 'https://local.invalid');
    try {
      var base = new URL(page), resolved = new URL(u, base);
      if (resolved.origin !== base.origin) return '';
      var out = resolved.pathname + resolved.search + resolved.hash;
      return out.charAt(0) === '/' && out.charAt(1) !== '/' && new URL(out, base).origin === base.origin ? out : '';
    } catch (_) { return ''; }
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
      status: typeof summary.status === 'string' ? summary.status : '',
      suite: suiteId((plan && plan.suite) || summary.suite),
      icon: (plan && plan.icon) || summary.icon || '',
      kind: plan && plan.kind === 'group' ? 'group' : 'app',
      members: plan && Array.isArray(plan.members) ? plan.members : [name],
      surface: plan && typeof plan.firstSurfaceUrl === 'string' ? plan.firstSurfaceUrl : '',
      surfaceName: plan && typeof plan.firstSurface === 'string' ? plan.firstSurface : '',
      // The admitted navigation href goes through the same guard; a link that would leave this origin falls back to the cockpit link.
      href: (workspace && localHref(workspace.href)) || cockpitHref(name),
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
      // A group's members are its installed REQUIRED app dependencies (the plan filters them); a plain app has none.
      related: plan && plan.kind === 'group' && Array.isArray(plan.members)
        ? plan.members.filter(function (m, i, arr) { return typeof m === 'string' && m && m !== name && arr.indexOf(m) === i; })
        : []
    };
  }

  var DEPENDENCY_KINDS = ['apps', 'tools', 'connectors'];
  function isMapping(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
  function dependencyLists(value) {
    var lists = { apps: [], tools: [], connectors: [] };
    if (!isMapping(value)) return lists;
    DEPENDENCY_KINDS.forEach(function (kind) {
      if (Array.isArray(value[kind])) lists[kind] = value[kind].filter(function (entry) { return typeof entry === 'string'; });
    });
    return lists;
  }

  /**
   * @description Read a manifest's `dependencies` block into its two tiers with the same two-form rule the
   * installer uses (scripts/oshal-app-dependencies.js): tiered `required`/`optional` keys give the tiers, a
   * legacy flat block is all required, and a block that mixes both forms is refused there, so it yields no
   * tiers here and the shell says so instead of guessing.
   * @param {object} manifest The package manifest from GET /api/swarm/apps/:name (body.app.manifest).
   * @returns {{form: string, required: object, optional: object}} form is none | flat | tiered | mixed | invalid; each tier holds apps/tools/connectors lists.
   */
  function dependencyTiers(manifest) {
    var value = manifest ? manifest.dependencies : undefined;
    var result = { form: 'none', required: dependencyLists(null), optional: dependencyLists(null) };
    if (value === undefined || value === null) return result;
    if (!isMapping(value)) { result.form = 'invalid'; return result; }
    var keys = Object.keys(value);
    var tiered = keys.some(function (k) { return k === 'required' || k === 'optional'; });
    if (tiered && keys.some(function (k) { return DEPENDENCY_KINDS.indexOf(k) >= 0; })) { result.form = 'mixed'; return result; }
    if (tiered) return { form: 'tiered', required: dependencyLists(value.required), optional: dependencyLists(value.optional) };
    return { form: 'flat', required: dependencyLists(value), optional: dependencyLists(null) };
  }

  /**
   * @description The assistants a package declares, by name, from its manifest. Only an explicit `chatBot`
   * is marked as the concierge (the runtime defaults are not inferred), and online state appears only when
   * the declared agentId joins the swarm overview roster; otherwise the row says it is a declaration.
   * @param {object} record The application record from GET /api/swarm/apps/:name (body.app).
   * @param {Array} bots The overview roster (snapshot.bots: agentId, online, active).
   * @param {string} concierge The concierge name to mark; defaults to the record's own manifest.chatBot.
   * @returns {Array<{name: string, role: string, agentId: string, concierge: boolean, state: string}>} state is working | online | offline | declared.
   */
  function declaredAssistants(record, bots, concierge) {
    var manifest = record && isMapping(record.manifest) ? record.manifest : {};
    var chat = typeof concierge === 'string' ? concierge : (typeof manifest.chatBot === 'string' ? manifest.chatBot : '');
    var roster = Array.isArray(bots) ? bots : [];
    var declared = (Array.isArray(manifest.bots) ? manifest.bots : []).filter(function (b) { return b && typeof b.name === 'string' && b.name; });
    return declared.map(function (b) {
      var live = b.agentId ? roster.filter(function (r) { return r && r.agentId === b.agentId; })[0] : null;
      return {
        name: b.name, role: typeof b.role === 'string' ? b.role : '', agentId: typeof b.agentId === 'string' ? b.agentId : '',
        concierge: Boolean(chat) && b.name === chat, state: live ? (live.active ? 'working' : live.online ? 'online' : 'offline') : 'declared'
      };
    });
  }

  var ACCOUNT_SOURCES = { 'local-account': 'Local account', 'verified-sign-in': 'Verified sign-in', 'access-assignment': 'Access assignment' };
  var SIGN_IN_STATES = { active: 'account active', disabled: 'account disabled', 'awaiting-sign-in': 'awaiting first sign-in', 'provider-disabled': 'sign-in provider disabled' };
  /**
   * @description The swarm roster from GET /api/user-directory as display rows: the label without its account
   * parenthetical, and the account source plus sign-in status. It is a roster of accounts, never presence.
   * @param {{ok: boolean, status: number, body: object}} res The directory read.
   * @param {string} selfSub The caller's subject, so the caller's own row can be told apart.
   * @returns {{ok: boolean, status: number, error: string, people: Array<{sub: string, name: string, detail: string, self: boolean}>}} error is the route's refusal code (roster_scope_denied, roster_administrator_required) or ''.
   */
  function directoryPeople(res, selfSub) {
    var users = res && res.ok && res.body && Array.isArray(res.body.users) ? res.body.users : [];
    var people = users.filter(function (u) { return u && typeof u.sub === 'string' && u.sub; }).map(function (u) {
      var source = ACCOUNT_SOURCES[u.source] || (u.source ? String(u.source).replace(/-/g, ' ') : '');
      var signIn = u.signIn && u.signIn !== u.source ? (SIGN_IN_STATES[u.signIn] || String(u.signIn).replace(/-/g, ' ')) : '';
      return { sub: u.sub, name: String(u.label || '').replace(/\s*\([^)]*\)\s*$/, '').trim() || 'Member', detail: [source, signIn].filter(Boolean).join(' · '), self: Boolean(selfSub) && u.sub === selfSub };
    });
    var error = res && !res.ok && res.body && typeof res.body.error === 'string' ? res.body.error : '';
    return { ok: Boolean(res && res.ok), status: res ? res.status : 0, error: error, people: people };
  }

  /**
   * @description Little Monsters calendar responses as dated agenda rows: de-duplicated by event id, dated from
   * event_date plus event_time (untimed events are all-day), and sorted. Rows keep the class they belong to.
   * @param {Array<{ok: boolean, body: object}>} responses One GET /api/education/calendar?month= read per month.
   * @returns {Array<{id: string, title: string, when: Date, timed: boolean, className: string}>}
   */
  function classEvents(responses) {
    var seen = {}, rows = [];
    (responses || []).forEach(function (r) {
      (r && r.ok && r.body && Array.isArray(r.body.events) ? r.body.events : []).forEach(function (e) {
        if (!e || !e.event_id || seen[e.event_id]) return;
        seen[e.event_id] = true;
        var when = calendarDay(e.event_date, e.event_time);
        if (!when) return;
        rows.push({ id: String(e.event_id), title: String(e.title || 'Event'), when: when, timed: Boolean(e.event_time), className: e.class_name ? String(e.class_name) : '' });
      });
    });
    return rows.sort(function (a, b) { return a.when.getTime() - b.when.getTime(); });
  }
  function monthKey(date) { return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0'); }

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

  /** A date-only value: 'YYYY-MM-DD', or exactly UTC midnight ('YYYY-MM-DDT00:00:00Z', optional .0-.000), the form a Postgres DATE column takes in JSON when the server runs in UTC. */
  var DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.0{1,3})?Z)?$/;
  var CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/;
  /**
   * @description The local calendar day a date-only field names. `new Date('2026-09-29T00:00:00.000Z')` is UTC
   * midnight, which every zone west of Greenwich prints as Sep 28; a due date or an event date is a day, not an
   * instant, so a date-only value becomes local midnight of that same Y-M-D. Any other value is an instant and
   * yields the local day it falls on. An optional wall-clock time ('HH:MM[:SS]', e.g. a Little Monsters event_time)
   * is applied to that day.
   * @param {string|Date|null|undefined} value The field as the route sent it.
   * @param {string} [time] Optional local time of day.
   * @returns {Date|null} Local midnight of the day (or that day at `time`), or null when the value is not a date.
   */
  function calendarDay(value, time) {
    var m = DATE_ONLY.exec(String(value === null || value === undefined ? '' : value).trim());
    var day = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : parseDate(value);
    if (!day || isNaN(day.getTime())) return null;
    if (m && (day.getFullYear() !== Number(m[1]) || day.getMonth() !== Number(m[2]) - 1 || day.getDate() !== Number(m[3]))) return null;
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    var t = CLOCK.exec(String(time || ''));
    if (t) day.setHours(Number(t[1]), Number(t[2]), Number(t[3] || 0), 0);
    return day;
  }

  /** Little Monsters' read-only probe refuses a caller with no school profile with this sentence (resolveAuthedStudent readOnly); the package sends no machine code, so the sentence is its contract. */
  var LM_SETUP_REQUIRED = 'Open Little Monsters to complete school setup';
  /**
   * @description Name a Little Monsters refusal from the status and the route's `error` field. The platform's
   * application authorization refuses with 403 and a machine code (`app_access_denied` / `app_access_identity_required`
   * / `app_readonly` from the app-access gate, `authorization_*` from the catalog runtime): the caller is not admitted.
   * The package's own 403 with its setup sentence means the caller is admitted but has no school profile yet. Anything
   * else is an ordinary refusal or failure the caller shows with its status.
   * @param {number} status HTTP status.
   * @param {string} [error] The response body's `error` string.
   * @returns {'not-granted'|'no-profile'|''} The refusal kind, or '' for any other outcome.
   */
  function littleMonstersRefusal(status, error) {
    var code = typeof error === 'string' ? error : '';
    if (status !== 403) return '';
    if (/^(app_access_|app_readonly$|authorization_)/.test(code)) return 'not-granted';
    return code === LM_SETUP_REQUIRED ? 'no-profile' : '';
  }

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

  /**
   * @description Wait between polls, waking early when the caller aborts, so a stopped request does not hold the page for another poll interval.
   * @param {number} ms Poll interval.
   * @param {AbortSignal|null} signal The request's abort signal, when the caller supplied one.
   * @returns {Promise<void>} Resolves after the interval or on abort, whichever comes first.
   */
  function abortableSleep(ms, signal) {
    return new Promise(function (done) {
      if (signal && signal.aborted) { done(); return; }
      var timer = setTimeout(finish, ms);
      function finish() { clearTimeout(timer); if (signal) signal.removeEventListener('abort', finish); done(); }
      if (signal) signal.addEventListener('abort', finish);
    });
  }

  /**
   * @description Keep only the well-formed hand-off records of a done /ask/result payload ({ workJobId, title }, the shape dispatchHandoffs returns); anything else is dropped rather than guessed at.
   * @param {unknown} raw The payload's `dispatched` field.
   * @returns {Array<{workJobId: string, title: string}>} The background work items the page may track on GET /api/jarvis/tasks.
   */
  function dispatchedList(raw) {
    return (Array.isArray(raw) ? raw : []).filter(function (d) { return d && typeof d.workJobId === 'string' && d.workJobId.length > 0; })
      .map(function (d) { return { workJobId: d.workJobId, title: String(d.title || 'Background work').slice(0, 200) }; });
  }

  /**
   * @description Derive presentation readiness from existing work receipts without interpreting absence as zero.
   * @param {object} snapshot Current snapshot and source statuses.
   * @param {string[]} [keys] Required sources; defaults to tickets and tasks.
   * @returns {{kind:string,complete:boolean,message:string,detail:string}} Concise presentation state; source details belong in provenance.
   */
  function sourceState(snapshot, keys) {
    var snap = snapshot || {}, sources = snap.sources || {}, selected = keys || ['tickets', 'tasks'];
    var names = { tickets: 'Tickets', tasks: 'Assistant tasks', overview: 'Assistant status', overviewCalendar: 'Calendar', overviewComms: 'Communications' };
    var sourceKey = function (key) { return key === 'overviewCalendar' || key === 'overviewComms' ? 'overview' : key; };
    var pending = snap.workLoading || snap.workLoaded === false || (snap.workLoaded !== true && selected.some(function (key) { return sources[sourceKey(key)] === undefined; }));
    if (pending) return { kind: 'loading', complete: false, message: selected.length === 1 ? 'Loading ' + names[selected[0]].toLowerCase() + '…' : 'Loading work…', detail: '' };
    var valid = snap.sourceValidity || {};
    var failed = selected.filter(function (key) { return sources[sourceKey(key)] !== 200 || valid[key] === false; });
    if (!failed.length) return { kind: 'ready', complete: true, message: '', detail: '' };
    var partial = failed.length < selected.length || failed.some(function (key) { return snap.sourcePartial && snap.sourcePartial[key]; });
    var detail = failed.map(function (key) {
      var status = sources[sourceKey(key)], label = names[key] || 'Work';
      if (key === 'overview' && snap.overviewRosterOmitted) return 'Global assistant status is not provided to this session.';
      if (status === 200 && valid[key] === false) return label + ' returned an unreadable response.';
      return label + (status === 401 || status === 403 ? ' not available to you' : ' unavailable right now') + ' (HTTP ' + (status || 'network') + ').';
    }).join(' ');
    var label = selected.length === 1 ? names[selected[0]] || 'Work' : 'Work';
    var refused = failed.every(function (key) { return sources[sourceKey(key)] === 401 || sources[sourceKey(key)] === 403; });
    var unavailable = selected.length === 1 && (selected[0] === 'tickets' || selected[0] === 'tasks') ? ' are not available to you.' : ' is not available to you.';
    var message = selected.length === 1 && selected[0] === 'overview' && snap.overviewRosterOmitted ? 'Assistant status is not provided to this session.'
      : partial ? (selected.length === 1 && selected[0] === 'overviewCalendar' ? 'Only readable calendar events are shown.' : 'Only loaded work is shown.')
      : label + (refused ? unavailable : ' could not be loaded.');
    return { kind: partial ? 'partial' : 'unavailable', complete: false, message: message, detail: detail };
  }

  /**
   * @description Validate list identity before normalization; malformed rows never become invented work or zero counts.
   * @param {object} response Existing JSON read receipt.
   * @param {string} key Expected list field.
   * @returns {boolean} Whether all rows provide the owning API's minimal identity/status shape.
   */
  function readableRows(response, key) {
    return Boolean(response.ok && response.body && Array.isArray(response.body[key]) && response.body[key].every(function (row) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
      var identity = key === 'bots' ? row.agentId : key === 'tickets' ? row.ticketId : row.id;
      return typeof identity === 'string' && Boolean(identity.trim()) && (key !== 'bots' || typeof row.online === 'boolean');
    }));
  }

  /** @description A JSON object, excluding lists and null; personal fields are validated independently. */
  function record(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }

  /** @description Read only the existing caller-bound overview contract; an explicitly malformed roster refuses every derived fact.
   * @param {object} response The single overview HTTP receipt. @returns {object} Validated fields and their completeness. */
  function personalOverview(response) {
    var body = response.body, roster = readableRows(response, 'bots');
    var hasRoster = record(body) && Object.prototype.hasOwnProperty.call(body, 'bots');
    var allowed = response.ok && record(body) && (!hasRoster || roster);
    var ov = allowed ? body : {}, comms = ov.comms, activity = ov.activity, calendar = ov.calendar;
    var textOrNull = function (value) { return value === null || typeof value === 'string'; };
    var commsReadable = record(comms) && (comms.digest === null || (record(comms.digest) && typeof comms.digest.summary === 'string' && typeof comms.digest.updatedAt === 'string' && Boolean(parseDate(comms.digest.updatedAt))))
      && Array.isArray(comms.signals) && comms.signals.every(function (row) { return record(row) && textOrNull(row.from) && textOrNull(row.subject) && textOrNull(row.snippet) && typeof row.at === 'string' && Boolean(parseDate(row.at)); });
    var activityReadable = record(activity) && Number.isInteger(activity.openCount) && activity.openCount >= 0 && Array.isArray(activity.tickets)
      && activity.tickets.every(function (row) { return record(row) && typeof row.id === 'string' && Boolean(row.id.trim()) && typeof row.title === 'string' && typeof row.status === 'string'; });
    var calendarList = record(calendar) && Array.isArray(calendar.events);
    var events = calendarList ? calendar.events.filter(function (row) { return record(row) && typeof row.title === 'string' && Boolean(row.title.trim()) && typeof row.when === 'string' && Boolean(parseDate(row.when)); }) : [];
    var calendarReadable = calendarList && events.length === calendar.events.length;
    return { roster: roster, bots: roster ? body.bots : [], comms: commsReadable ? comms : null, commsReadable: Boolean(commsReadable),
      activity: activityReadable ? activity : null, events: events, calendarReadable: Boolean(calendarReadable), calendarPartial: events.length > 0 && !calendarReadable,
      rosterOmitted: Boolean(allowed && !hasRoster && (commsReadable || activityReadable || calendarList)) };
  }

  /** @description Build the adapter over an injectable fetch and storage so tests can drive it headlessly. */
  function createClient(options) {
    var opts = options || {};
    var fetchImpl = opts.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    var storage = opts.storage || (typeof localStorage !== 'undefined' ? localStorage : { getItem: function () { return null; }, setItem: function () {} });
    var snapshot = null, summaryCache = new Map();

    async function getJson(path, extra) {
      var timeoutMs = extra && extra.timeoutMs ? extra.timeoutMs : 12000;
      var outer = extra && extra.signal ? extra.signal : null;
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
      var relay = function () { if (controller) controller.abort(); };
      if (outer) { if (outer.aborted) relay(); else outer.addEventListener('abort', relay); }
      try {
        var res = await fetchImpl(path, { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: controller ? controller.signal : undefined });
        var body = null; try { body = await res.json(); } catch (_) { body = null; }
        return { ok: res.ok, status: res.status, body: body };
      } catch (err) { return { ok: false, status: 0, body: null, error: err }; }
      finally { if (timer) clearTimeout(timer); if (outer) outer.removeEventListener('abort', relay); }
    }
    async function sendJson(path, method, payload, extra) {
      try {
        var res = await fetchImpl(path, { method: method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload), signal: extra && extra.signal ? extra.signal : undefined });
        var body = null; try { body = await res.json(); } catch (_) { body = null; }
        return { ok: res.ok, status: res.status, body: body };
      } catch (err) { return { ok: false, status: 0, body: null, error: err }; }
    }
    function list(res, key) { return res.ok && res.body && Array.isArray(res.body[key]) ? res.body[key] : []; }

    function missing(sources, validity) { return Object.keys(sources).filter(function (k) { return sources[k] !== 200 || validity && validity[k] === false; }); }
    /** @description Phase one: the signed-in identity and the caller's catalog, enough to paint a home; a failed source is reported, never faked. */
    async function loadCore() {
      var results = await Promise.all([getJson('/api/auth/user'), getJson('/api/swarm/apps/home-plan'), getJson('/api/swarm/apps?status=active'), getJson('/api/ui/workspaces')]);
      var auth = results[0], plan = results[1], apps = results[2], ws = results[3];
      var catalog = mergeApps({ plan: list(plan, 'apps'), apps: list(apps, 'apps'), workspaces: list(ws, 'workspaces') });
      snapshot = {
        me: deriveIdentity(auth.body), apps: catalog, suites: buildSuites(catalog), work: [], bots: [], botsOnline: 0, openTickets: 0, comms: null, calendarEvents: [],
        sources: { auth: auth.status, plan: plan.status, apps: apps.status, workspaces: ws.status }, loadedAt: new Date(), unavailable: [], workLoaded: false
      };
      snapshot.unavailable = missing(snapshot.sources);
      return snapshot;
    }
    /** @description Phase two: recent work, Jarvis tasks and the swarm overview, merged INTO the same snapshot (same arrays) so a shell that already painted sees them on its next render. */
    async function loadWork(snap) {
      var results = await Promise.all([getJson('/api/jarvis/tasks'), getJson('/api/tickets?limit=100'), getJson('/api/jarvis/overview')]);
      var tasks = results[0], tickets = results[1], overview = results[2];
      var taskReadable = readableRows(tasks, 'tasks'), ticketReadable = readableRows(tickets, 'tickets'), personal = personalOverview(overview);
      var work = mergeWork({ tickets: ticketReadable ? tickets.body.tickets : [], tasks: taskReadable ? tasks.body.tasks : [] }, snap.apps);
      var bots = personal.bots;
      snap.work.length = 0; Array.prototype.push.apply(snap.work, work);
      snap.bots.length = 0; Array.prototype.push.apply(snap.bots, bots);
      snap.botsOnline = bots.filter(function (b) { return b.online; }).length;
      var openFromWork = work.filter(function (w) { return w.kind === 'ticket' && w.status.open; }).length;
      snap.openTickets = personal.activity ? personal.activity.openCount : openFromWork;
      snap.comms = personal.comms; snap.calendarEvents = personal.events;
      snap.sources.tasks = tasks.status; snap.sources.tickets = tickets.status; snap.sources.overview = overview.status;
      snap.sourceValidity = { tasks: taskReadable, tickets: ticketReadable, overview: personal.roster, overviewCalendar: personal.calendarReadable, overviewComms: personal.commsReadable };
      snap.sourcePartial = { overviewCalendar: personal.calendarPartial }; snap.overviewRosterOmitted = personal.rosterOmitted;
      snap.unavailable = missing(snap.sources, snap.sourceValidity); snap.workLoaded = true; snap.loadedAt = new Date();
      return snap;
    }
    /** @description Load everything the shells share: both phases, in order. */
    async function load() { return loadWork(await loadCore()); }

    /** @description Ask the app's own home-summary probes in the viewer's session; cached briefly per app. */
    async function probeSummary(app) {
      if (!app || !app.probes.length) return { tiles: [], items: [], ok: false, none: true, status: 0, error: '', partial: false, asOf: '' };
      var cached = summaryCache.get(app.id);
      if (cached && Date.now() - cached.at < 60000) return cached.value;
      var responses = await Promise.all(app.probes.map(function (probe) { return getJson(probe.path, { timeoutMs: 8000 }).then(function (r) { return { probe: probe, res: r }; }); }));
      var first = responses[0] ? responses[0].res : null;
      // The first probe's refusal code travels with its status, so a shell can tell "not admitted" from "not set up yet".
      var out = { tiles: [], items: [], ok: false, none: false, status: first ? first.status : 0, error: first && !first.ok && first.body && typeof first.body.error === 'string' ? first.body.error : '', partial: false, asOf: '' };
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
        visual: d.visual || null, brainFallback: d.brainFallback || null, taskId: d.taskId || '', label: d.label || '', jobId: jobId, sessionId: session,
        dispatched: dispatchedList(d.dispatched), packageToolProposal: d.packageToolProposal && typeof d.packageToolProposal === 'object' ? d.packageToolProposal : null
      };
    }
    function abortedAsk(jobId, session) { return { status: 'aborted', error: 'Stopped waiting.', jobId: jobId || '', sessionId: session }; }

    /** @description POST the turn, rolling a refused persisted thread to a fresh id once; returns the final response and the session it went out on. */
    async function postAsk(text, c, onPhase, signal) {
      var session = c.sessionId || sessionId();
      onPhase({ phase: 'sending', sessionId: session });
      var payload = { message: text, sessionId: session };
      var r = await sendJson('/api/jarvis/ask', 'POST', payload, { signal: signal });
      if (r.status === 404 && r.body && r.body.error === 'session_not_found' && !c.sessionId && !(signal && signal.aborted)) {
        session = rollSession(); payload.sessionId = session; onPhase({ phase: 'rolled', sessionId: session });
        r = await sendJson('/api/jarvis/ask', 'POST', payload, { signal: signal });
      }
      return { r: r, session: session };
    }

    /** @description POST /api/jarvis/ask and poll /ask/result to a terminal state. Mirrors the Jarvis page: a refused persisted thread rolls to a fresh id once. `config.signal` ends the wait at any point with status 'aborted'; the job itself is not cancelled (no such route exists). */
    async function ask(message, config) {
      var c = config || {}, onPhase = c.onPhase || function () {}, sleep = c.sleep || abortableSleep, signal = c.signal || null;
      var stopped = function () { return Boolean(signal && signal.aborted); };
      var text = String(message || '').trim();
      if (!text) return { status: 'error', error: 'Say what you need first.' };
      var sent = await postAsk(text, c, onPhase, signal), r = sent.r, session = sent.session;
      if (stopped()) return abortedAsk('', session);
      if (!r.ok || !r.body || !r.body.jobId) {
        var reason = r.status === 0 ? 'The swarm could not be reached.' : (r.body && (r.body.message || r.body.error)) ? String(r.body.message || r.body.error) : 'HTTP ' + r.status;
        return { status: 'error', error: reason, httpStatus: r.status, code: r.body && typeof r.body.code === 'string' ? r.body.code : '', sessionId: session };
      }
      var jobId = r.body.jobId;
      onPhase({ phase: 'accepted', jobId: jobId, sessionId: session });
      var maxPolls = c.maxPolls || 200, pollMs = c.pollMs || 1500;
      for (var i = 0; i < maxPolls; i++) {
        if (stopped()) return abortedAsk(jobId, session);
        var p = await getJson('/api/jarvis/ask/result?jobId=' + encodeURIComponent(jobId), { signal: signal });
        if (stopped()) return abortedAsk(jobId, session);
        var d = p.ok && p.body ? p.body : null;
        if (d && d.status && d.status !== 'pending') return finishAsk(d, jobId, session);
        onPhase({ phase: 'waiting', jobId: jobId, sessionId: session, poll: i + 1 });
        await sleep(pollMs, signal);
      }
      if (stopped()) return abortedAsk(jobId, session);
      return { status: 'error', code: 'poll_limit', error: 'This is taking unusually long. It may still finish; check Jarvis later.', jobId: jobId, sessionId: session };
    }

    /**
     * @description Send one recorded clip to the swarm's speech-to-text route (POST /api/voice/transcribe, multipart field `audio`) and fold the route's envelope ({ success, data: { text } | { fallback, message } }) into one outcome the page can say honestly: 'text', 'unconfigured' (no server recognizer; the route's 'browser' fallback means the deployment chose in-browser recognition), 'empty' (the server heard no words) or 'failed'.
     * @param {Blob} blob The recording, typed with a base audio MIME type the route accepts.
     * @param {{filename?: string, signal?: AbortSignal}} [config] Upload name and optional abort signal.
     * @returns {Promise<{outcome: string, status: number, text: string, fallback: string}>} The outcome; the text is never sent anywhere by this helper.
     */
    async function transcribe(blob, config) {
      var c = config || {}, res, body = null;
      var form = new FormData(); form.append('audio', blob, c.filename || 'speech.webm');
      try { res = await fetchImpl('/api/voice/transcribe', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' }, body: form, signal: c.signal }); }
      catch (_) { return { outcome: 'failed', status: 0, text: '', fallback: '' }; }
      try { body = await res.json(); } catch (_) { body = null; }
      var d = body && body.data && typeof body.data === 'object' ? body.data : {};
      var text = typeof d.text === 'string' ? d.text.trim() : '';
      if (res.ok && text) return { outcome: 'text', status: res.status, text: text, fallback: '' };
      if (res.ok && (d.fallback === 'unconfigured' || d.fallback === 'browser')) return { outcome: 'unconfigured', status: res.status, text: '', fallback: d.fallback };
      if (res.ok && !d.fallback) return { outcome: 'empty', status: res.status, text: '', fallback: '' };
      return { outcome: 'failed', status: res.status, text: '', fallback: typeof d.fallback === 'string' ? d.fallback : '' };
    }

    /** @description Speak text through the swarm's voice route, falling back to the browser engine. Level callbacks are amplitude when an analyser is available, lifecycle pulses otherwise. */
    function speak(text, hooks) {
      var h = hooks || {}, onLevel = h.onLevel || function () {}, onStart = h.onStart || function () {}, onEnd = h.onEnd || function () {}, onProgress = h.onProgress || function () {};
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
        u.onboundary = function (e) { level = Math.min(1, level + 0.45); if (e && typeof e.charIndex === 'number' && text.length) onProgress(Math.min(1, Math.max(0, e.charIndex / text.length))); };
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
        // Stopped while the swarm was still answering: nothing may start from a cancelled readback.
        if (state.stopped) return undefined;
        var d = r.ok && r.body && r.body.data ? r.body.data : null;
        if (!d || !d.audioData) throw new Error('no audio');
        var fmt = String(d.format || 'wav'), mime = fmt.indexOf('/') >= 0 ? fmt : 'audio/' + fmt;
        var audio = new Audio('data:' + mime + ';base64,' + d.audioData); state.audio = audio;
        audio.onended = end; audio.onerror = end;
        audio.ontimeupdate = function () { if (!state.stopped && audio.duration > 0) onProgress(Math.min(1, audio.currentTime / audio.duration)); };
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

    function educationCalendar(month) { return getJson('/api/education/calendar' + (month ? '?month=' + encodeURIComponent(month) : '')); }
    /** The caller's Little Monsters calendar for this month and next; the first refused month names the status. */
    async function educationAgenda(now) {
      var d = now || new Date(), next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      var reads = await Promise.all([educationCalendar(monthKey(d)), educationCalendar(monthKey(next))]);
      var refused = reads.filter(function (r) { return !r.ok; })[0];
      return { ok: !refused, status: (refused || reads[0]).status, events: classEvents(reads) };
    }

    var packages = {
      education: {
        me: function () { return getJson('/api/education/me'); },
        classes: function () { return getJson('/api/education/classes'); },
        students: function (id) { return getJson('/api/education/classes/' + encodeURIComponent(id) + '/students'); },
        assignments: function () { return getJson('/api/education/assignments'); },
        calendar: educationCalendar,
        agenda: educationAgenda,
        addEvent: function (payload) { return sendJson('/api/education/calendar', 'POST', payload); },
        /**
         * @description One class's learner activity (level, streak, quiz average, cards reviewed) and class summary, the teacher-only analytics read. It is activity, never classwork completion.
         * @param {string} id Little Monsters class id the caller teaches.
         * @returns {Promise<{ok:boolean,status:number,body:any}>} The package's answer; 403/404 when the caller does not teach the class.
         */
        analytics: function (id) { return getJson('/api/education/teacher/classes/' + encodeURIComponent(id) + '/analytics'); },
        /**
         * @description Post classwork through the package route that also puts a dated item on the class calendar, so the shell never writes two records itself.
         * @param {{classId:string,title:string,assignmentType?:string,dueDate?:string,description?:string}} payload Body the package validates and authorizes.
         * @returns {Promise<{ok:boolean,status:number,body:any}>} 201 with assignmentId/eventId, or the package's refusal.
         */
        addClasswork: function (payload) { return sendJson('/api/education/assignments-with-events', 'POST', payload); }
      },
      tickets: {
        /**
         * @description Read one ticket as the ticket route answers it (current status plus the reason/nextAction mirror in metadata); the route refuses non-owners with 404.
         * @param {string} id Ticket id.
         * @returns {Promise<{ok:boolean,status:number,body:any}>} The ticket or the route's refusal.
         */
        get: function (id) { return getJson('/api/tickets/' + encodeURIComponent(id)); },
        /**
         * @description Ask the ticket route for one exact state transition; the server enforces ownership and the transition table, the shell only names the state.
         * @param {string} id Ticket id.
         * @param {string} status Canonical next state.
         * @returns {Promise<{ok:boolean,status:number,body:any}>} The route's answer, including its refusal.
         */
        setStatus: function (id, status) { return sendJson('/api/tickets/' + encodeURIComponent(id) + '/status', 'PUT', { status: status }); },
        /**
         * @description One ticket's owner- and application-scoped workflow read model: the registered definition (not a run snapshot), the latest owner-matched run, status history, approval-gate receipts and child tickets.
         * @param {string} id Ticket id.
         * @returns {Promise<{ok:boolean,status:number,body:any}>} The projection, or 404 when the caller may not read the ticket.
         */
        workflow: function (id) { return getJson('/api/v1/tickets/' + encodeURIComponent(id) + '/workflow'); },
        /**
         * @description Ask the ticket route to cancel work the caller owns; the route checks ownership and refuses otherwise.
         * @param {string} id Ticket id.
         * @returns {Promise<{ok:boolean,status:number,body:any}>} The route's answer, including a refusal.
         */
        cancel: function (id) { return sendJson('/api/tickets/' + encodeURIComponent(id) + '/cancel', 'PUT'); }
      },
      routines: {
        /**
         * @description The caller's schedules (owner-scoped by the route; unowned system schedules stay visible to everyone).
         * @returns {Promise<{ok:boolean,status:number,body:any}>} { schedules } or the route's refusal.
         */
        list: function () { return getJson('/api/v1/agent/schedules'); },
        /**
         * @description Pause or resume one schedule; the route refuses a schedule the caller does not own (404), one an application manifest manages, and a workflow schedule for a non-operator (403).
         * @param {string} id Schedule id.
         * @param {boolean} on True resumes, false pauses.
         * @returns {Promise<{ok:boolean,status:number,body:any}>} { schedule } or the refusal.
         */
        setOn: function (id, on) { return sendJson('/api/v1/agent/schedules/' + encodeURIComponent(id) + (on ? '/resume' : '/pause'), 'POST'); }
      },
      /** Workflow Studio definitions (name, version, node count); editing, publishing and restoring stay in Workflow Studio. */
      workflows: function () { return getJson('/api/workflow-studio/definitions'); },
      /** The households and teams the caller belongs to, with their role (GET /api/tenants). */
      tenants: function () { return getJson('/api/tenants'); },
      /** Members of one tenant (subject and role); the route answers members only (403 otherwise). */
      tenantMembers: function (id) { return getJson('/api/tenants/' + encodeURIComponent(id) + '/members'); },
      /** The caller's own location overview (ADR-169 L3: settings, devices, current place, who can see them; no coordinates). */
      locationState: function () { return getJson('/api/location/state'); },
      content: {
        /**
         * @description The caller's saved content drafts (topic, take, draft, created_at), newest first; the route reads only the caller's own rows.
         * @returns {Promise<{ok:boolean,status:number,body:any}>} The drafts list or the route's refusal.
         */
        drafts: function () { return getJson('/api/content/drafts'); }
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
        tasks: function () { return getJson('/api/jarvis/tasks'); },
        /**
         * @description Ask the ticket route to cancel background work the caller started; the route checks ownership and refuses otherwise.
         * @param {string} ticketId Ticket behind the dispatched item.
         * @returns {Promise<{ok:boolean,status:number,body:any}>} The route's answer, including a refusal.
         */
        cancelWork: function (ticketId) { return sendJson('/api/tickets/' + encodeURIComponent(ticketId) + '/cancel', 'PUT'); }
      },
      directory: function () { return getJson('/api/user-directory'); },
      /** The swarm roster as display rows (swarm admins only; anyone else gets the route's refusal status). */
      people: function (selfSub) { return getJson('/api/user-directory').then(function (r) { return directoryPeople(r, selfSub); }); },
      /** The caller-scoped ribbon profile of one application: the admitted surfaces the cockpit ribbon itself renders. */
      profile: function (name) { return getJson('/api/ui/profile?name=' + encodeURIComponent(name)); },
      /** One application's record as this viewer may see it (404 when it is not visible): manifest bots, chatBot, dependencies. */
      appDetail: function (name) { return getJson('/api/swarm/apps/' + encodeURIComponent(name)); }
    };

    return {
      load: load, loadCore: loadCore, loadWork: loadWork, get snapshot() { return snapshot; }, probeSummary: probeSummary, ask: ask, speak: speak, transcribe: transcribe,
      sessionId: sessionId, rollSession: rollSession, prefs: prefs, packages: packages, getJson: getJson, sendJson: sendJson
    };
  }

  var api = {
    SUITE_META: SUITE_META, SUITE_ORDER: SUITE_ORDER, STATUS_GROUPS: STATUS_GROUPS, statusOf: statusOf, initials: initials, deriveIdentity: deriveIdentity,
    mergeApps: mergeApps, buildSuites: buildSuites, mergeWork: mergeWork, normalizeTicket: normalizeTicket, normalizeTask: normalizeTask,
    atPointer: atPointer, normalizeSummary: normalizeSummary, relativeTime: relativeTime, clockTime: clockTime, parseDate: parseDate,
    calendarDay: calendarDay, littleMonstersRefusal: littleMonstersRefusal, dependencyTiers: dependencyTiers, declaredAssistants: declaredAssistants, directoryPeople: directoryPeople, classEvents: classEvents,
    localHref: localHref, createClient: createClient, sourceState: sourceState
  };
  if (typeof window !== 'undefined' && typeof fetch === 'function') {
    var client = createClient();
    Object.keys(client).forEach(function (k) {
      if (!(k in api)) Object.defineProperty(api, k, { get: function () { return client[k]; }, enumerable: true });
    });
    api.readyCore = client.loadCore();
    api.ready = api.readyCore.then(client.loadWork);
  }
  return api;
});
