/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Central-assistant Calendar and Travel workspace over real routes, in the demo's look: a month grid of the caller's own busy windows (GET /api/experience/availability) with free Friday-to-Sunday weekends, past and unread days kept unknown and every refusal named; a Travel view (only for a caller whose plan admits Travel, ADR-164 D10) with the trip hero, fact pills, the calendar's free weekends as date pickers, a search that asks Travel's own GET /api/travel/flights, the nonstop / after-3pm / sort filters and a USD budget over the offers it returned, offer cards, an honest empty state, the source line (Duffel live, Duffel test or Travel's labelled sample offers) with the swarm price read, and actions (open Travel, save the best option, view sources); a fare dialog with the offer's slices, expiry and source, save to this device and an explicit "Watch this route" through Travel's POST /api/travel/watches; the shelf's device shortlist and Travel fare watches; the settings' departure airport (Travel profile) and budget (this device); the welcome's connected capabilities (Google connection from GET /api/connect/list, Travel's provider mode from /api/travel/config, the caller's preferences); short text refinements; and source rows for what each view read. Nothing here books, pays, writes a calendar or starts a watch without the person pressing the button that says so.
 */
(() => {
  'use strict';

  /**
   * @description Build the Calendar and Travel workspace for one page.
   * @param {object} ctx Page context: LIVE, D (OSHAL_NEXUS_DATA), shell, snapshot, esc, btn, link, notify, repaint(), setView(view), name().
   * @returns {object} Views (calendarBody, travelBody, fareBody, shelfExtra, settingsFields, sourcesRows, capabilities, planHint), handlers (onAction, onChange, onSubmit, saveSettings, refine) and travelAdmitted().
   */
  function createTrip(ctx) {
    const { LIVE, D, shell, esc, btn, link, notify } = ctx;
    const api = D.createNexusData(LIVE);
    const today = new Date();
    /** The month the Calendar opens on: this one while a Friday is still ahead in it, otherwise the next. */
    function startMonth() {
      const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      while (last.getDay() !== 5) last.setDate(last.getDate() - 1);
      return D.dayKey(today) <= D.dayKey(last) ? new Date(today.getFullYear(), today.getMonth(), 1) : new Date(today.getFullYear(), today.getMonth() + 1, 1);
    }
    const t = {
      year: startMonth().getFullYear(), month: startMonth().getMonth(), availability: null, availKey: '', availGen: 0,
      google: null, config: null, profile: null, statusAsked: false,
      q: { origin: '', destination: '', departDate: '', returnDate: '', weekend: '' },
      searching: false, searchGen: 0, result: null, views: [], searched: null, searchError: '', checkedAt: '',
      filters: { nonstop: false, late: false, sort: 'price' }, watches: null, watchesAsked: false, watchNote: {},
      shortlist: LIVE.prefs.get('nexus:shortlist', []), budget: LIVE.prefs.get('nexus:budget', null)
    };
    const travelApp = () => shell.byId('travel');
    const travelAdmitted = () => Boolean(travelApp() && travelApp().inPlan);
    const money = (n, cur) => (cur === 'USD' ? '$' : `${esc(cur)} `) + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
    const monthIndex = () => t.year * 12 + t.month, minIndex = today.getFullYear() * 12 + today.getMonth();
    const dayLabel = key => { const d = new Date(`${key}T00:00:00`); return isNaN(d.getTime()) ? key : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }); };

    /* ── reads ─────────────────────────────────────────────────── */
    /** Read this month's busy windows once per month shown; a refusal is kept with its own sentence. */
    function ensureAvailability() {
      const key = `${t.year}-${t.month}`;
      if (t.availKey === key) return;
      t.availKey = key; t.availability = null; const gen = ++t.availGen;
      api.availability(t.year, t.month).then(r => {
        if (gen !== t.availGen) return;
        t.availability = r.ok && r.body && r.body.state === 'ready' ? r.body
          : { state: (r.body && r.body.state) || 'failed', error: (r.body && r.body.error) || `Your calendar could not be read${r.status ? ` (HTTP ${r.status})` : ''}. These days are unknown, not free.`, status: r.status };
        ctx.repaint();
      });
    }
    /** Connection and Travel status for the welcome and the Travel view; Travel is asked only when the plan admits it. */
    function ensureStatus() {
      if (t.statusAsked) return; t.statusAsked = true;
      api.connections().then(r => { t.google = D.googleStatus(r); ctx.repaint(); });
      if (!travelAdmitted()) return;
      api.travel.config().then(r => { t.config = r.ok && r.body ? r.body : { refused: r.status }; ctx.repaint(); });
      api.travel.profile().then(r => {
        t.profile = r.ok && r.body && r.body.profile ? r.body.profile : { refused: r.status };
        const home = String(t.profile.home_airport || '').toUpperCase();
        if (!t.q.origin && D.isIata(home)) t.q.origin = home;
        ctx.repaint();
      });
    }
    function ensureWatches() {
      if (!travelAdmitted() || t.watchesAsked) return; t.watchesAsked = true;
      api.travel.watches().then(r => { t.watches = r.ok && r.body && Array.isArray(r.body.items) ? r.body.items : { refused: r.status }; paintPart('trip-watches', watchesList()); });
    }
    function paintPart(name, html) { const el = document.querySelector(`[data-part="${name}"]`); if (el) el.innerHTML = html; }

    /* ── calendar view ─────────────────────────────────────────── */
    function availabilityNote() {
      const a = t.availability;
      if (!a) return '<p class="workspace-subtitle" data-part="availability" data-state="loading">Reading your calendar…</p>';
      if (a.state === 'ready') return `<p class="workspace-subtitle" data-part="availability" data-state="ready">Primary Google calendar · checked ${esc(LIVE.clockTime(LIVE.parseDate(a.checkedAt)))}.</p>`;
      const fix = a.state === 'not-connected' || a.state === 'no-access' ? link('Open Utilities ↗', '/utilities', 'quiet') : btn('Try again', 'cal-retry', 'quiet');
      return `<div class="calendar-explainer tone-warn" data-part="availability" data-state="${esc(a.state)}">${esc(a.error)} ${fix}</div>`;
    }
    function dayCell(d) {
      const cls = ['calendar-day', d.weekend ? 'clear' : '', d.state === 'busy' ? 'busy' : '', d.state === 'unknown' || d.state === 'past' ? d.state : ''].filter(Boolean).join(' ');
      const words = { busy: 'busy', free: d.weekend ? 'free weekend' : 'free', unknown: 'unknown, not read', past: 'past' }[d.state];
      return `<div class="${cls}" data-day="${d.key}" data-state="${d.state}" aria-label="${esc(`${D.MONTHS[t.month]} ${d.n}, ${words}`)}">${d.n}</div>`;
    }
    function explainer(g) {
      const a = t.availability;
      if (!a || a.state !== 'ready') return '<div class="calendar-explainer">Without a calendar read these days are <strong>unknown</strong>, not free.</div>';
      const list = g.weekends.map(w => `<strong>${esc(w.label)}</strong>`).join(' and ');
      return `<div class="calendar-explainer">${g.weekends.length ? `${g.weekends.length === 1 ? 'One complete weekend fits' : `${g.weekends.length} complete weekends fit`}: ${list}.` : `No complete Friday-to-Sunday weekend is free in ${esc(g.month)}.`} Days outside what was read stay unknown, not free.</div>`;
    }
    /** @returns {string} The Calendar tab: month navigation, the grid over the caller's busy windows, legend and explainer. */
    function calendarBody() {
      ensureAvailability();
      const g = D.monthGrid(t.year, t.month, t.availability, new Date());
      const nav = `<span class="cal-nav">${btn('‹', 'cal-prev', 'quiet', `aria-label="Previous month"${monthIndex() <= minIndex ? ' disabled' : ''}`)}<strong>${esc(g.title)}</strong>${btn('›', 'cal-next', 'quiet', `aria-label="Next month"${monthIndex() >= minIndex + 11 ? ' disabled' : ''}`)}</span>`;
      const grid = `<div class="calendar-grid" aria-label="${esc(g.title)} availability, Sunday through Saturday">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(d => `<div class="dow">${d}</div>`).join('')}${'<div class="calendar-pad" aria-hidden="true"></div>'.repeat(g.lead)}${g.days.map(dayCell).join('')}</div>`;
      const next = travelAdmitted() && g.weekends.length ? btn('Compare flights for a free weekend', 'tab', 'primary', 'data-tab="travel"') : '';
      return `<div class="eyebrow">CALENDAR / YOUR AVAILABILITY</div><div class="section-head"><h2 style="font-size:26px;font-weight:400;margin-top:10px">${g.weekends.length ? `${esc(g.month)}, with room to breathe.` : `${esc(g.title)}.`}</h2>${nav}</div><p class="workspace-subtitle">Friday departures, Sunday returns. Only busy windows are read from your primary Google calendar, never event titles.</p>${availabilityNote()}${grid}<div class="calendar-legend"><span>Highlighted: free weekend</span><span>Gold dot: busy</span><span>Dim: past or not read</span></div>${explainer(g)}${next}`;
    }

    /* ── travel view ───────────────────────────────────────────── */
    function sourceLabel() {
      const r = t.result;
      if (!r) return '';
      if (r.source !== 'duffel') return 'SAMPLE OFFERS FROM TRAVEL · NOT QUOTES';
      return t.config && t.config.live ? 'DUFFEL LIVE' : 'DUFFEL TEST ENVIRONMENT · NOT BOOKABLE';
    }
    function providerPill() {
      const c = t.config;
      if (!c) return 'Checking Travel…';
      if (c.refused) return `Travel status unavailable (HTTP ${c.refused})`;
      return c.connected ? (c.live ? 'Flight search: Duffel live' : 'Flight search: Duffel test') : 'Flight search: sample offers only';
    }
    function tripHero() {
      const s = t.searched, scene = `<div class="destination-scene" aria-hidden="true">${'<span></span>'.repeat(6)}</div>`;
      if (!s) return `<div class="trip-hero"><div><div class="eyebrow">A LITTLE SPACE TO GET AWAY</div><h2>Where to?</h2><p>Pick a free weekend, name the airports,<br>and Travel compares the flights. Nothing is booked.</p></div>${scene}</div>`;
      const price = t.result && t.result.price && t.result.price.verdict && t.result.price.verdict !== 'unknown' ? ` · ${esc(t.result.price.verdict)} price` : '';
      return `<div class="trip-hero"><div><div class="eyebrow">A LITTLE SPACE TO GET AWAY</div><h2>${esc(s.destination)}.</h2><p>${esc(s.origin)} → ${esc(s.destination)}<br>${esc(dayLabel(s.departDate))}${s.returnDate ? ` – ${esc(dayLabel(s.returnDate))}` : ' · one way'}${price}</p></div>${scene}</div>`;
    }
    function tripFacts() {
      const q = t.searched || t.q, cabin = String((t.profile && t.profile.preferred_cabin) || 'economy');
      return `<div class="trip-facts"><span class="fact-pill">${esc(q.origin || 'From ?')} → ${esc(q.destination || '?')}</span><span class="fact-pill">1 adult · ${esc(cabin)}</span><span class="fact-pill">${t.budget ? `Up to $${esc(t.budget)} USD` : 'No budget set'}</span><span class="fact-pill" data-part="provider">${esc(providerPill())}</span>${btn('Edit preferences', 'settings', 'quiet')}</div>`;
    }
    function weekendPicker() {
      const a = t.availability, head = `<div class="section-head"><h3>Room in your calendar</h3>${btn(`Show ${esc(D.MONTHS[t.month])}`, 'tab', 'quiet', 'data-tab="calendar"')}</div>`;
      if (!a) return `${head}<p class="workspace-subtitle">Reading your calendar…</p>`;
      if (a.state !== 'ready') return `${head}<p class="workspace-subtitle" data-part="weekends" data-state="${esc(a.state)}">${esc(a.error)} Choose dates below instead.</p>`;
      const weekends = D.freeWeekends(t.year, t.month, a, new Date());
      if (!weekends.length) return `${head}<p class="workspace-subtitle" data-part="weekends" data-state="none">No complete weekend is free in ${esc(D.MONTHS[t.month])}. Choose another month in Calendar, or dates below.</p>`;
      const cards = weekends.map(w => btn(`<span class="calendar-symbol" aria-hidden="true">${esc(w.departDate.slice(8).replace(/^0/, ''))}</span><span><strong>${esc(w.label)}</strong><small>Friday to Sunday · free in your calendar</small></span><span class="availability" aria-hidden="true"></span>`, 'week', 'weekend-card', `data-week="${w.key}" data-depart="${w.departDate}" data-return="${w.returnDate}" aria-pressed="${t.q.weekend === w.key}"`)).join('');
      return `${head}<div class="weekends" data-part="weekends" data-state="ready">${cards}</div>${t.q.weekend ? btn('Choose other dates', 'all-weeks', 'quiet', 'style="margin-top:10px"') : ''}`;
    }
    function searchForm() {
      const q = t.q, field = (label, id, value, attrs) => `<label class="field">${label}<input id="${id}" value="${esc(value)}" ${attrs}></label>`;
      return `<form id="trip-form" class="trip-form" aria-label="Search flights in Travel">${field('From', 'trip-origin', q.origin, 'maxlength="3" placeholder="IATA" autocomplete="off" required')}${field('To', 'trip-destination', q.destination, 'maxlength="3" placeholder="IATA" autocomplete="off" required')}${field('Depart', 'trip-depart', q.departDate, 'type="date" required')}${field('Return', 'trip-return', q.returnDate, 'type="date"')}<button class="primary" type="submit"${t.searching ? ' disabled' : ''}>${t.searching ? 'Searching…' : 'Search flights'}</button></form><p class="result-note">Searching asks Travel, which queries its flight provider under your account and adds the quote to the swarm's anonymous price history. Nothing is booked or watched.</p>`;
    }
    function filters() {
      const f = t.filters;
      return `<div class="filter-bar"><div class="filter-options"><label><input id="nonstop" type="checkbox" ${f.nonstop ? 'checked' : ''}>Nonstop only</label><label><input id="late" type="checkbox" ${f.late ? 'checked' : ''}>Leave after 3pm</label></div><label class="sr-only" for="sort">Sort offers</label><select id="sort" class="sort-select"><option value="price" ${f.sort === 'price' ? 'selected' : ''}>Lowest total fare</option><option value="duration" ${f.sort === 'duration' ? 'selected' : ''}>Shortest outbound trip</option></select></div>`;
    }
    const matches = () => D.filterOffers(t.views, Object.assign({ budget: t.budget }, t.filters));
    function offerCard(v, i) {
      const out = v.outbound, back = v.inbound, sample = t.result && t.result.source !== 'duffel';
      return `<article class="flight ${i === 0 ? 'selected' : ''}" data-flight="${esc(v.id)}"><span class="carrier" aria-hidden="true">${esc(v.airline.slice(0, 1).toUpperCase())}</span><div><strong>${esc(dayLabel(out.date))} · ${esc(out.time || 'time not given')}</strong><small>${v.stops ? `${v.stops} stop${v.stops === 1 ? '' : 's'}` : 'Nonstop'} · ${esc(out.duration || 'duration not given')} outbound${back ? ` · back ${esc(dayLabel(back.date))} ${esc(back.time)}` : ''}<br>${esc(v.airline)}${sample ? ' · sample offer' : ''}</small></div><div class="fare"><strong>${money(v.price, v.currency)}</strong><small>${back ? 'Round trip' : 'One way'}</small>${btn('Details ↗', 'fare', 'quiet', `data-fare="${esc(v.id)}"`)}</div></article>`;
    }
    function flightList() {
      const offers = matches();
      if (offers.length) return `<div class="flight-list">${offers.slice(0, 5).map(offerCard).join('')}</div>`;
      const why = t.views.length ? `No offers match these filters. ${t.views.length} came back from Travel.<br>${btn('Clear flight filters', 'clear-filters', 'secondary')}` : 'Travel returned no offers for this search. Try other dates or airports.';
      return `<div class="flight-list"><div class="empty-result" data-state="${t.views.length ? 'filtered' : 'none'}">${why}</div></div>`;
    }
    function resultNote() {
      const r = t.result, p = r.price || {};
      const read = p.advice ? ` Swarm price read: ${esc(p.advice)}${p.samples ? ` (${esc(p.samples)} recent quotes)` : ''}` : '';
      const lead = r.source === 'duffel' ? `Checked ${esc(LIVE.clockTime(LIVE.parseDate(t.checkedAt)))}. Totals are as the provider quoted them; bags, seats and fare rules are confirmed in Travel.`
        : 'Travel has no flight provider connected for your account, so it returned its labelled sample itineraries. They are not quotes and nothing establishes that these flights exist.';
      return `<p class="result-note" data-part="offers-source" data-source="${esc(r.source || 'demo')}"><span class="source-label">${esc(sourceLabel())}</span> ${lead}${read}${r.error ? ` Travel said: ${esc(r.error)}.` : ''}${t.budget ? ' The budget filter applies to USD offers.' : ''}</p>`;
    }
    function tripActions() {
      const app = travelApp(), offers = matches();
      return `<div class="work-actions">${app && app.navigable ? link('Open in Travel ↗', app.href, 'primary') : ''}${offers.length ? btn('Save best option', 'save-best') : ''}${btn('View sources', 'sources-tab', 'quiet')}</div>`;
    }
    function results() {
      if (t.searching) return '<div class="loading-lines" aria-hidden="true"><span></span><span></span><span></span></div><p class="workspace-subtitle" role="status">Asking Travel for offers…</p>';
      if (t.searchError) return `<div class="empty-result tone-warn" data-state="refused" role="status">${esc(t.searchError)}</div>`;
      return t.result ? `${filters()}${flightList()}${resultNote()}${tripActions()}` : '';
    }
    /** @returns {string} The Travel tab (admitted callers only): hero, facts, free weekends, the search, filters, offers, source line and actions. */
    function travelBody() {
      if (!travelAdmitted()) return '';
      ensureStatus(); ensureAvailability();
      return `<div data-part="travel">${tripHero()}${tripFacts()}${weekendPicker()}${searchForm()}${results()}</div>`;
    }

    /* ── search ────────────────────────────────────────────────── */
    function validQuery(q) {
      const todayKey = D.dayKey(new Date());
      if (!D.isIata(q.origin) || !D.isIata(q.destination)) return 'Use three-letter airport codes for From and To, such as PNS or LAS.';
      if (q.origin === q.destination) return 'From and To must be different airports.';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(q.departDate) || q.departDate < todayKey) return 'Choose a departure date from today on.';
      if (q.returnDate && q.returnDate < q.departDate) return 'The return date must be on or after the departure date.';
      return '';
    }
    function readForm() {
      const val = id => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
      Object.assign(t.q, { origin: val('trip-origin').toUpperCase(), destination: val('trip-destination').toUpperCase(), departDate: val('trip-depart'), returnDate: val('trip-return') });
    }
    /** Ask Travel for offers for the form's query; an older answer that lands after a newer search is dropped. */
    async function search() {
      readForm();
      const bad = validQuery(t.q); if (bad) { t.searchError = bad; ctx.repaint(); return; }
      const q = Object.assign({ pax: 1, cabin: String((t.profile && t.profile.preferred_cabin) || 'economy') }, t.q), gen = ++t.searchGen;
      Object.assign(t, { searching: true, searchError: '' }); ctx.repaint();
      const r = await api.travel.flights(q);
      if (gen !== t.searchGen) return;
      t.searching = false;
      if (!r.ok || !r.body) { t.searchError = `Travel refused the search${r.status ? ` (HTTP ${r.status})` : ''}${r.body && r.body.error ? `: ${String(r.body.error)}` : ''}. Nothing was searched.`; ctx.repaint(); return; }
      Object.assign(t, { result: r.body, views: (Array.isArray(r.body.items) ? r.body.items : []).map(D.offerView).filter(Boolean), searched: q, checkedAt: new Date().toISOString(), watchNote: {} });
      ctx.repaint();
    }

    /* ── fare dialog, shortlist, watches ───────────────────────── */
    const viewById = id => t.views.find(v => v.id === id) || null;
    function sliceLine(label, s) { return s ? `${label} ${esc(dayLabel(s.date))} ${esc(s.time)}${s.arrive ? ` → ${esc(s.arrive)}` : ''} · ${esc(s.duration || 'duration not given')} · ${s.stops ? `${s.stops} stop${s.stops === 1 ? '' : 's'}` : 'nonstop'}` : ''; }
    /** @returns {string} The fare dialog body for one offer Travel returned, or '' when it is not in the current result. */
    function fareBody(id) {
      const v = viewById(id), s = t.searched; if (!v || !s) return '';
      const exp = LIVE.parseDate(v.expiresAt), app = travelApp();
      const watch = t.result.source === 'duffel' ? btn('Watch this route', 'watch-offer', 'secondary', `data-fare="${esc(v.id)}"`) : '';
      return `<span class="source-label">${esc(sourceLabel())}</span><div class="dialog-detail" data-part="fare-detail">${esc(s.origin)} → ${esc(s.destination)} · ${esc(v.airline)}<br>${sliceLine('Outbound', v.outbound)}${v.inbound ? `<br>${sliceLine('Return', v.inbound)}` : ''}<br>${money(v.price, v.currency)} ${v.inbound ? 'round trip' : 'one way'} · 1 adult${v.cabin ? ` · ${esc(v.cabin)}` : ''}</div><p>${exp ? `The provider says this offer expires ${esc(exp.toLocaleString())}.` : 'The provider gave no expiry for this offer.'} Price and availability are confirmed in Travel before any booking; bags, seats and cancellation terms are not shown here.</p><p>Nothing is booked from this page. Watching the route asks Travel to re-check its price on a schedule and keep the watch on your Travel list.</p><div class="dialog-buttons">${btn('Save this option', 'save-offer', 'primary', `data-fare="${esc(v.id)}"`)}${watch}${app && app.navigable ? link('Open in Travel ↗', app.href, 'secondary') : ''}</div><p class="result-note" role="status" data-part="watch-note">${esc(t.watchNote[v.id] || '')}</p>`;
    }
    function save(id) {
      const v = id ? viewById(id) : matches()[0]; if (!v || !t.searched) return;
      t.shortlist = D.addToShortlist(t.shortlist, D.shortlistEntry(v, t.searched, t.result.source, t.checkedAt));
      LIVE.prefs.set('nexus:shortlist', t.shortlist);
      notify('Saved on this device. Nothing is reserved; search again to confirm the price.');
    }
    async function watch(id) {
      const v = viewById(id); if (!v || !t.searched || t.result.source !== 'duffel') return;
      t.watchNote[id] = 'Asking Travel to watch this route…'; paintPart('watch-note', esc(t.watchNote[id]));
      const r = await api.travel.watch(t.searched, v);
      t.watchNote[id] = r.ok ? 'Watching: Travel re-checks this route and keeps the watch on your Travel list.' : `Travel refused the watch (HTTP ${r.status})${r.body && r.body.error ? `: ${String(r.body.error)}` : ''}. Nothing is being watched.`;
      if (r.ok) { t.watchesAsked = false; t.watches = null; }
      paintPart('watch-note', esc(t.watchNote[id]));
    }
    function shortlistItems() {
      if (!t.shortlist.length) return '<p class="workspace-subtitle">Nothing saved on this device yet. Search in Travel, then save an option you like.</p>';
      return t.shortlist.map(e => `<div class="shortlist-item" data-saved="${esc(e.id)}"><strong>${esc(e.origin)} → ${esc(e.destination)} · ${esc(dayLabel(e.departDate))}${e.returnDate ? ` – ${esc(dayLabel(e.returnDate))}` : ''}</strong><small>${esc(e.airline)} · ${money(e.price, e.currency)} · ${e.stops ? `${esc(e.stops)} stop` : 'nonstop'} · ${e.source === 'duffel' ? 'provider quote' : 'Travel sample offer'} · seen ${esc(LIVE.relativeTime(LIVE.parseDate(e.checkedAt)))}</small><small>Saved on this device only. Not a reservation or a calendar event.</small></div>`).join('');
    }
    function watchesList() {
      const w = t.watches;
      if (w === null) return '<p class="workspace-subtitle">Reading your Travel watches…</p>';
      if (!Array.isArray(w)) return `<p class="workspace-subtitle tone-warn">Your Travel watches could not be read (HTTP ${esc(w.refused)}).</p>`;
      if (!w.length) return '<p class="workspace-subtitle">No fare watches in Travel.</p>';
      return w.slice(0, 8).map(x => `<div class="shortlist-item" data-watch="${esc(x.watch_id)}"><strong>${esc(x.route_key)}</strong><small>${esc(x.status)}${x.last_price != null ? ` · last seen ${money(x.last_price, String(x.currency || 'USD'))}` : ''}${x.last_checked_at ? ` · checked ${esc(LIVE.relativeTime(LIVE.parseDate(x.last_checked_at)))}` : ' · not checked yet'}</small></div>`).join('');
    }
    /** @returns {string} The shelf's trip sections: the device shortlist and, for admitted callers, Travel's fare watches. */
    function shelfExtra() {
      ensureWatches();
      const back = t.result ? btn('Return to the comparison', 'resume-trip', 'primary') : '';
      return `<div class="source-row" data-part="shortlist"><h3>Saved on this device</h3>${shortlistItems()}${back}</div>${travelAdmitted() ? `<div class="source-row"><h3>Fare watches in Travel</h3><div data-part="trip-watches">${watchesList()}</div></div>` : ''}`;
    }

    /* ── settings, sources, welcome, overview ──────────────────── */
    /** @returns {string} The trip fields of the preferences dialog (admitted callers only). */
    function settingsFields() {
      if (!travelAdmitted()) return '';
      const home = t.profile && t.profile.home_airport ? String(t.profile.home_airport) : '';
      return `<label class="field">Departure airport (saved to your Travel profile)<input id="home-airport" maxlength="3" value="${esc(home)}" placeholder="e.g. PNS" autocomplete="off"></label><label class="field">Round-trip budget in USD (this device)<input id="trip-budget" type="number" min="50" max="20000" step="1" value="${esc(t.budget || '')}" placeholder="No budget"></label>`;
    }
    /**
     * Validate and apply the trip fields: the budget stays on this device, a changed departure airport is saved through Travel's profile route.
     * @returns {Promise<string>} '' when applied, else the sentence to show.
     */
    async function saveSettings() {
      const homeEl = document.getElementById('home-airport'), budgetEl = document.getElementById('trip-budget');
      if (!homeEl || !budgetEl) return '';
      const home = homeEl.value.trim().toUpperCase(), raw = budgetEl.value.trim(), budget = raw ? Number(raw) : null;
      if (raw && (!Number.isInteger(budget) || budget < 50 || budget > 20000)) return 'Budget must be a whole number of dollars from 50 to 20000, or empty.';
      if (home && !D.isIata(home)) return 'Departure airport must be a three-letter code, such as PNS.';
      t.budget = budget; LIVE.prefs.set('nexus:budget', budget);
      const current = t.profile && t.profile.home_airport ? String(t.profile.home_airport).toUpperCase() : '';
      if (!home || home === current) return '';
      const r = await api.travel.saveHomeAirport(home);
      if (!r.ok) return `Travel refused the departure airport (HTTP ${r.status}). Your budget was saved on this device.`;
      t.profile = (r.body && r.body.profile) || Object.assign({}, t.profile, { home_airport: home });
      if (!t.searched) t.q.origin = home;
      return '';
    }
    /** @returns {string} Source rows for what the Calendar and Travel views read, and where each preference lives. */
    function sourcesRows() {
      const a = t.availability, ready = a && a.state === 'ready';
      const cal = `<div class="source-row" data-source="calendar"><span class="source-label">${ready ? 'LIVE / YOUR CALENDAR' : 'NOT READ'}</span><h3>Calendar availability</h3><p>${ready ? `Busy windows from your primary Google calendar for ${esc(D.MONTHS[t.month])} ${t.year}, checked ${esc(LIVE.clockTime(LIVE.parseDate(a.checkedAt)))}. No event titles are read; days outside the read stay unknown.` : esc((a && a.error) || 'Open the Calendar tab to read your busy windows.')}</p></div>`;
      const r = t.result, travel = travelAdmitted() ? `<div class="source-row" data-source="travel"><span class="source-label">${r ? esc(sourceLabel()) : 'NOT SEARCHED'}</span><h3>Travel offers</h3><p>${r ? `${t.views.length} offer${t.views.length === 1 ? '' : 's'} from Travel's flight search for ${esc(t.searched.origin)} → ${esc(t.searched.destination)}, checked ${esc(LIVE.clockTime(LIVE.parseDate(t.checkedAt)))}. Booking is a handoff in Travel; this page never books or pays.` : 'Nothing has been searched from this page.'}</p></div>` : '';
      const home = t.profile && t.profile.home_airport ? String(t.profile.home_airport) : '';
      const prefs = `<div class="source-row" data-source="preferences"><span class="source-label">YOUR CHOICES</span><h3>Your preferences</h3><p>${travelAdmitted() ? `Departure airport ${home ? esc(home) : 'not set'} from your Travel profile; budget ${t.budget ? `$${esc(t.budget)} USD` : 'not set'} on this device. ` : ''}The assistant's name and voice settings are kept on this device. Nothing is inferred from your location.</p></div>`;
      return cal + travel + prefs;
    }
    function capability(id, on, name, detail) {
      return `<div class="connected-item" data-capability="${id}" data-on="${on}"><strong><span class="status-dot${on ? '' : ' off'}"></span>${esc(name)}</strong><small>${esc(detail)}</small></div>`;
    }
    /** @returns {string} The welcome's connected capabilities, each from its own read: Calendar, Travel (admitted only) and preferences. */
    function capabilities() {
      ensureStatus();
      const g = t.google, calText = !g ? 'Checking your Google connection…' : { connected: 'Google connected · free weekends on request', expired: 'Google sign-in expired · reconnect in Utilities', 'not-connected': 'Connect Google to find free days', unknown: 'Connection status unavailable' }[g.state];
      const items = [capability('calendar', Boolean(g && g.state === 'connected'), 'Calendar', calText)];
      if (travelAdmitted()) items.push(capability('travel', Boolean(t.config && t.config.connected), 'Travel', providerPill()));
      const home = t.profile && t.profile.home_airport ? `From ${String(t.profile.home_airport)}` : travelAdmitted() ? 'No departure airport yet' : `Named ${ctx.name()} on this device`;
      items.push(capability('preferences', true, 'Your preferences', `${home}${t.budget ? ` · up to $${t.budget}` : ''}`));
      return items.join('');
    }
    const TRIP_WORDS = /\b(flights?|fly|flying|trip|travel|vacation|getaway|weekend|escape|holiday|free days?|calendar)\b/i;
    /** @returns {string} A card that offers the Calendar and Travel views when the request or answer is about a trip or free time. */
    function planHint(query, answer) {
      if (!TRIP_WORDS.test(`${query} ${answer}`)) return '';
      return `<div class="result-card plan-card" data-part="plan"><span class="source-label">CONTINUE WITH YOUR APPS</span><h3>Plan it alongside the conversation</h3><p>Your calendar shows which weekends are free${travelAdmitted() ? '; Travel compares flights for them' : ''}. Both open here, next to this answer.</p><div class="work-actions">${btn('Check my calendar', 'tab', 'secondary', 'data-tab="calendar"')}${travelAdmitted() ? btn('Compare flights in Travel', 'tab', 'primary', 'data-tab="travel"') : ''}</div></div>`;
    }

    /* ── events ────────────────────────────────────────────────── */
    const ACTIONS = {
      'cal-prev': () => { if (monthIndex() > minIndex) { t.month -= 1; if (t.month < 0) { t.month = 11; t.year -= 1; } ctx.repaint(); } },
      'cal-next': () => { if (monthIndex() < minIndex + 11) { t.month += 1; if (t.month > 11) { t.month = 0; t.year += 1; } ctx.repaint(); } },
      'cal-retry': () => { t.availKey = ''; ctx.repaint(); },
      week: el => { readForm(); const same = t.q.weekend === el.dataset.week; Object.assign(t.q, same ? { weekend: '' } : { weekend: el.dataset.week, departDate: el.dataset.depart, returnDate: el.dataset.return }); ctx.repaint(); },
      'all-weeks': () => { readForm(); t.q.weekend = ''; ctx.repaint(); },
      'clear-filters': () => { t.filters = { nonstop: false, late: false, sort: t.filters.sort }; ctx.repaint(); },
      'save-best': () => save(''),
      'save-offer': el => { save(el.dataset.fare); ctx.closeDialog(); },
      'watch-offer': el => { watch(el.dataset.fare); },
      'resume-trip': () => { ctx.closeDialog(); ctx.setView('travel'); }
    };
    /** @returns {boolean} Whether the action was a trip action (handled here). */
    function onAction(action, el) { const fn = ACTIONS[action]; if (!fn) return false; fn(el); return true; }
    /** @returns {boolean} Whether the change was a trip filter or form field (handled here). */
    function onChange(e) {
      const id = e.target.id;
      if (id === 'nonstop' || id === 'late') { t.filters[id] = e.target.checked; ctx.repaint(); return true; }
      if (id === 'sort') { t.filters.sort = e.target.value; ctx.repaint(); return true; }
      if (/^trip-/.test(id)) { readForm(); if (id === 'trip-depart' || id === 'trip-return') t.q.weekend = ''; return true; }
      return false;
    }
    /** @returns {boolean} Whether the input was a trip form field (kept in state so a repaint never loses what is typed). */
    function onInput(e) { if (!/^trip-/.test(e.target.id)) return false; readForm(); return true; }
    /** @returns {boolean} Whether the submit was the trip search (handled here). */
    function onSubmit(e) { if (e.target.id !== 'trip-form') return false; search(); return true; }
    /**
     * A short follow-up that refines what is on screen: "calendar" opens the Calendar view, "after 3pm" and "nonstop"
     * filter the offers Travel already returned. Anything else is for Jarvis.
     * @returns {boolean} Whether the text was consumed as a refinement.
     */
    function refine(text) {
      const r = D.refinement(text);
      if (r === 'calendar') { ctx.setView('calendar'); return true; }
      if ((r === 'late' || r === 'nonstop') && t.views.length) {
        t.filters[r] = true; ctx.setView('travel');
        notify(r === 'late' ? 'Kept departures after 3pm. This filters the offers Travel returned; nothing new was searched.' : 'Kept nonstop offers. This filters the offers Travel returned; nothing new was searched.');
        return true;
      }
      return false;
    }

    return { calendarBody, travelBody, fareBody, shelfExtra, settingsFields, saveSettings, sourcesRows, capabilities, planHint, onAction, onChange, onInput, onSubmit, refine, travelAdmitted, state: t };
  }

  window.OSHAL_NEXUS_TRIP = Object.freeze({ createTrip });
})();
