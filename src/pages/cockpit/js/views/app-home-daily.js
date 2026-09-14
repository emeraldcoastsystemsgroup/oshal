/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Present bounded named areas and source details without replacing the authorized application directory.
 */
import { ordered, selected } from './app-home-model.js';

const LABELS = { platform: 'OSHAL', 'ai-productivity': 'Work', 'ai-knowledge': 'Learning',
  'ai-finance': 'Finance', 'ai-creative': 'Create', 'ai-home': 'Home & lifestyle', 'ai-engineering': 'Engineering' };

/** @description Escape owner-provided labels before placing them in HTML.
 * @param {unknown} value Text. @returns {string} Safe text. */
export function homeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** @description Preserve account ordering and hiding while keeping unknown suites out of daily areas only.
 * @param {Array} shelves Complete catalog shelves. @param {object} preferences Saved display choices.
 * @returns {Array} Known nonempty daily areas; the caller retains the complete catalog. */
export function dailyAreas(shelves, preferences) {
  return ordered(shelves, preferences.suiteOrder, s => s.key)
    .filter(s => LABELS[s.key] && !(preferences.hiddenSuites || []).includes(s.key))
    .map(s => ({ ...s, label: LABELS[s.key], entries: ordered(s.entries, preferences.appOrder, e => e.name)
      .filter(e => !(preferences.hiddenApps || []).includes(e.name)) })).filter(s => s.entries.length);
}

/** @description Pick a source fact without turning unavailable probes or setup counts into invented updates.
 * @param {object} entry Authorized source. @param {Map} cards Probe responses. @param {object} preferences Saved choices.
 * @returns {object} A bounded traceable summary with an honest absence state. */
export function dailyFact(entry, cards, preferences) {
  const raw = cards.get(entry.name);
  if (!raw) return { text: 'Checking updates…', state: 'loading', tone: 'neutral' };
  const data = selected(raw, preferences.cards?.[entry.name]);
  const item = data.items.find(i => i.tone === 'warn') || data.items.find(i => i.highlight) || data.items[0];
  const metric = data.tiles.find(t => t.tone === 'warn') || data.tiles[0];
  if (item) return { text: item.text, tone: item.tone, state: 'reported' };
  if (metric) return { text: `${metric.label}: ${metric.value}`, tone: metric.tone, state: 'reported' };
  const unavailable = data.summaryErrors || data.recentUnavailable;
  return { text: unavailable ? 'Updates unavailable' : data.anyChecked || data.fallback
    ? 'No updates reported' : 'No summary connected', state: unavailable ? 'unavailable' : 'empty', tone: 'neutral' };
}

/** @description Rank already authorized facts while retaining saved order among equivalent sources.
 * @param {Array} entries Visible sources. @param {Map} cards Probe responses. @param {object} preferences Saved choices.
 * @returns {Array} Source identities paired with their existing summary. */
export function dailyRows(entries, cards, preferences) {
  return entries.map(entry => ({ entry, ...dailyFact(entry, cards, preferences) }))
    .sort((a, b) => Number(b.tone === 'warn') - Number(a.tone === 'warn')
      || Number(b.state === 'reported') - Number(a.state === 'reported'));
}

/** @description Render one selection control per named area, regardless of catalog size.
 * @param {Array} areas Visible named areas. @param {Map} cards Probe responses. @param {object} preferences Display choices.
 * @param {string} active Currently selected area. @returns {string} Bounded area controls. */
export function areaHtml(areas, cards, preferences, active) {
  return `<nav class="apps-home-areas" aria-label="Daily areas">${areas.map(area => {
    const row = dailyRows(area.entries, cards, preferences)[0];
    return `<button type="button" data-home-area="${homeText(area.key)}" aria-pressed="${area.key === active}">
      <strong>${homeText(area.label)}</strong><span>${homeText(row.text)}</span></button>`;
  }).join('')}</nav>`;
}

/** @description Render at most four app-owned updates; setup stays in the selected application's details.
 * @param {Array} entries Visible sources. @param {Map} cards Probe responses. @param {object} preferences Display choices.
 * @returns {string} Compact update list with source selection. */
export function updatesHtml(entries, cards, preferences) {
  const rows = dailyRows(entries, cards, preferences).filter(row => row.state === 'reported').slice(0, 4);
  return `<section class="apps-home-updates" aria-labelledby="homeUpdatesTitle"><h3 id="homeUpdatesTitle">From your apps</h3>
    ${rows.length ? `<ul>${rows.map(row => `<li><button type="button" data-home-detail="${homeText(row.entry.name)}">
      <strong>${homeText(row.entry.displayName)}</strong><span>${homeText(row.text)}</span></button></li>`).join('')}</ul>`
      : '<p class="apps-home-quiet">Your connected apps will show their updates here. Select an area to check its sources.</p>'}</section>`;
}

/** @description Keep every authorized catalog entry searchable, independently of Home display choices.
 * @param {Array} entries Full authorized plan. @param {string} query User search. @returns {string} Inert navigation controls. */
export function directoryHtml(entries, query = '') {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = entries.filter(e => words.every(word => `${e.displayName} ${e.name} ${e.description || ''}`.toLocaleLowerCase().includes(word)));
  return matches.length ? `<ul>${matches.map(entry => `<li><span><strong>${homeText(entry.displayName)}</strong>
    <small>${homeText(entry.description || '')}</small></span>${entry.firstSurface
      ? `<button type="button" data-open="${homeText(entry.firstSurface)}">Open</button>` : '<span>No application screen</span>'}</li>`).join('')}</ul>`
    : '<p role="status">No matching applications.</p>';
}
