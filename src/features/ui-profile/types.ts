/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial UIProfile schema — app-packaging overlay on top of the framework ribbon
 */

/**
 * A ribbon item declared by a profile. Either a string referencing a
 * hardcoded cockpit view id (reuses its icon/label/section), or a full
 * object declaring an ad-hoc ribbon button (e.g. a link to an external page).
 */
export type UIProfileRibbonItem =
  | string
  | {
      id: string;
      icon?: string;
      label?: string;
      /** `home` pins the item to the top (the front-door surface, e.g. Jarvis);
       *  `top` items flow into the scrollable middle and may carry a `group`;
       *  `bottom` pins the item to the base tray (tickets/calendar/messages/settings). */
      section?: 'home' | 'top' | 'bottom';
      /** Optional group label for a `top` item. Consecutive items sharing a group
       *  render under one header in the scrollable middle of the ribbon. */
      group?: string;
      /** If set, clicking the ribbon button navigates the window here instead of switching cockpit views. */
      href?: string;
      /** If set (and the id is `tool-`-prefixed), the cockpit embeds this URL as an iframe tool view
       *  in the content area instead of a full-page nav. Mirrors the swarm-app manifest static items. */
      toolUi?: { iframeUrl: string; sidebarLabel: string };
    };

/**
 * Rules controlling which bot-registered dynamic tools appear in the ribbon.
 */
export interface UIProfileDynamicTools {
  /** Glob patterns matched against dynamic tool names. `["*"]` allows all. If omitted, no dynamic tools render. */
  allow?: string[];
  /** Override section assignment for every dynamic tool the profile admits. */
  section?: 'top' | 'bottom';
  /** Group label applied to every admitted `top`-section dynamic tool, so e.g. the
   *  Little Monsters per-class icons render under the Little Monsters group header. */
  group?: string;
}

/**
 * A UI profile is the overlay that turns the generic OSHAL framework into
 * a packaged application (e.g. Little Monsters). The framework and its bots
 * keep running underneath; the profile only shapes which surfaces are visible.
 */
export interface UIProfile {
  name: string;
  displayName: string;
  description?: string;
  ribbon: {
    items: UIProfileRibbonItem[];
    dynamicTools?: UIProfileDynamicTools;
  };
  /** Ribbon item id to activate on initial load. */
  defaultView?: string;
}
