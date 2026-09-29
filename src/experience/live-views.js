/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Pure readers the full-swarm layouts and the portal share over existing routes: the device-local day focus (workday / evening at home) that orders work and suites without hiding any, the caller's routines (GET /api/v1/agent/schedules) with their cadence and whether this viewer may switch them, household and team membership (GET /api/tenants and /:id/members), the caller's own place (GET /api/location/state, ADR-169: a place name and its age, never a coordinate), one ticket's workflow progress (GET /api/v1/tickets/:id/workflow) and monthly spend bars from the Finance package's summary. Each reader keeps the route's refusal as a status and invents nothing in its place.
 */
(function attach(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.OSHAL_LIVE_VIEWS = api;
})(typeof window !== 'undefined' ? window : globalThis, function build() {
  'use strict';

  /**
   * The two day focuses. A focus orders work and suites (its own suites first) and changes the copy; it never hides
   * an application or a work item and is never sent to a server (ADR-164 D9: a device-local preference).
   */
  var SCENES = {
    workday: { id: 'workday', label: 'A workday', suites: ['ai-finance', 'ai-engineering', 'ai-productivity', 'ai-knowledge', 'platform'] },
    evening: { id: 'evening', label: 'An evening at home', suites: ['ai-home', 'ai-creative'] }
  };

  /**
   * @description The focus a saved preference names; anything unknown is the workday focus.
   * @param {unknown} id The saved focus id.
   * @returns {{id: string, label: string, suites: string[]}} The focus.
   */
  function sceneOf(id) { return Object.prototype.hasOwnProperty.call(SCENES, id) ? SCENES[id] : SCENES.workday; }

  /**
   * @description Order items with the focus's suites first, keeping each group's existing order (newest first stays
   * newest first). An item with no suite (a general Jarvis task) belongs to every focus.
   * @param {Array} items The items, already in their base order.
   * @param {string} sceneId The focus id.
   * @param {(item: any) => string|null} suiteOfItem The item's suite id, or null.
   * @returns {Array} A new array; the input is untouched.
   */
  function sceneOrder(items, sceneId, suiteOfItem) {
    var suites = sceneOf(sceneId).suites;
    var rank = function (item) { var s = suiteOfItem(item); return !s || suites.indexOf(s) >= 0 ? 0 : 1; };
    return (items || []).map(function (item, i) { return { item: item, i: i, r: rank(item) }; })
      .sort(function (a, b) { return a.r - b.r || a.i - b.i; }).map(function (x) { return x.item; });
  }

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var isNum = function (v) { return /^\d+$/.test(v); };

  /** @description Plain words for the common five-field cron shapes the scheduler stores; anything else is shown as written. */
  function cronWords(cron) {
    var p = String(cron || '').trim().split(/\s+/);
    if (p.length !== 5) return 'Schedule ' + String(cron || '').trim();
    var m = p[0], h = p[1], dom = p[2], mon = p[3], dow = p[4], at = isNum(m) && isNum(h) ? pad(h) + ':' + pad(m) : '';
    if (/^\*\/\d+$/.test(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every ' + m.slice(2) + ' minutes';
    if (isNum(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every hour at :' + pad(m);
    if (!at || mon !== '*') return 'Schedule ' + p.join(' ');
    if (dom === '*' && dow === '*') return 'Every day at ' + at;
    if (dom === '*' && dow === '1-5') return 'Weekdays at ' + at;
    if (dom === '*' && (dow === '0,6' || dow === '6,0')) return 'Weekends at ' + at;
    if (dom === '*' && /^[0-7]$/.test(dow)) return 'Every ' + DAYS[Number(dow) % 7] + ' at ' + at;
    if (isNum(dom) && dow === '*') return 'Monthly on day ' + dom + ' at ' + at;
    return 'Schedule ' + p.join(' ');
  }

  /**
   * @description A schedule's cadence in words: the cron shape, its timezone when one is stored, and "Once" for a
   * one-shot schedule (it fires the next matching time, then pauses).
   * @param {{cron: string, timezone?: string|null, once?: boolean}} s The schedule record.
   * @returns {string} The cadence line.
   */
  function cadence(s) {
    var words = cronWords(s && s.cron);
    var zone = s && typeof s.timezone === 'string' && s.timezone ? ' (' + s.timezone + ')' : '';
    return (s && s.once ? 'Once · ' : '') + words + zone;
  }

  function dateOrNull(v) { if (!v) return null; var d = new Date(v); return isNaN(d.getTime()) ? null : d; }

  /**
   * @description One routine as the Routines panel shows it. Manifest-owned schedules (task type app: or app-route:,
   * or a service-route task) are switched by activating their application, and workflow: schedules are operator-only,
   * so only the caller's own prompt schedules offer a switch; the route still decides (it refuses non-owners with 404).
   * @param {object} s A schedule record from GET /api/v1/agent/schedules.
   * @returns {{id: string, title: string, taskType: string, cadence: string, on: boolean, next: Date|null, last: Date|null, runs: number, managed: string, queue: string, switchable: boolean}}
   */
  function routineView(s) {
    var taskType = String(s && s.taskType || ''), data = s && s.taskData && typeof s.taskData === 'object' ? s.taskData : {};
    var prompt = typeof data.prompt === 'string' ? data.prompt.replace(/\s+/g, ' ').trim() : '';
    var managed = /^app(-route)?:/.test(taskType) || data.kind === 'manifest-service-route' ? 'app' : /^workflow:/.test(taskType) ? 'workflow' : '';
    return {
      id: String(s && s.id || ''), title: prompt ? (prompt.length > 110 ? prompt.slice(0, 110) + '…' : prompt) : taskType || 'Routine',
      taskType: taskType, cadence: cadence(s), on: Boolean(s) && s.status === 'active', next: dateOrNull(s && s.nextRunAt), last: dateOrNull(s && s.lastRunAt),
      runs: Number(s && s.executionCount || 0), managed: managed, queue: s && typeof s.queue === 'string' ? s.queue : '', switchable: managed === ''
    };
  }

  /**
   * @description The caller's routines from the schedules read, keeping its status when refused.
   * @param {{ok: boolean, status: number, body: any}} res GET /api/v1/agent/schedules.
   * @returns {{ok: boolean, status: number, routines: Array}} Routines, active ones first, then by next run.
   */
  function routinesView(res) {
    var list = res && res.ok && res.body && Array.isArray(res.body.schedules) ? res.body.schedules : [];
    var routines = list.filter(function (s) { return s && s.id; }).map(routineView).sort(function (a, b) {
      return Number(b.on) - Number(a.on) || (a.next ? a.next.getTime() : Infinity) - (b.next ? b.next.getTime() : Infinity);
    });
    return { ok: Boolean(res && res.ok), status: res ? res.status : 0, routines: routines };
  }

  /**
   * @description Workflow Studio definitions as a short list (name, version, size, last change); Workflow Studio stays
   * where they are edited, published and restored.
   * @param {{ok: boolean, status: number, body: any}} res GET /api/workflow-studio/definitions.
   * @returns {{ok: boolean, status: number, workflows: Array<{id: string, name: string, description: string, version: number, nodeCount: number, updatedAt: Date|null}>}}
   */
  function workflowsView(res) {
    var list = res && res.ok && res.body && Array.isArray(res.body.definitions) ? res.body.definitions : [];
    return { ok: Boolean(res && res.ok), status: res ? res.status : 0, workflows: list.filter(function (d) { return d && d.id; }).map(function (d) {
      return { id: String(d.id), name: String(d.name || 'Untitled workflow'), description: String(d.description || ''), version: Number(d.version || 1), nodeCount: Number(d.nodeCount || 0), updatedAt: dateOrNull(d.updatedAt) };
    }) };
  }

  /**
   * @description The household or team a shared layout names: an organisation first, otherwise the first household.
   * @param {Array<{id: string, kind: string}>} tenants The caller's memberships.
   * @returns {object|null} The chosen tenant, or null when the caller belongs to none.
   */
  function primaryTenant(tenants) {
    var list = Array.isArray(tenants) ? tenants : [];
    return list.filter(function (t) { return t.kind === 'org'; })[0] || list[0] || null;
  }

  /**
   * @description Membership as the caller may read it: their households and teams, and the members of the chosen one
   * (subject and role only; the route publishes no names). A refused read keeps its status.
   * @param {{ok: boolean, status: number, body: any}} tenantsRes GET /api/tenants.
   * @param {{ok: boolean, status: number, body: any}|null} membersRes GET /api/tenants/:id/members for the chosen tenant, or null when none was read.
   * @param {string} selfSub The caller's subject.
   * @returns {{ok: boolean, status: number, tenants: Array, tenant: object|null, members: Array<{sub: string, role: string, self: boolean}>, membersStatus: number}}
   */
  function membershipView(tenantsRes, membersRes, selfSub) {
    var raw = tenantsRes && tenantsRes.ok && tenantsRes.body && Array.isArray(tenantsRes.body.tenants) ? tenantsRes.body.tenants : [];
    var tenants = raw.filter(function (t) { return t && t.tenant_id; }).map(function (t) {
      return { id: String(t.tenant_id), name: String(t.name || 'Unnamed group'), kind: t.kind === 'org' ? 'org' : 'space', role: String(t.role || 'member') };
    });
    var members = membersRes && membersRes.ok && membersRes.body && Array.isArray(membersRes.body.members) ? membersRes.body.members : [];
    return {
      ok: Boolean(tenantsRes && tenantsRes.ok), status: tenantsRes ? tenantsRes.status : 0, tenants: tenants, tenant: primaryTenant(tenants),
      members: members.filter(function (m) { return m && m.user_sub; }).map(function (m) { return { sub: String(m.user_sub), role: String(m.role || 'member'), self: Boolean(selfSub) && m.user_sub === selfSub }; }),
      membersStatus: membersRes ? membersRes.status : 0
    };
  }

  function ageWords(seconds) {
    var s = Math.max(0, Number(seconds) || 0);
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }

  /**
   * @description The caller's own place from their location overview: the named place their latest fix fell in and
   * its age, whether reporting is on, or the refusal. No coordinate is read or shown (ADR-169: GET /state carries none).
   * @param {{ok: boolean, status: number, body: any}} res GET /api/location/state.
   * @returns {{state: string, text: string, status: number}} state is at | located | sharing | off | refused.
   */
  function placeView(res) {
    if (!res || !res.ok || !res.body) return { state: 'refused', status: res ? res.status : 0, text: 'Location is not available to this session (HTTP ' + (res && res.status || 'unreachable') + ')' };
    var cur = res.body.current, devices = Array.isArray(res.body.devices) ? res.body.devices : [];
    if (cur && cur.place && cur.place.name) return { state: 'at', status: res.status, text: 'At ' + cur.place.name + ' · ' + ageWords(cur.ageSeconds) };
    if (cur) return { state: 'located', status: res.status, text: 'Sharing on · not at a saved place · ' + ageWords(cur.ageSeconds) };
    if (devices.some(function (d) { return d && d.reportingEnabled; })) return { state: 'sharing', status: res.status, text: 'Location sharing on · no recent place' };
    return { state: 'off', status: res.status, text: 'Location sharing is off' };
  }

  var STEP_STATE = { completed: 'done', terminal: 'done', jump: 'done', skipped: 'skipped', suspended: 'waiting', escalated: 'failed', error: 'failed' };

  /** @description The stages of a workflow payload: the registered definition's nodes with their run step state, or the run's own steps. */
  function stagesOf(body) {
    var steps = body.run && Array.isArray(body.run.steps) ? body.run.steps : [];
    var byNode = {};
    steps.forEach(function (s) { if (s && s.nodeId) byNode[s.nodeId] = STEP_STATE[String(s.status)] || 'running'; });
    var nodes = body.definition && Array.isArray(body.definition.nodes) ? body.definition.nodes : [];
    if (nodes.length) return nodes.map(function (n) { return { id: String(n.id), title: String(n.title || n.type || 'Step'), type: String(n.type || ''), state: byNode[n.id] || 'pending' }; });
    return steps.map(function (s) { return { id: String(s.nodeId), title: String(s.nodeTitle || s.nodeType || 'Step'), type: String(s.nodeType || ''), state: STEP_STATE[String(s.status)] || 'running' }; });
  }

  /**
   * @description One ticket's workflow as the work panel shows it: stages with their state, progress only when a run is
   * recorded (finished stages over all stages), the approval gates, the last status changes and the child tickets.
   * The definition is the currently registered one, never a snapshot of the run (the route says so).
   * @param {{ok: boolean, status: number, body: any}} res GET /api/v1/tickets/:ticketId/workflow.
   * @returns {object} ok/status, name, stages, progress (null without a run), current stage, gates, history, children, and the unavailable flags.
   */
  function workflowView(res) {
    if (!res || !res.ok || !res.body) return { ok: false, status: res ? res.status : 0 };
    var b = res.body, stages = stagesOf(b), hasRun = Boolean(b.run);
    var finished = stages.filter(function (s) { return s.state === 'done' || s.state === 'skipped'; }).length;
    var current = stages.filter(function (s) { return s.state === 'waiting' || s.state === 'running' || s.state === 'failed'; })[0] || (hasRun ? stages.filter(function (s) { return s.state === 'pending'; })[0] : null) || null;
    return {
      ok: true, status: res.status, name: b.definition ? String(b.definition.name || '') : b.run ? String(b.run.workflowName || '') : '',
      stages: stages, progress: hasRun && stages.length ? { done: finished, total: stages.length, pct: Math.round(finished / stages.length * 100) } : null, current: current,
      runStatus: b.run ? String(b.run.status || '') : '', gates: Array.isArray(b.approvalGates) ? b.approvalGates : [],
      history: (Array.isArray(b.history) ? b.history : []).slice(0, 4), children: Array.isArray(b.children) ? b.children : [],
      historyAvailable: b.historyAvailable !== false, runHistoryAvailable: b.runHistoryAvailable !== false, childrenAvailable: b.childrenAvailable !== false
    };
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /**
   * @description Monthly spend bars from the Finance package's own summary (the caller's synced accounts, read in
   * their session): the last seven months, each as a share of the largest. 404 means nothing is synced yet.
   * @param {{ok: boolean, status: number, body: any}} res GET /api/finance/summary.
   * @returns {{state: string, status: number, bars: Array<{label: string, value: number, pct: number}>, syncedAt: Date|null}} state is ready | empty | no-data | failed.
   */
  function spendBars(res) {
    if (!res || !res.ok || !res.body) return { state: res && res.status === 404 ? 'no-data' : 'failed', status: res ? res.status : 0, bars: [], syncedAt: null };
    var months = res.body.aggregate && Array.isArray(res.body.aggregate.spendByMonth) ? res.body.aggregate.spendByMonth : [];
    var rows = months.filter(function (m) { return m && typeof m.month === 'string' && Number.isFinite(Number(m.spend)); }).slice(-7);
    var max = rows.reduce(function (n, m) { return Math.max(n, Math.abs(Number(m.spend))); }, 0);
    var bars = rows.map(function (m) {
      var month = Number(m.month.slice(5, 7)), value = Math.abs(Number(m.spend));
      return { label: MONTHS[month - 1] || m.month, value: value, pct: max ? Math.max(4, Math.round(value / max * 100)) : 0 };
    });
    return { state: bars.length ? 'ready' : 'empty', status: res.status, bars: bars, syncedAt: dateOrNull(res.body.syncedAt) };
  }

  return {
    SCENES: SCENES, sceneOf: sceneOf, sceneOrder: sceneOrder, cadence: cadence, routineView: routineView, routinesView: routinesView,
    workflowsView: workflowsView, primaryTenant: primaryTenant, membershipView: membershipView, placeView: placeView, workflowView: workflowView, spendBars: spendBars
  };
});
