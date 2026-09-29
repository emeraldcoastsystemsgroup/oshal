/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The homebase's own data seam for the sources the shared live-data adapter does not read: the caller's check-in (ADR-169 GET /api/location/state, as a place and never coordinates, with this browser's device and who can see them) and stopping a device's reporting, the caller's household or team group (GET /api/tenants and its members, names only where the swarm directory already shares them) and creating a household, a learner's own Little Monsters progress (the package's dashboard: level, XP, streak, quizzes, flashcards) and notices, Jarvis briefing sources and the caller's schedules as routines (enable, pause, resume), and the caller-scoped global search. Pure helpers (the package's level rule, cron wording, day grouping, local matching) are exported for headless tests.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HOMEBASE_DATA = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /** The key the Settings, Location page stores this browser's device id under (same origin, so the homebase can name "this browser"). */
  var DEVICE_KEY = 'oshal.location.browserDeviceId';
  var DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  var arr = function (v) { return Array.isArray(v) ? v : []; };
  var str = function (v) { return typeof v === 'string' ? v : ''; };
  var num = function (v) { var n = Number(v); return Number.isFinite(n) ? n : 0; };
  /** A refused or failed read: its status, the route's error code and its human message when it sent one. */
  function refused(r) {
    var body = r && r.body && typeof r.body === 'object' ? r.body : {};
    return { ok: false, status: r ? r.status : 0, code: str(body.error), message: str(body.message) };
  }

  /**
   * @description The person's own location state as the homebase shows it: the place their latest fix fell in (name and
   * label, never a coordinate), how old it is, their devices with this browser marked, and who can see them.
   * @param {{ok:boolean,status:number,body:any}} r The GET /api/location/state answer.
   * @param {string|null} thisDeviceId The id the Settings page stored for this browser, or null.
   * @returns {object} `{ok:false,status,code,message}` for a refusal, otherwise the normalized view.
   */
  function locationView(r, thisDeviceId) {
    if (!r || !r.ok || !r.body || typeof r.body !== 'object') return refused(r);
    var b = r.body, vis = b.visibility && typeof b.visibility === 'object' ? b.visibility : {};
    var devices = arr(b.devices).filter(function (d) { return d && d.deviceId; }).map(function (d) {
      return { id: String(d.deviceId), kind: str(d.kind), reporting: d.reportingEnabled === true, precisionClass: str(d.precisionClass), lastSeenAt: str(d.lastSeenAt), thisBrowser: d.deviceId === thisDeviceId && d.kind === 'browser' };
    });
    var active = function (list) { return arr(list).filter(function (s) { return s && s.active === true; }); };
    var cur = b.current && typeof b.current === 'object' ? b.current : null;
    return {
      ok: true, status: r.status,
      current: cur ? { place: cur.place ? { name: str(cur.place.name), label: str(cur.place.label) } : null, ageSeconds: num(cur.ageSeconds), precisionClass: str(cur.precisionClass) } : null,
      devices: devices, thisDevice: devices.filter(function (d) { return d.thisBrowser; })[0] || null,
      reporting: devices.some(function (d) { return d.reporting; }),
      memberShares: active(vis.memberShares).map(function (s) { return { id: String(s.shareId), group: str(s.groupName), places: num(s.placeCount) }; }),
      guardianShares: active(vis.guardianShares).map(function (s) { return { id: String(s.shareId), group: str(s.groupName), grantees: arr(s.grantees).length }; }),
      restrictions: arr(vis.restrictions).map(function (x) { return str(x && x.groupName); }),
      history: b.history ? num(b.history.observationCount) : 0,
      defaultPrecision: b.settings ? str(b.settings.defaultPrecisionClass) : ''
    };
  }

  /**
   * @description XP inside the current level, by Little Monsters' own level rule (100 XP to level 2, then
   * floor(100 × 1.5^(level-1)) per level). The span is returned only when the rule reproduces the level the package
   * reported, so a changed rule shows no bar rather than a wrong one.
   * @param {number} level The level the package reported.
   * @param {number} xp The learner's total XP.
   * @returns {{into:number,need:number,next:number}|null} XP earned in this level, XP the level needs, the next level.
   */
  function levelSpan(level, xp) {
    var x = Number(xp), lv = 1, start = 0, threshold = 100;
    if (!Number.isFinite(x) || x < 0) return null;
    while (x - start >= threshold) {
      start += threshold; lv += 1; threshold = Math.floor(100 * Math.pow(1.5, lv - 1));
      if (lv > 500) return null;
    }
    return lv === Number(level) ? { into: x - start, need: threshold, next: lv + 1 } : null;
  }

  /** @description The caller's group of one kind ('space' is a household, 'org' a company team); another kind is never borrowed. */
  function groupPick(tenants, kind) {
    return arr(tenants).filter(function (t) { return t && t.tenant_id && t.kind === kind; })[0] || null;
  }

  /**
   * @description Group members as display rows: the caller first, then admins, then members. A name appears only where
   * the swarm directory already shared it with this caller; nobody else's identity is guessed.
   * @param {Array<{user_sub:string,role:string}>} members The members route's rows.
   * @param {{sub:string,name:string}} self The signed-in caller.
   * @param {Array<{sub:string,label:string}>} directory Directory users the caller may see (empty when refused).
   * @returns {Array<{sub:string,role:string,self:boolean,name:string}>} The rows.
   */
  function memberRows(members, self, directory) {
    var names = new Map(arr(directory).filter(function (u) { return u && u.sub; }).map(function (u) { return [String(u.sub), String(u.label || '').replace(/\s*\([^)]*\)\s*$/, '')]; }));
    var rows = arr(members).filter(function (m) { return m && m.user_sub; }).map(function (m) {
      var sub = String(m.user_sub), mine = sub === self.sub;
      return { sub: sub, role: m.role === 'admin' ? 'admin' : 'member', self: mine, name: mine ? self.name : (names.get(sub) || '') };
    });
    var rank = function (r) { return r.self ? 0 : r.role === 'admin' ? 1 : 2; };
    return rows.sort(function (a, b) { return rank(a) - rank(b); });
  }

  var two = function (n) { return String(n).padStart(2, '0'); };
  /** A 24-hour cron hour and minute as a clock time, e.g. "8:30 AM". */
  function clock(h, m) { var hh = Number(h), mm = Number(m); return (hh % 12 || 12) + ':' + two(mm) + ' ' + (hh >= 12 ? 'PM' : 'AM'); }
  /**
   * @description A five-field cron in words for the common shapes (daily, weekdays, weekends, named weekdays, a date);
   * anything else is named as a custom schedule with its cron, never guessed at.
   * @param {string} cron The schedule's cron expression.
   * @returns {string} The wording.
   */
  function cronText(cron) {
    var f = String(cron || '').trim().split(/\s+/);
    if (f.length !== 5 || !/^\d{1,2}$/.test(f[0]) || !/^\d{1,2}$/.test(f[1])) return 'Custom schedule (' + String(cron || 'no cron') + ')';
    var at = clock(f[1], f[0]), dom = f[2], mon = f[3], dow = f[4];
    if (dom === '*' && mon === '*') {
      if (dow === '*') return 'Every day at ' + at;
      if (dow === '1-5') return 'Weekdays at ' + at;
      if (dow === '0,6' || dow === '6,0') return 'Weekends at ' + at;
      if (/^[0-7](,[0-7])*$/.test(dow)) return 'Every ' + dow.split(',').map(function (d) { return DAY_NAMES[Number(d) % 7]; }).join(', ') + ' at ' + at;
    }
    if (/^\d{1,2}$/.test(dom) && /^\d{1,2}$/.test(mon) && dow === '*') return new Date(2000, Number(mon) - 1, Number(dom)).toLocaleDateString(undefined, { month: 'long', day: 'numeric' }) + ' at ' + at;
    return 'Custom schedule (' + f.join(' ') + ')';
  }

  var isoDay = function (d) { return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()); };
  /**
   * @description Events that carry a `when` Date, grouped by the calendar day they fall on, in time order.
   * @param {Array<{when:Date}>} events Events with a parsed `when`.
   * @returns {Array<{key:string,day:Date,events:Array<object>}>} One group per day.
   */
  function dayGroups(events) {
    var groups = [];
    arr(events).filter(function (e) { return e && e.when instanceof Date && !isNaN(e.when); }).sort(function (a, b) { return a.when - b.when; }).forEach(function (e) {
      var key = isoDay(e.when), last = groups[groups.length - 1];
      if (last && last.key === key) last.events.push(e); else groups.push({ key: key, day: new Date(e.when.getFullYear(), e.when.getMonth(), e.when.getDate()), events: [e] });
    });
    return groups;
  }

  /**
   * @description Match a query against what this home already read for the caller (events, list items, classwork, tools,
   * applications, open work), case-insensitively on title and detail; nothing is fetched.
   * @param {string} q The query.
   * @param {Object<string, Array<{title:string,detail?:string,id:string}>>} pools Rows per kind.
   * @returns {Array<{kind:string,title:string,detail:string,id:string}>} Up to 30 matches, pools in order.
   */
  function localMatches(q, pools) {
    var needle = String(q || '').trim().toLocaleLowerCase();
    if (!needle) return [];
    var out = [];
    Object.keys(pools || {}).forEach(function (kind) {
      arr(pools[kind]).forEach(function (row) {
        if (!row || !row.title) return;
        var hay = (String(row.title) + ' ' + String(row.detail || '')).toLocaleLowerCase();
        if (hay.indexOf(needle) >= 0) out.push({ kind: kind, title: String(row.title), detail: String(row.detail || ''), id: String(row.id || '') });
      });
    });
    return out.slice(0, 30);
  }

  /** @description The global search answer as rows (title, snippet, kind, the route's own deep link or null), or its refusal. */
  function searchRows(r) {
    if (!r || !r.ok || !r.body || !Array.isArray(r.body.hits)) return refused(r);
    return { ok: true, status: r.status, hits: r.body.hits.filter(function (h) { return h && h.title; }).map(function (h) { return { title: String(h.title), snippet: str(h.snippet), kind: str(h.kind), url: typeof h.url === 'string' ? h.url : null, source: str(h.source) }; }) };
  }
  /** @description The briefing catalog (sources the caller may hear, each with its saved preference), or its refusal. */
  function briefingRows(r) {
    if (!r || !r.ok || !r.body || !Array.isArray(r.body.sources)) return refused(r);
    return { ok: true, status: r.status, sources: r.body.sources.filter(function (s) { return s && s.id; }).map(function (s) {
      var p = s.preference && typeof s.preference === 'object' ? s.preference : {};
      return { id: String(s.id), title: str(s.title) || String(s.id), description: str(s.description), enabled: p.enabled === true, frequency: str(p.frequency) || 'as-available', channel: str(p.channel) || 'voice', delivery: str(s.delivery) };
    }) };
  }
  /** @description The caller's schedules as routines (what it does, when, next run, paused or active), or the refusal. */
  function scheduleRows(r) {
    if (!r || !r.ok || !r.body || !Array.isArray(r.body.schedules)) return refused(r);
    return { ok: true, status: r.status, rows: r.body.schedules.filter(function (s) { return s && s.id; }).map(function (s) {
      var data = s.taskData && typeof s.taskData === 'object' ? s.taskData : {};
      return { id: String(s.id), title: str(data.prompt) || str(data.kind) || str(s.taskType) || 'Scheduled task', when: cronText(s.cron), cron: str(s.cron), paused: s.status === 'paused', nextRunAt: str(s.nextRunAt), once: s.once === true };
    }) };
  }

  /**
   * @description The homebase's reads and writes over the live adapter's fetch helpers. Every call is caller-scoped by
   * the route it names; a refusal comes back as data, never thrown.
   * @param {{getJson:Function,sendJson:Function}} live The live-data client (window.OSHAL_LIVE).
   * @param {Storage} [storage] Where the Settings page keeps this browser's device id (localStorage by default).
   * @param {Function} [fetchImpl] The fetch used for the one write that needs its own request header (the briefing preference).
   * @returns {object} The data functions.
   */
  function createHomebaseData(live, storage, fetchImpl) {
    var store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    var doFetch = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    var enc = encodeURIComponent;
    /**
     * @description A JSON write with extra request headers. The briefing route refuses a write without its own
     * `x-oshal-briefing-request: 1` header (its same-origin guard), which the shared adapter's sendJson cannot add.
     */
    async function sendWithHeaders(path, method, payload, headers) {
      try {
        var res = await doFetch(path, { method: method, credentials: 'same-origin', headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, headers), body: JSON.stringify(payload) });
        var body = null; try { body = await res.json(); } catch (_) { body = null; }
        return { ok: res.ok, status: res.status, body: body };
      } catch (_) { return { ok: false, status: 0, body: null }; }
    }
    function deviceId() { try { return store ? store.getItem(DEVICE_KEY) : null; } catch (_) { return null; } }
    /**
     * @description The caller's household ('space') or team ('org') group and its members. The directory is asked only
     * when the group has someone besides the caller, and only to name them; its refusal leaves them unnamed.
     * @param {string} kind The group kind.
     * @param {{sub:string,name:string}} self The signed-in caller.
     * @param {function(): Promise<Array<{sub:string,label:string}>>} directory Lazily reads the directory users the caller may see.
     * @returns {Promise<object>} `{ok,status,group,members}` or the refusal.
     */
    async function household(kind, self, directory) {
      var t = await live.getJson('/api/tenants');
      if (!t.ok) return refused(t);
      var group = groupPick(t.body && t.body.tenants, kind);
      if (!group) return { ok: true, status: t.status, group: null, members: [] };
      var m = await live.getJson('/api/tenants/' + enc(group.tenant_id) + '/members');
      if (!m.ok) return Object.assign(refused(m), { group: { id: String(group.tenant_id), name: str(group.name), role: group.role === 'admin' ? 'admin' : 'member' }, members: [] });
      var raw = arr(m.body && m.body.members), others = raw.some(function (x) { return x && x.user_sub && x.user_sub !== self.sub; });
      var users = others && typeof directory === 'function' ? await directory() : [];
      return { ok: true, status: m.status, group: { id: String(group.tenant_id), name: str(group.name), role: group.role === 'admin' ? 'admin' : 'member' }, members: memberRows(raw, self, users) };
    }
    async function progress(studentId) {
      var r = await live.getJson('/api/education/student/' + enc(studentId) + '/dashboard');
      if (!r.ok || !r.body || !r.body.student) return refused(r);
      var s = r.body.student, stats = r.body.stats || {};
      return { ok: true, status: r.status, level: num(s.level), xp: num(s.xp), streak: num(s.streak_days), quizAverage: num(stats.quizAverage), quizCount: num(stats.quizCount), cards: num(stats.flashcardsReviewed), span: levelSpan(s.level, s.xp) };
    }
    async function notifications() {
      var r = await live.getJson('/api/education/notifications');
      if (!r.ok || !r.body || !Array.isArray(r.body.notifications)) return refused(r);
      return { ok: true, status: r.status, items: r.body.notifications.filter(function (n) { return n && n.notification_id; }).map(function (n) { return { id: String(n.notification_id), title: str(n.title), body: str(n.body), sentAt: str(n.sent_at), read: n.read === true }; }) };
    }
    async function routines() {
      var both = await Promise.all([live.getJson('/api/jarvis/briefings'), live.getJson('/api/v1/agent/schedules')]);
      return { briefings: briefingRows(both[0]), schedules: scheduleRows(both[1]) };
    }
    return {
      deviceId: deviceId, household: household, progress: progress, notifications: notifications, routines: routines,
      location: async function () { return locationView(await live.getJson('/api/location/state'), deviceId()); },
      optOut: function (id) { return live.sendJson('/api/location/devices/' + enc(id) + '/opt-out', 'POST'); },
      createHousehold: function (name) { return live.sendJson('/api/tenants', 'POST', { name: name, kind: 'space' }); },
      markRead: function (id) { return live.sendJson('/api/education/notifications/' + enc(id) + '/read', 'PATCH'); },
      setBriefing: function (s, enabled) { return sendWithHeaders('/api/jarvis/briefings/' + enc(s.id), 'PUT', { enabled: enabled, frequency: s.frequency, channel: s.channel }, { 'x-oshal-briefing-request': '1' }); },
      setSchedule: function (id, pause) { return live.sendJson('/api/v1/agent/schedules/' + enc(id) + (pause ? '/pause' : '/resume'), 'POST'); },
      search: async function (q) { return searchRows(await live.getJson('/api/search?q=' + enc(q) + '&limit=10')); }
    };
  }

  return {
    DEVICE_KEY: DEVICE_KEY, locationView: locationView, levelSpan: levelSpan, groupPick: groupPick, memberRows: memberRows, cronText: cronText,
    dayGroups: dayGroups, localMatches: localMatches, searchRows: searchRows, briefingRows: briefingRows, scheduleRows: scheduleRows, createHomebaseData: createHomebaseData
  };
});
