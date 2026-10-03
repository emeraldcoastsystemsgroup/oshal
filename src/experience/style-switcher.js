/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Skin switcher shared by every experience page: eight experience skins plus the twelve canonical cockpit themes, remembered per layout on this device only (a skin chosen for Studio never repaints Jarvis), applied through the same data-skin/data-theme hooks the cockpit themes use. Appearance never carries identity, access or installation authority.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | An explicit skin choice also writes the saved cockpit appearance (`cockpit-theme`), so opening an application in the cockpit or standalone continues in the chosen skin; layout defaults still never write it.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Skin colours match the aligned tokens in skins.css (playful violet, professional teal) so the switcher swatches show the palette the page paints
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Discover and host installed experience packages through current authorization, preserving member visibility and supported assets.
 */
(() => {
  'use strict';

  const ALL_SKINS = [
    { group: 'Experience skins', items: [
      { id: 'studio', name: 'Studio · Graphite & Mint', mode: 'dark', color: '#b9dfb2' },
      { id: 'jarvis', name: 'Jarvis · Parchment & Ember', mode: 'light', color: '#b94e2d' },
      { id: 'orbit', name: 'Orbit · Arctic & Cobalt', mode: 'light', color: '#3568d4' },
      { id: 'commons', name: 'Commons · Aubergine & Lilac', mode: 'light', color: '#725191' },
      { id: 'nexus', name: 'Nexus · Luminous Cyan', mode: 'dark', color: '#9bdfd0' },
      { id: 'family', name: 'Family · Cozy Sage', mode: 'light', color: '#3e6854', alias: 'cozy' },
      { id: 'classroom', name: 'Classroom · Playful Violet', mode: 'light', color: '#6c4f97', alias: 'playful' },
      { id: 'company', name: 'Company · Slate & Teal', mode: 'light', color: '#1f6b75', alias: 'professional' }
    ] },
    { group: 'Cockpit themes', items: [
      { id: 'workspace', name: 'Workspace · Neutral Slate', mode: 'light', color: '#2563eb' },
      { id: 'midnight', name: 'Midnight · Deep Navy', mode: 'dark', color: '#38bdf8' },
      { id: 'daylight', name: 'Daylight · High Contrast', mode: 'light', color: '#0284c7' },
      { id: 'ocean', name: 'Ocean · Marine Blue', mode: 'dark', color: '#64ffda' },
      { id: 'sakura', name: 'Sakura · Rose & Coral', mode: 'light', color: '#e53e3e' },
      { id: 'forest', name: 'Forest · Emerald Pine', mode: 'dark', color: '#48bb78' },
      { id: 'gray', name: 'Gray · Monochrome Soft', mode: 'light', color: '#4a5568' },
      { id: 'black', name: 'Black · OLED Minimal', mode: 'dark', color: '#ffffff' },
      { id: 'light-blue', name: 'Light Blue · Sky Daylight', mode: 'light', color: '#0ea5e9' },
      { id: 'aurora', name: 'Aurora · Northern Violet', mode: 'dark', color: '#a855f7' },
      { id: 'graphite', name: 'Graphite · Technical Charcoal', mode: 'dark', color: '#b0bec5' },
      { id: 'amber', name: 'Amber · Warm Phosphor', mode: 'dark', color: '#f59e0b' }
    ] }
  ];
  const FLAT_SKINS = ALL_SKINS.flatMap(g => g.items);
  const find = id => FLAT_SKINS.find(s => s.id === id || s.alias === id) || null;
  const PALETTES = [...FLAT_SKINS];
  // Package discovery owns the offered choices; the palette definitions also support preview styling.
  ALL_SKINS[0].items.splice(0, ALL_SKINS[0].items.length, ...PALETTES.filter(s => s.id === 'nexus'));

  window.addEventListener('oshal-experiences-ready', event => {
    const registered = new Map();
    for (const experience of event.detail || []) {
      const known = PALETTES.find(s => s.id === experience.skin);
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(experience.skin)) continue;
      if (registered.has(experience.skin)) continue;
      registered.set(experience.skin, { ...(known || { mode: 'light', color: '#64748b' }),
        id: experience.skin, name: experience.label, cssUrl: experience.skinCssUrl || '' });
    }
    // Nexus remains a core assistant outside the seven-package migration.
    const nexus = find('nexus'); if (nexus) registered.set('nexus', nexus);
    ALL_SKINS[0].items.splice(0, ALL_SKINS[0].items.length, ...registered.values());
    FLAT_SKINS.splice(0, FLAT_SKINS.length, ...ALL_SKINS.flatMap(group => group.items));
    document.querySelectorAll('#universal-skin-picker').forEach(picker => {
      const container = document.createElement('span'); container.innerHTML = buildSelectMarkup(currentSkin());
      picker.replaceWith(container.querySelector('select'));
    });
    init();
  });

  /** @description The layout this page belongs to, which scopes the remembered skin. */
  function scope() {
    const preset = new URLSearchParams(location.search).get('preset');
    return preset || document.body.dataset.layout || document.body.dataset.page || 'portal';
  }
  const storageKey = () => 'oshal-experience:skin:' + scope();
  const defaultSkin = () => document.body.dataset.defaultSkin || document.body.dataset.layout || null;

  function getStoredSkin() {
    try {
      const fromUrl = new URLSearchParams(location.search).get('skin');
      if (fromUrl && find(fromUrl)) return find(fromUrl).id;
      const saved = localStorage.getItem(storageKey());
      if (saved && find(saved)) return find(saved).id;
    } catch (_) { /* storage unavailable: use the layout default */ }
    return null;
  }
  const currentSkin = () => document.body.dataset.skin || getStoredSkin() || defaultSkin() || 'workspace';

  /** @description Paint one skin on this page and remember it for this layout on this device. */
  function applySkin(skinId, save = true) {
    const def = find(skinId); if (!def) return;
    let css = document.getElementById('app-package-theme-css');
    if (def.cssUrl) {
      if (!css) { css = document.createElement('link'); css.id = 'app-package-theme-css'; css.rel = 'stylesheet'; document.head.append(css); }
      css.href = def.cssUrl;
    } else if (css) css.remove();
    document.body.dataset.skin = def.id;
    document.body.dataset.theme = def.id;
    document.documentElement.dataset.theme = def.id;
    document.documentElement.style.colorScheme = def.mode;
    const experience = document.querySelector('.experience');
    if (experience) experience.dataset.skin = def.alias || def.id;
    if (save) {
      // The explicit choice is remembered for this layout AND becomes the saved cockpit appearance, so the
      // cockpit and every standalone surface reading `cockpit-theme` wear the same skin (ADR-164 D7/D9).
      try { localStorage.setItem(storageKey(), def.id); localStorage.setItem('cockpit-theme', def.id); } catch (_) { /* device storage unavailable */ }
    }
    document.querySelectorAll('#universal-skin-picker').forEach(p => { if (p.value !== def.id) p.value = def.id; });
    document.querySelectorAll('[data-swatch-skin]').forEach(btn => {
      const match = btn.dataset.swatchSkin === def.id;
      btn.classList.toggle('active', match); btn.setAttribute('aria-pressed', String(match));
    });
    window.dispatchEvent(new CustomEvent('oshal-skin-change', { detail: { skin: def.id, def } }));
  }

  function buildSelectMarkup(current) {
    const selected = current || currentSkin();
    const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    return `<label class="screenreader" for="universal-skin-picker">Visual style</label><select id="universal-skin-picker" class="layout-picker" title="Skin for this layout, remembered on this device">${ALL_SKINS.map(group => `<optgroup label="${escape(group.group)}">${group.items.map(s => `<option value="${s.id}"${selected === s.id ? ' selected' : ''}>${escape(s.name)}</option>`).join('')}</optgroup>`).join('')}</select>`;
  }

  function init() {
    const stored = getStoredSkin();
    if (stored) applySkin(stored, false);
    else if (defaultSkin() && find(defaultSkin())) applySkin(defaultSkin(), false);
    document.querySelectorAll('#universal-skin-picker').forEach(p => {
      if (p.dataset.skinBound) return;
      p.dataset.skinBound = 'true'; p.addEventListener('change', e => applySkin(e.target.value));
    });
    document.querySelectorAll('[data-swatch-skin]').forEach(btn => btn.addEventListener('click', () => applySkin(btn.dataset.swatchSkin)));
  }

  window.OSHAL_STYLE_SWITCHER = { ALL_SKINS, FLAT_SKINS, applySkin, getStoredSkin, currentSkin, buildSelectMarkup, init };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
