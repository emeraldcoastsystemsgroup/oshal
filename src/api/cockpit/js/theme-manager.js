/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * ThemeManager — Hot-swap theme system with 5 themes
 * Persists choice to localStorage, cycles on button click
 */
export class ThemeManager {
  /**
   * @description Initializes the theme manager by restoring the previously
   * chosen theme from persistent storage (falling back to the default) so the
   * UI opens in the user's last-used appearance.
   */
  constructor() {
    this.themes = ['midnight', 'daylight', 'ocean', 'sakura', 'forest'];
    this.current = localStorage.getItem('cockpit-theme') || 'midnight';
    this.apply(this.current);
  }

  /**
   * @description Activates a theme across the app: guards against unknown values,
   * persists the selection so it survives reloads, and keeps the theme-picker
   * controls visually in sync with the active choice.
   * @param {string} theme The theme identifier to apply.
   */
  apply(theme) {
    if (!this.themes.includes(theme)) theme = 'midnight';
    document.documentElement.setAttribute('data-theme', theme);
    this.current = theme;
    localStorage.setItem('cockpit-theme', theme);
    // Sync theme picker buttons
    document.querySelectorAll('.theme-option').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === theme);
    });
  }

  /**
   * @description Advances to the next theme in the rotation, wrapping back to the
   * start, to support a single-button cycle-through-themes interaction.
   */
  cycle() {
    const idx = this.themes.indexOf(this.current);
    const next = this.themes[(idx + 1) % this.themes.length];
    this.apply(next);
  }

  /**
   * @description Exposes the currently active theme so other UI code can read
   * the selection without reaching into localStorage directly.
   * @returns {string} The identifier of the active theme.
   */
  getCurrent() {
    return this.current;
  }
}
