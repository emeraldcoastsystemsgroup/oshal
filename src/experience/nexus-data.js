/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Central-assistant data kit for the Calendar and Travel views: pure readers (the month grid and its free Friday-to-Sunday weekends over the caller's busy windows, with past and unread days kept "unknown", never free; Travel offer cards from the package's normalised Duffel offers; the local nonstop / after-3pm / budget filters and sort; short text refinements; the device-local shortlist; the Google connection status; the spoken briefing built from the live snapshot) and one client over the existing routes (GET /api/experience/availability, GET /api/connect/list, and Travel's /config, /profile, /flights and /watches). No figure is invented here: every value comes from a route's answer or the caller's own device.
 */
(function attach(root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.OSHAL_NEXUS_DATA = api;
})(typeof window !== 'undefined' ? window : globalThis, function build() {
  'use strict';

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var SHORT = MONTHS.map(function (m) { return m.slice(0, 3); });
  var SHORTLIST_CAP = 12;

  /**
   * @description Local YYYY-MM-DD for a Date: the day the person sees, not the UTC day.
   * @param {Date} d The date.
   * @returns {string} The local day key.
   */
  function dayKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  /** @description Local midnight of the day after `d`. */
  function nextDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1); }
  /** @description Local midnight of `d`'s own day. */
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

  /**
   * @description The read window for one month grid: the 1st at local midnight through the 4th of the next month,
   * so a weekend that starts on the month's last Friday is read in full.
   * @param {number} year Full year.
   * @param {number} month Zero-based month.
   * @returns {{timeMin:string,timeMax:string}} ISO instants for GET /api/experience/availability.
   */
  function monthWindow(year, month) {
    return { timeMin: new Date(year, month, 1).toISOString(), timeMax: new Date(year, month + 1, 4).toISOString() };
  }

  /** @description Whether any busy window overlaps [start, end). */
  function overlaps(busy, start, end) {
    return (busy || []).some(function (b) { return Date.parse(b.start) < end && Date.parse(b.end) > start; });
  }

  /**
   * @description One day's state: 'past' before today, 'unknown' when there is no ready read or the day falls outside
   * the read window (no access is unknown, never free), else 'busy' or 'free'.
   * @param {Date} date Local midnight of the day.
   * @param {object|null} availability The route's ready answer ({state, timeMin, timeMax, busy}) or a refusal.
   * @param {Date} today Local midnight of today.
   * @returns {'past'|'unknown'|'busy'|'free'} The day state.
   */
  function dayState(date, availability, today) {
    if (date.getTime() < today.getTime()) return 'past';
    if (!availability || availability.state !== 'ready') return 'unknown';
    var start = date.getTime(), end = nextDay(date).getTime();
    if (start < Date.parse(availability.timeMin) || end > Date.parse(availability.timeMax)) return 'unknown';
    return overlaps(availability.busy, start, end) ? 'busy' : 'free';
  }

  /** @description "November 6–8" in one month, "Oct 30 – Nov 1" across two. */
  function weekendLabel(fri, sun) {
    return fri.getMonth() === sun.getMonth() ? MONTHS[fri.getMonth()] + ' ' + fri.getDate() + '–' + sun.getDate()
      : SHORT[fri.getMonth()] + ' ' + fri.getDate() + ' – ' + SHORT[sun.getMonth()] + ' ' + sun.getDate();
  }

  /**
   * @description The month's Friday-to-Sunday weekends whose three days are all read and free.
   * @param {number} year Full year.
   * @param {number} month Zero-based month.
   * @param {object|null} availability The route's answer.
   * @param {Date} now Current time.
   * @returns {Array<{key:string,label:string,departDate:string,returnDate:string}>} Free weekends, in date order.
   */
  function freeWeekends(year, month, availability, now) {
    var today = startOfDay(now), out = [];
    for (var d = new Date(year, month, 1); d.getMonth() === month; d = nextDay(d)) {
      if (d.getDay() !== 5) continue;
      var sat = nextDay(d), sun = nextDay(sat);
      if ([d, sat, sun].every(function (x) { return dayState(x, availability, today) === 'free'; })) {
        out.push({ key: dayKey(d), label: weekendLabel(d, sun), departDate: dayKey(d), returnDate: dayKey(sun) });
      }
    }
    return out;
  }

  /**
   * @description The month grid the Calendar view draws: leading blanks, each day with its state, the free weekends and counts.
   * @param {number} year Full year.
   * @param {number} month Zero-based month.
   * @param {object|null} availability The route's answer.
   * @param {Date} now Current time.
   * @returns {{title:string,lead:number,days:Array<{n:number,key:string,state:string,weekend:boolean}>,weekends:Array,counts:object}} The grid.
   */
  function monthGrid(year, month, availability, now) {
    var today = startOfDay(now), days = [], counts = { busy: 0, free: 0, unknown: 0, past: 0 };
    var weekends = freeWeekends(year, month, availability, now), inWeekend = {};
    weekends.forEach(function (w) { var f = new Date(w.departDate + 'T00:00:00'); [0, 1, 2].forEach(function (i) { inWeekend[dayKey(new Date(f.getFullYear(), f.getMonth(), f.getDate() + i))] = true; }); });
    for (var d = new Date(year, month, 1); d.getMonth() === month; d = nextDay(d)) {
      var state = dayState(d, availability, today); counts[state] += 1;
      days.push({ n: d.getDate(), key: dayKey(d), state: state, weekend: Boolean(inWeekend[dayKey(d)]) });
    }
    return { title: MONTHS[month] + ' ' + year, month: MONTHS[month], lead: new Date(year, month, 1).getDay(), days: days, weekends: weekends, counts: counts };
  }

  /**
   * @description Minutes in a "5h 30m" duration as Travel's offers carry it.
   * @param {string} text The duration text.
   * @returns {number} Minutes, or Infinity when unreadable (so it sorts last).
   */
  function durationMinutes(text) {
    var m = /^(?:(\d+)d\s*)?(\d+)h(?:\s*(\d+)m)?$/.exec(String(text || '').trim());
    return m ? Number(m[1] || 0) * 1440 + Number(m[2]) * 60 + Number(m[3] || 0) : Infinity;
  }
  /**
   * @description The clock time an offer names ("2026-11-06T14:10:00" gives "2:10 PM"), read as written: an airport's local
   * time is never shifted into this browser's zone.
   * @param {string} iso The offer's local date-time.
   * @returns {string} "h:mm AM/PM", or '' when there is no time.
   */
  function clockOf(iso) {
    var m = /T(\d{2}):(\d{2})/.exec(String(iso || ''));
    if (!m) return '';
    var h = Number(m[1]), suffix = h >= 12 ? 'PM' : 'AM';
    return ((h % 12) || 12) + ':' + m[2] + ' ' + suffix;
  }
  /** @description One flight slice as the card shows it. */
  function sliceView(s) {
    if (!s || typeof s !== 'object') return null;
    var dep = String(s.departAt || '');
    return { origin: String(s.origin || ''), destination: String(s.destination || ''), date: dep.slice(0, 10), time: clockOf(dep), arrive: clockOf(s.arriveAt),
      hour: /T(\d{2})/.test(dep) ? Number(/T(\d{2})/.exec(dep)[1]) : -1, duration: String(s.duration || ''), minutes: durationMinutes(s.duration),
      stops: Math.max(0, Number(s.stops) || 0), carriers: Array.isArray(s.carriers) ? s.carriers.map(String) : [] };
  }

  /**
   * @description A Travel offer (the package's normalised Duffel card) as the flight list shows it; malformed offers are dropped.
   * @param {object} o Offer from GET /api/travel/flights.
   * @returns {object|null} The card view: id, airline, price, currency, outbound/inbound slices, stops, departure hour.
   */
  function offerView(o) {
    if (!o || typeof o.id !== 'string' || !o.id || !Number.isFinite(Number(o.price)) || !Array.isArray(o.slices) || !o.slices.length) return null;
    var slices = o.slices.map(sliceView).filter(Boolean);
    if (!slices.length) return null;
    return { id: o.id, airline: String(o.airline || slices[0].carriers[0] || 'Airline not named'), price: Number(o.price), currency: String(o.currency || 'USD').toUpperCase(),
      cabin: o.cabin ? String(o.cabin) : '', expiresAt: o.expiresAt ? String(o.expiresAt) : '', outbound: slices[0], inbound: slices[1] || null,
      stops: Math.max.apply(null, slices.map(function (s) { return s.stops; })), nonstop: slices.every(function (s) { return s.stops === 0; }),
      hour: slices[0].hour, minutes: slices[0].minutes };
  }

  /**
   * @description Apply the local filters and sort to offer views. The budget applies to USD offers only (it is kept in USD).
   * @param {Array<object>} views Offer views.
   * @param {{nonstop?:boolean,late?:boolean,budget?:number|null,sort?:string}} f Filters.
   * @returns {Array<object>} Matching views, cheapest (or shortest) first.
   */
  function filterOffers(views, f) {
    var opts = f || {}, budget = Number(opts.budget) > 0 ? Number(opts.budget) : 0;
    return (views || []).filter(function (v) {
      return (!opts.nonstop || v.nonstop) && (!opts.late || v.hour >= 15) && (!budget || v.currency !== 'USD' || v.price <= budget);
    }).sort(function (a, b) { return opts.sort === 'duration' ? a.minutes - b.minutes || a.price - b.price : a.price - b.price || a.minutes - b.minutes; });
  }

  /**
   * @description A short follow-up that refines what is on screen instead of starting a new request: "after 3pm",
   * "nonstop", "calendar". Anything longer than a short phrase is a real question for Jarvis.
   * @param {string} text What was typed.
   * @returns {'late'|'nonstop'|'calendar'|null} The refinement, or null.
   */
  function refinement(text) {
    var t = String(text || '').trim().toLowerCase();
    if (!t || t.length > 40) return null;
    if (/\bafter (3|three|15)(\s?pm|:00)?\b/.test(t) || /\b(later? (departures?|flights?)|leave (late|after)|afternoon|evening)\b/.test(t) || /^late$/.test(t)) return 'late';
    if (/\bnon.?stop\b|\bdirect( flights?)?$/.test(t)) return 'nonstop';
    if (/^(show |open )?(me )?(my )?calendar\b/.test(t)) return 'calendar';
    return null;
  }

  /**
   * @description Whether a value is a three-letter IATA airport code (upper case).
   * @param {string} code The value.
   * @returns {boolean} True for a code such as PNS.
   */
  function isIata(code) { return /^[A-Z]{3}$/.test(String(code || '')); }

  /**
   * @description One shortlist entry for this device: what was seen, when, and from which source. Never a reservation.
   * @param {object} view Offer view.
   * @param {object} query The search it came from ({origin,destination,departDate,returnDate}).
   * @param {string} source The Travel answer's source ('duffel' or 'demo').
   * @param {string} checkedAt ISO time of the search.
   * @returns {object} The entry.
   */
  function shortlistEntry(view, query, source, checkedAt) {
    return { id: view.id, origin: query.origin, destination: query.destination, departDate: query.departDate, returnDate: query.returnDate || '',
      airline: view.airline, price: view.price, currency: view.currency, stops: view.stops, time: view.outbound.time, source: source === 'duffel' ? 'duffel' : 'demo', checkedAt: checkedAt };
  }
  /**
   * @description Add an entry to the device shortlist: newest first, one per offer, at most twelve.
   * @param {Array<object>} list The current shortlist.
   * @param {object} entry The entry to add.
   * @returns {Array<object>} The new shortlist.
   */
  function addToShortlist(list, entry) {
    return [entry].concat((Array.isArray(list) ? list : []).filter(function (e) { return e && e.id !== entry.id; })).slice(0, SHORTLIST_CAP);
  }

  /**
   * @description The caller's Google connection from GET /api/connect/list (status only; the route never returns tokens).
   * @param {{ok:boolean,status:number,body:any}} res The route's answer.
   * @returns {{state:'connected'|'expired'|'not-connected'|'unknown',status:number}} The status.
   */
  function googleStatus(res) {
    if (!res || !res.ok || !res.body || !Array.isArray(res.body.providers)) return { state: 'unknown', status: res ? res.status : 0 };
    var google = res.body.providers.filter(function (p) { return p && p.id === 'google'; })[0];
    if (!google || !google.connected) return { state: 'not-connected', status: res.status };
    var conns = Array.isArray(google.connections) ? google.connections : [];
    return { state: conns.length && conns.every(function (c) { return c && c.expired; }) ? 'expired' : 'connected', status: res.status };
  }

  /**
   * @description The welcome readback: a short spoken briefing built only from the live snapshot.
   * @param {object} snapshot The shell snapshot (apps, bots, work).
   * @param {{greeting:string,firstName:string,open:Array<object>}} who Greeting word, first name and the caller's open work.
   * @returns {string} The sentence to speak.
   */
  function briefingText(snapshot, who) {
    var open = who.open || [], latest = open[0];
    var lead = who.greeting + ', ' + who.firstName + '. ' + snapshot.apps.length + ' application' + (snapshot.apps.length === 1 ? ' is' : 's are') + ' ready and '
      + snapshot.botsOnline + ' of ' + snapshot.bots.length + ' assistant' + (snapshot.bots.length === 1 ? ' is' : 's are') + ' online.';
    var work = latest ? ' You have ' + open.length + ' open item' + (open.length === 1 ? '' : 's') + '; the most recent is ' + latest.title + ', ' + latest.status.label.toLowerCase() + '.'
      : snapshot.workLoaded ? ' Nothing is waiting on you right now.' : '';
    return lead + work + ' Tell me what you want to do.';
  }

  /** @description Query string from a flat object, skipping empty values. */
  function qs(params) {
    return Object.keys(params).filter(function (k) { return params[k] !== undefined && params[k] !== null && params[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
  }

  /**
   * @description Client over the existing routes, through the shell's own fetch wrapper (same-origin, credentials, JSON).
   * @param {{getJson:Function,sendJson:Function}} live The OSHAL_LIVE client.
   * @returns {object} availability, connections and the Travel reads/writes; each resolves to the route's answer, refusals included.
   */
  function createNexusData(live) {
    return {
      availability: function (year, month) { return live.getJson('/api/experience/availability?' + qs(monthWindow(year, month)), { timeoutMs: 20000 }); },
      connections: function () { return live.getJson('/api/connect/list'); },
      travel: {
        config: function () { return live.getJson('/api/travel/config'); },
        profile: function () { return live.getJson('/api/travel/profile'); },
        saveHomeAirport: function (code) { return live.sendJson('/api/travel/profile', 'POST', { homeAirport: code }); },
        flights: function (q) { return live.getJson('/api/travel/flights?' + qs({ origin: q.origin, destination: q.destination, departDate: q.departDate, returnDate: q.returnDate, pax: q.pax || 1, cabin: q.cabin || 'economy' }), { timeoutMs: 45000 }); },
        watches: function () { return live.getJson('/api/travel/watches'); },
        watch: function (q, view) { return live.sendJson('/api/travel/watches', 'POST', { kind: 'flight', origin: q.origin, destination: q.destination, departDate: q.departDate, returnDate: q.returnDate, pax: q.pax || 1, cabin: q.cabin || 'economy', lastPrice: view.price }); }
      }
    };
  }

  return {
    MONTHS: MONTHS, dayKey: dayKey, monthWindow: monthWindow, dayState: dayState, freeWeekends: freeWeekends, monthGrid: monthGrid,
    durationMinutes: durationMinutes, clockOf: clockOf, offerView: offerView, filterOffers: filterOffers, refinement: refinement, isIata: isIata,
    shortlistEntry: shortlistEntry, addToShortlist: addToShortlist, googleStatus: googleStatus, briefingText: briefingText, createNexusData: createNexusData
  };
});
