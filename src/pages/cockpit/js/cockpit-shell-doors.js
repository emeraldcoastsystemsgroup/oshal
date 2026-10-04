/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | The cockpit header's operator doors (ADR-164 amendment shell lock): the logo's link to the plain cockpit, the Central assistant and Simple chat entries, and the Settings and Knowledge buttons. index.html draws every door CLOSED; the ribbon opens them only on an unlocked verdict, so a pending, unreadable, refused or locked profile never shows one. Before this the doors were drawn open and the lock tried to close them afterwards: while the profile read was pending (or hung) they stayed open, and Settings and Knowledge were never closed at all.
 */

/** Every operator door in the header carries this attribute; `data-shell-door="home"` is the logo. */
export const SHELL_DOOR_SELECTOR = '[data-shell-door]';

/** The header's dynamic Experiences entries and their label, built only for an unlocked shell. */
const EXPERIENCE_ENTRY_SELECTOR = '[data-experience], [data-experiences-label]';

/**
 * @description Open every door for an unlocked verdict (an operator, or a deployment without a
 * focused landing): the logo links to the plain cockpit again and the other doors are shown. This
 * is exactly what index.html drew before the doors were closed by default.
 * @param {ParentNode} [root] - The document (a seam for the unit spec).
 * @returns {void}
 */
export function openShellDoors(root = document) {
  for (const door of root.querySelectorAll(SHELL_DOOR_SELECTOR)) {
    if (door.dataset.shellDoor === 'home') door.setAttribute('href', door.dataset.doorHref || '/cockpit/');
    else door.hidden = false;
  }
}

/**
 * @description Keep every door closed for a locked shell: the logo returns to the landing
 * application (or links nowhere when the deployment named none), and every other door and the
 * Experiences entries stay hidden.
 * @param {string|null|undefined} landingApp - The deployment's focused landing application.
 * @param {string|undefined} label - The landing application's display name, for the logo's label.
 * @param {ParentNode} [root] - The document (a seam for the unit spec).
 * @returns {void}
 */
export function closeShellDoors(landingApp, label, root = document) {
  for (const door of root.querySelectorAll(SHELL_DOOR_SELECTOR)) {
    if (door.dataset.shellDoor !== 'home') { door.hidden = true; continue; }
    if (landingApp) {
      door.setAttribute('href', `/cockpit/?app=${encodeURIComponent(landingApp)}`);
      door.setAttribute('aria-label', `${label || landingApp} — home`);
    } else {
      door.removeAttribute('href');
    }
  }
  for (const entry of root.querySelectorAll(EXPERIENCE_ENTRY_SELECTOR)) entry.hidden = true;
}
