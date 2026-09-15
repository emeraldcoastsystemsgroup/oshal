/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Ambient Recall bridge: every voice row in the Jarvis Manage Voices panel gets an "Open profile" link to that voice's Ambient Recall profile page (/api/jarvis/ambient/person/?tab=people&profile=<id>). A self-contained sibling, so jarvis-speakers.js (close to the 800-code-line threshold) is not edited; it follows the panel's re-renders with a MutationObserver scoped to the panel root.
 */

/**
 * Manage Voices → Ambient Recall profile bridge.
 *
 * The Voice & Speakers panel (jarvis-speakers.js) renders one card per voice profile and tags each
 * with data-profile-id. The Ambient Recall surface (person-model.html, served at
 * /api/jarvis/ambient/person/) already opens one person on ?tab=people&profile=<id>. This companion
 * adds that link to every card, including the cards the panel rebuilds after a refresh, an
 * assignment, a merge or a settings change. It reads no data and makes no requests of its own.
 *
 * Public API: window.JarvisSpeakerProfileLinks.mount({ root, profileBase }) → { refresh, unmount };
 * window.JarvisSpeakerProfileLinks.profileUrl(profileId, profileBase) → string.
 */
(function (global) {
  'use strict';

  const PROFILE_BASE_DEFAULT = '/api/jarvis/ambient/person/';
  const CARD_SELECTOR = '.jarvis-speakers__profile-card[data-profile-id]';
  const LINK_ATTRIBUTE = 'data-js-profile-link';
  const STYLE_ID = 'jarvis-speaker-profile-links-styles';

  /**
   * @description Build the Ambient Recall deep link for one voice profile.
   * @param {string} profileId Owner-private voice profile id from the panel row.
   * @param {string} [profileBase] Path of the Ambient Recall surface.
   * @returns {string} The profile page URL with the People tab and that profile selected.
   */
  function profileUrl(profileId, profileBase) {
    const query = new URLSearchParams({ tab: 'people', profile: String(profileId) });
    return `${profileBase || PROFILE_BASE_DEFAULT}?${query.toString()}`;
  }

  /** @description Give the link the panel's button look without editing the panel's stylesheet. @returns {void} */
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = '.jarvis-speakers a.jarvis-speakers__profile-link{display:inline-flex;align-items:center;text-decoration:none;}'
      + '.jarvis-speakers a.jarvis-speakers__profile-link:hover{filter:brightness(1.12);}';
    document.head.appendChild(style);
  }

  /**
   * @description Build the "Open profile" link for one card. It opens a new tab so Jarvis keeps listening.
   * @param {HTMLElement} card A Voice & Speakers profile card.
   * @param {string} profileBase Path of the Ambient Recall surface.
   * @returns {HTMLAnchorElement} The link.
   */
  function buildLink(card, profileBase) {
    const name = (card.querySelector('h4')?.textContent || '').trim() || 'this voice';
    const link = document.createElement('a');
    link.className = 'jarvis-speakers__button jarvis-speakers__profile-link';
    link.setAttribute(LINK_ATTRIBUTE, '');
    link.href = profileUrl(card.dataset.profileId, profileBase);
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Open profile';
    link.setAttribute('aria-label', `Open the Ambient Recall profile for ${name}`);
    return link;
  }

  /**
   * @description Link one card once: first in its action row, or in a new action row for read-only cards.
   * @param {HTMLElement} card A Voice & Speakers profile card.
   * @param {string} profileBase Path of the Ambient Recall surface.
   * @returns {boolean} True when a link was added.
   */
  function linkCard(card, profileBase) {
    if (card.querySelector(`[${LINK_ATTRIBUTE}]`)) return false;
    let actions = card.querySelector('.jarvis-speakers__profile-actions');
    if (!actions) {
      actions = document.createElement('div');
      actions.className = 'jarvis-speakers__profile-actions';
      card.appendChild(actions);
    }
    actions.insertBefore(buildLink(card, profileBase), actions.firstChild);
    return true;
  }

  /** One bridge bound to one Voice & Speakers panel root. */
  class ProfileLinks {
    /** @param {{root?: HTMLElement, profileBase?: string}} options Mount options. */
    constructor(options) {
      const settings = options || {};
      this.root = settings.root || document.querySelector('.jarvis-speakers') || document.body;
      this.profileBase = settings.profileBase || PROFILE_BASE_DEFAULT;
      this.observer = null;
    }

    /** @description Link the current rows and every row the panel renders later. @returns {ProfileLinks} this. */
    mount() {
      injectStyles();
      this.refresh();
      this.observer = new MutationObserver(() => this.refresh());
      this.observer.observe(this.root, { childList: true, subtree: true });
      return this;
    }

    /** @description Link any row that has no profile link yet. @returns {number} Links added. */
    refresh() {
      let added = 0;
      for (const card of this.root.querySelectorAll(CARD_SELECTOR)) if (linkCard(card, this.profileBase)) added += 1;
      return added;
    }

    /** @description Stop following the panel; links already added stay. @returns {void} */
    unmount() {
      this.observer?.disconnect();
      this.observer = null;
    }
  }

  let active = null;

  /**
   * @description Mount the bridge on the Voice & Speakers panel, replacing any earlier mount.
   * @param {{root?: HTMLElement, profileBase?: string}} options Panel root and Ambient Recall path.
   * @returns {ProfileLinks} Lifecycle controller.
   */
  function mount(options) {
    active?.unmount();
    active = new ProfileLinks(options).mount();
    return active;
  }

  global.JarvisSpeakerProfileLinks = Object.freeze({ mount, profileUrl });
})(window);
