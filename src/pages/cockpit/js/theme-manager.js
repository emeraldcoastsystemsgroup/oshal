/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documented and hardened cockpit theme cycling so header theme audits can assert persisted operator-visible behavior
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Expanded cockpit to the full shared swarm theme catalog so shell, settings, and embedded workspaces stay visually aligned
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | applyTransient(theme) — apply a per-app skin (from the focused app's manifest) for this page-load WITHOUT persisting it, so each app opens in its own look while the operator's saved global theme is preserved for plain /cockpit visits.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Add selectable Workspace as the no-saved-choice default while preserving saved preferences, invalid-choice fallback and transient application themes.
 */

/**
 * @description Canonical, ordered list of every cockpit theme id the shell supports; drives validation and the theme cycle order so shell, settings, and embedded workspaces stay visually aligned.
 */
export const COCKPIT_THEMES = ['midnight', 'daylight', 'ocean', 'sakura', 'forest', 'gray', 'black', 'light-blue', 'aurora', 'graphite', 'amber', 'workspace'];

/**
 * @description Validate a requested theme id against the supported catalog, falling back to the default 'midnight' so callers can never apply an unknown theme.
 * @param {string} theme - Requested cockpit theme id to validate.
 * @returns {string} The theme id if supported, otherwise 'midnight'.
 */
export function resolveCockpitTheme(theme) {
  return COCKPIT_THEMES.includes(theme) ? theme : 'midnight';
}

/** @description Keep both the legacy picker and current Settings buttons aligned with the active shell theme. */
function syncThemePickers(theme) {
  document.querySelectorAll('.theme-option, #settingsThemePicker button').forEach(button => {
    const active = button.dataset.theme === theme;
    button.classList.toggle('active', active);
    if (button.tagName === 'BUTTON') button.setAttribute('aria-pressed', String(active));
  });
}

/**
 * @description Manage the cockpit shell theme list, persistence, and active-state sync.
 */
export class ThemeManager {
  /**
   * @description Create a theme manager with the supported cockpit themes and restore the saved preference.
   */
  constructor() {
    this.themes = COCKPIT_THEMES;
    const saved = localStorage.getItem('cockpit-theme');
    this.current = resolveCockpitTheme(saved === null ? 'workspace' : saved);
    this.apply(this.current);
  }

  /**
   * @description Apply one supported cockpit theme and persist it for future reloads.
   * @param {string} theme - Requested cockpit theme id.
   * @returns {string} Applied theme id after validation.
   */
  apply(theme) {
    const nextTheme = resolveCockpitTheme(theme);
    document.documentElement.setAttribute('data-theme', nextTheme);
    this.current = nextTheme;
    localStorage.setItem('cockpit-theme', nextTheme);
    syncThemePickers(nextTheme);
    return nextTheme;
  }

  /**
   * @description Apply a theme for the current page-load only — set on the document
   * (so embedded surfaces inheriting via the data-theme observer follow) and sync the
   * picker, but DO NOT persist. Used for per-app skins from a focused app's manifest:
   * the app looks distinct, yet a plain /cockpit visit still restores the operator's
   * saved global theme.
   *
   * ADR-085: a store-installed app may BUNDLE its skin instead of registering it in
   * the core catalog — the profile then carries cssUrl (served from the app's own
   * package by /api/swarm/apps/:name/theme.css). We inject that stylesheet once and
   * apply the app's data-theme id even though it isn't in `this.themes`. Unknown
   * themes with no cssUrl still fall back to the operator's persisted choice.
   * @param {string} theme - Requested per-app cockpit theme id.
   * @param {string} [cssUrl] - Package-bundled skin stylesheet (auth-gated app route).
   * @returns {string} Applied theme id after validation.
   */
  applyTransient(theme, cssUrl) {
    if (!this.themes.includes(theme)) {
      if (!cssUrl) return this.current;
      // Package-bundled skin: (re)inject its stylesheet, then trust the app's id.
      let link = document.getElementById('app-package-theme-css');
      if (!link) {
        link = document.createElement('link');
        link.id = 'app-package-theme-css';
        link.rel = 'stylesheet';
        document.head.appendChild(link);
      }
      if (link.getAttribute('href') !== cssUrl) link.setAttribute('href', cssUrl);
    }
    document.documentElement.setAttribute('data-theme', theme);
    this.current = theme;
    syncThemePickers(theme);
    return theme;
  }

  /**
   * @description Move to the next configured cockpit theme in cycle order.
   * @returns {string} Newly applied theme id.
   */
  cycle() {
    const idx = this.themes.indexOf(this.current);
    const next = this.themes[(idx + 1) % this.themes.length];
    return this.apply(next);
  }

  /**
   * @description Read the currently active cockpit theme id.
   * @returns {string} Active cockpit theme id.
   */
  getCurrent() {
    return this.current;
  }
}
