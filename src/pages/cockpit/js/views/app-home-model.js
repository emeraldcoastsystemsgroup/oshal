/**
 * CHANGE LOG
 * SEQ | AUTHOR | DESCRIPTION
 * 1 | Codex | Stable metric selection and deterministic highlights shared by Home and its tests.
 */

/** @description Apply saved ordering; new entries append in their original order.
 * @param {Array} values Entries. @param {Array} order Saved ids. @param {Function} key Id accessor.
 * @returns {Array} Ordered copy. */
export function ordered(values, order = [], key = x => x.id) {
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...values].sort((a, b) => (rank.get(key(a)) ?? order.length) - (rank.get(key(b)) ?? order.length));
}

/** @description Move one id without discarding new or temporarily missing ids.
 * @param {Array} ids Current order. @param {string} id Item. @param {number} delta Direction.
 * @returns {Array} New order. */
export function move(ids, id, delta) {
  const result = [...ids];
  const at = result.indexOf(id), next = at + delta;
  if (at >= 0 && next >= 0 && next < result.length) [result[at], result[next]] = [result[next], result[at]];
  return result;
}

/** @description Normalize a selectable catalog, rejecting duplicates and unstable ids.
 * @param {Array} rows Untrusted package rows. @param {string} app Owning package.
 * @returns {Array} Bounded, namespaced facts. */
export function catalog(rows, app) {
  const seen = new Set();
  const duplicates = new Set();
  for (const row of rows.slice(0, 24)) {
    if (seen.has(row?.id)) duplicates.add(row?.id);
    seen.add(row?.id);
  }
  return rows.slice(0, 24).filter(row => row && typeof row.id === 'string'
    && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(row.id) && !duplicates.has(row.id)
    && typeof row.label === 'string' && typeof row.value === 'string').map(row => ({
      id: `${app}/${row.id}`, label: row.label.slice(0, 24), value: row.value.slice(0, 16),
      tone: row.tone === 'warn' || row.tone === 'good' ? row.tone : 'neutral',
      defaultVisible: row.defaultVisible !== false,
    }));
}

/** @description Apply presentation choices without changing the source facts.
 * @param {object} data Loaded card. @param {object} preference Card choices.
 * @returns {object} Visible card data. */
export function selected(data, preference = {}) {
  return { ...data,
    tiles: ordered(data.tiles, preference.metricOrder).filter(t => t.id
      ? !(preference.hiddenMetrics || []).includes(t.id) && (t.defaultVisible !== false || (preference.shownMetrics || []).includes(t.id))
      : true),
    items: preference.showItems === false ? [] : data.items.filter(i => !i.metricId || !(preference.hiddenMetrics || []).includes(i.metricId))
      .map(i => preference.showActions === false ? { ...i, integration: undefined, integrationNote: undefined } : i),
    open: preference.showSetup === false ? [] : data.open,
    total: preference.showSetup === false ? 0 : data.total,
  };
}

/** @description Choose one traceable highlight per visible app, warnings before ordinary updates.
 * @param {Array} entries Visible app entries. @param {Map} cards Loaded facts. @param {object} preferences Display choices.
 * @returns {Array} Ranked highlights; no new facts or cross-domain sums. */
export function highlights(entries, cards, preferences) {
  return entries.flatMap(entry => {
    const raw = cards.get(entry.name);
    if (!raw) return [];
    const data = selected(raw, preferences.cards?.[entry.name]);
    const warning = data.tiles.find(t => t.tone === 'warn');
    const item = data.items.find(i => i.tone === 'warn');
    const setup = data.open[0];
    const ordinary = data.items.find(i => i.highlight === true);
    const choice = warning ? { text: `${warning.label}: ${warning.value}`, tone: 'warn' }
      : item || (setup ? { text: setup.detail || setup.label, tone: 'warn', fix: setup.fix } : ordinary);
    return choice ? [{ ...choice, app: entry.name, displayName: entry.displayName, fix: choice.fix || entry.firstSurface }] : [];
  }).sort((a, b) => Number(b.tone === 'warn') - Number(a.tone === 'warn'));
}
