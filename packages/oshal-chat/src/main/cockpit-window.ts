/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Full-Jarvis mode: dedicated window that loads the swarm-hosted cockpit (/cockpit/?app=jarvis) under the node's verified OIDC session, so a satellite presents the complete Jarvis surface (task history, super-admin gating, dynamic visual responses) without duplicating any controller logic locally
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Auth probe + window now use cockpitBaseUrl (falls back to controlPlaneUrl): with tunnel-hosted OIDC the IdP sets the session cookie on the PUBLIC origin only, so a LAN-pointed window could never authenticate
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Native integration (operator feedback: white Windows title bar made it a "pretend application"): hidden title bar with midnight-colored overlay controls, no menu bar, and injected CSS makes the cockpit's own header the drag handle
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | titleBarStyle:'hidden'+overlay did NOT hide the frame on the satellite's Electron/Win build (verified live). Switch to frame:false (guaranteed borderless) + inject a draggable strip and an app-colored close button; double-click the strip maximizes (native drag-region behavior)
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | window.open children get frame:false too; fetchAuthenticatedUser retries a few times so a transient api blip doesn't falsely force the sign-in window
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Single-window sign-in: openFullJarvis just loads the cockpit URL and lets the OIDC redirect happen in-window (returnTo preserved). Dropped the pre-auth check + separate sign-in window (it was stranding the user in a small framed popup showing the cockpit).
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | autoplayPolicy:'no-user-gesture-required' so Jarvis's async server-TTS audio actually plays (Chromium blocks autoplay by default).
 * 10 | maintainer@emeraldcoastsystemsgroup.com  | The window the operator was actually stuck in was the SIGN-IN window (main.ts signIn): 520x680, frame:false, modal:true with the console as parent — and it never got the injected chrome, so it had no drag region and no close button while ALSO blocking input to its parent, which is why neither window responded. At 520px wide the cockpit renders its mobile layout, so after the OIDC redirect it reads as "a Jarvis window without a container", and it only closes when GET /api/user returns a sub — otherwise it sits there indefinitely. Extracted attachFramelessControls() so every frameless window showing swarm pages gets the same pill; the sign-in window takes the two-button variant (no Config, since a modal blocks the parent it would raise).
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Operator report: with the node console raised over an open cockpit, NEITHER window could be moved or closed. Both are frame:false, and the cockpit window's only controls were CSS+a button injected into the SWARM-SERVED page: the drag handle was `header.header-bar`, which `body.zen-mode` (the header's own arrows-out button, persisted in sessionStorage) sets to display:none — so one click permanently removed the drag region, leaving an 8px invisible strip, and the lone close button was a 30x26 near-transparent glyph sitting in the same row as the cockpit's own header icons. Replaced with an always-present control pill (its body is the drag handle, so a window is movable even with every page chrome hidden) carrying Config / minimize / close. Minimize and Config reach the main process WITHOUT a preload — the remote page keeps zero Node access — by opening an `oshal:` URL that setWindowOpenHandler intercepts and denies. Guard: tests/unit/node-window-controls.spec.ts.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Per-app windows (openCockpitApp): any cockpit app (?app=<name>) opens as its OWN frameless window keyed by name — open/focus semantics per app, several apps side by side, each alt-tabbable with its app title. createCockpitWindow generalized to build-and-return (title + close callback params); openFullJarvis keeps its dedicated window + the native-wake delivery contract unchanged.
 */

import { BrowserWindow, type BrowserWindowConstructorOptions, type WebContents } from 'electron';
import { buildCockpitAppPath, prettifyAppTitle } from './app-launch';
import type { ConfigStore } from './config';

/** Default cockpit path — the Jarvis-shaped ribbon. `/cockpit/` gives the full framework ribbon. */
export const DEFAULT_COCKPIT_PATH = '/cockpit/?app=jarvis';

let cockpitWin: BrowserWindow | null = null;
/** One window per launched cockpit app, keyed by sanitized app name (open = focus). */
const appWindows = new Map<string, BrowserWindow>();
const NATIVE_WAKE_TTL_MS = 15_000;
let pendingNativeWake: { phrase: string; detectedAt: string; expiresAt: number } | null = null;

/**
 * Shell-side CSS injected into the borderless cockpit page (server CSS untouched):
 * the cockpit's own header is the window drag handle (its buttons stay clickable),
 * a thin top strip keeps headerless pages (e.g. /api/jarvis/) draggable, and both
 * leave room at the top-right for the injected close button.
 */
export const SHELL_INTEGRATION_CSS = `
header.header-bar { -webkit-app-region: drag; padding-right: 132px; }
header.header-bar button, header.header-bar a, header.header-bar input, header.header-bar select { -webkit-app-region: no-drag; }
body::after { content: ''; position: fixed; top: 0; left: 0; right: 0; height: 8px; z-index: 2147483646; -webkit-app-region: drag; }
`;

/** URLs the injected controls "open" so the main process can act. Never navigated to. */
export const CONTROL_URL_PREFIX = 'oshal:';
/** Raise the node console. */
export const CONTROL_SHOW_CONSOLE = 'oshal:console';
/** Minimize this cockpit window. */
export const CONTROL_MINIMIZE = 'oshal:minimize';

/**
 * Injected into the page context: a borderless window has no native controls, so the
 * shell supplies its own. This is a PILL, not a lone button, and the pill's own body is
 * a drag region — that is the part that matters. The page's header was previously the
 * only real drag handle, and `body.zen-mode` hides it (and remembers that in
 * sessionStorage), so a single click on the cockpit's arrows-out button left a window
 * that could not be moved at all. The pill is injected by the shell, so no page state
 * can hide it.
 *
 * Minimize and Config need the main process. Rather than give a swarm-served page a
 * preload (it deliberately has none), they open an `oshal:` URL that
 * setWindowOpenHandler intercepts and denies — the navigation never happens.
 *
 * Guarded so re-injection on navigation never stacks duplicates.
 */
export function shellControlsJs(withConsoleButton: boolean): string {
  return `(() => {
  if (document.getElementById('oshal-wincontrols')) return;
  const pill = document.createElement('div');
  pill.id = 'oshal-wincontrols';
  Object.assign(pill.style, {
    position: 'fixed', top: '5px', right: '8px', zIndex: '2147483647',
    display: 'flex', alignItems: 'center', gap: '2px', padding: '3px 4px',
    borderRadius: '9px', border: '1px solid rgba(150,170,220,0.22)',
    background: 'rgba(14,18,34,0.82)', backdropFilter: 'blur(6px)',
    font: '12px system-ui, sans-serif',
    WebkitAppRegion: 'drag',
  });
  const mk = (label, title, onClick, hover) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    Object.assign(b.style, {
      height: '22px', padding: label.length > 2 ? '0 9px' : '0 7px',
      border: '0', borderRadius: '6px', cursor: 'pointer',
      font: 'inherit', color: '#dfe6fb', background: 'transparent',
      WebkitAppRegion: 'no-drag',
    });
    b.onmouseenter = () => { b.style.background = hover || 'rgba(150,170,220,0.24)'; };
    b.onmouseleave = () => { b.style.background = 'transparent'; };
    b.onclick = onClick;
    pill.appendChild(b);
    return b;
  };
  ${withConsoleButton
    ? `mk('\\u2699 Config', 'Show the OSHAL Node console', () => window.open('${CONTROL_SHOW_CONSOLE}'));`
    : ''}
  mk('\\u2500', 'Minimize', () => window.open('${CONTROL_MINIMIZE}'));
  mk('\\u2715', 'Close this window', () => window.close(), '#c0392b');
  document.body.appendChild(pill);
})();`;
}

/** Attach the frameless-shell CSS + control pill to a webContents, re-run on each navigation. */
function injectShellChrome(contents: WebContents, withConsoleButton = true): void {
  const controls = shellControlsJs(withConsoleButton);
  contents.on('did-finish-load', () => {
    void contents.insertCSS(SHELL_INTEGRATION_CSS);
    void contents.executeJavaScript(controls).catch(() => undefined);
  });
}

/**
 * @description Gives ANY frameless window showing swarm pages its window controls: the
 *   injected pill, and the handler that turns the pill's `oshal:` commands into main-process
 *   calls without ever navigating. Every frameless window this app opens must go through
 *   here — the sign-in window did not, and being frameless AND modal it left the whole app
 *   unresponsive with no visible way out.
 * @param win The frameless window.
 * @param opts hooks for the Config button; withConsoleButton=false drops it (a modal blocks
 *   the parent it would raise); childOptions applies to window.open children.
 * @returns void
 */
export function attachFramelessControls(
  win: BrowserWindow,
  opts: {
    hooks?: CockpitWindowHooks;
    withConsoleButton?: boolean;
    childOptions?: BrowserWindowConstructorOptions;
  } = {},
): void {
  const withConsoleButton = opts.withConsoleButton !== false;
  injectShellChrome(win.webContents, withConsoleButton);
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    // The injected pill "opens" these to reach the main process without a preload. They are
    // commands, never navigations, so every one of them is denied.
    if (target.startsWith(CONTROL_URL_PREFIX)) {
      if (target === CONTROL_SHOW_CONSOLE) opts.hooks?.onShowConsole?.();
      else if (target === CONTROL_MINIMIZE) win.minimize();
      return { action: 'deny' };
    }
    return opts.childOptions
      ? { action: 'allow', overrideBrowserWindowOptions: opts.childOptions }
      : { action: 'allow' };
  });
  win.webContents.on('did-create-window', (child) => injectShellChrome(child.webContents, withConsoleButton));
}

/**
 * Delivers a native wake signal only into the real Jarvis frame. The signal contains
 * no audio or command transcript and expires quickly; Jarvis then uses its existing
 * microphone + authenticated `/api/jarvis/ask` path for the actual turn.
 */
async function deliverPendingNativeWake(): Promise<boolean> {
  const wake = pendingNativeWake;
  const window = cockpitWin;
  if (!wake || !window || window.isDestroyed()) return false;
  if (wake.expiresAt < Date.now()) {
    pendingNativeWake = null;
    return false;
  }

  const code = `(() => {
    if (window.__OSHAL_JARVIS_NATIVE_WAKE_READY__ !== true) return false;
    window.dispatchEvent(new CustomEvent('oshal:native-wake', { detail: ${JSON.stringify({
      phrase: wake.phrase,
      detectedAt: wake.detectedAt,
    })} }));
    return true;
  })()`;
  const frames = window.webContents.mainFrame.framesInSubtree.filter((frame) => {
    try { return new URL(frame.url).pathname.startsWith('/api/jarvis'); } catch { return false; }
  });
  for (const frame of frames) {
    try {
      if (await frame.executeJavaScript(code, true)) {
        pendingNativeWake = null;
        return true;
      }
    } catch {
      // The frame may be navigating between OIDC and Jarvis; the next load retries.
    }
  }
  return false;
}

/** Optional lifecycle hooks so the caller can e.g. hide the orb while the cockpit is up. */
export interface CockpitWindowHooks {
  onOpen?: () => void;
  onClosed?: () => void;
  /** Raise the node console — the injected pill's "Config" button. */
  onShowConsole?: () => void;
}

/**
 * @description Creates a cockpit window and returns it. The remote page gets NO preload
 * and no Node access — it is the swarm's own web UI in a plain sandboxed browser window
 * that shares the default session (and therefore the OIDC cookie) with sign-in.
 * window.open children are allowed with the same hardened defaults so connector
 * OAuth popups keep their cookie jar and complete in-app, exactly as in a browser.
 * @param url Absolute cockpit URL to load.
 * @param title Window title (shows in Alt-Tab / taskbar until the page sets its own).
 * @param hooks Lifecycle callbacks fired on open and on close.
 * @param onClosed Owner bookkeeping run before hooks.onClosed (clear the slot that held this window).
 * @returns The created window.
 */
function createCockpitWindow(url: string, title: string, hooks: CockpitWindowHooks | undefined, onClosed: () => void): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title,
    backgroundColor: '#0b1020',
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Jarvis speaks by playing server-synthesized audio that arrives asynchronously
      // (no user gesture on the frame); Chromium would otherwise block that autoplay
      // and the neural voice would silently never play.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.webContents.on('did-frame-finish-load', () => { void deliverPendingNativeWake(); });
  win.webContents.on('did-finish-load', () => { void deliverPendingNativeWake(); });
  // window.open children (the cockpit opens its app surfaces / OAuth popups as
  // popups) must ALSO be frameless + carry the close button, or they show the
  // default white Windows title bar — which is the frame the operator still saw.
  attachFramelessControls(win, {
    hooks,
    childOptions: {
      frame: false,
      backgroundColor: '#0b1020',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    },
  });
  win.on('closed', () => {
    onClosed();
    hooks?.onClosed?.();
  });
  void win.loadURL(url);
  hooks?.onOpen?.();
  return win;
}

/**
 * @description Opens (or focuses) the full Jarvis cockpit for this node as a single
 * frameless window that loads the swarm-hosted cockpit URL directly. When the OIDC
 * session is missing/expired, the cockpit route redirects to /login → the IdP →
 * back to the cockpit ALL IN THIS ONE WINDOW (express-openid-connect preserves the
 * originally-requested URL as returnTo), so there is no separate sign-in window and
 * no handoff. All Jarvis brains stay server-side; this window is purely the surface.
 * @param store Persisted node configuration (control-plane URL + cockpit path).
 * @param hooks Lifecycle callbacks (e.g. hide the orb console while the cockpit is up).
 * @returns ok=true when the window is showing; otherwise an operator-readable error.
 */
export async function openFullJarvis(
  store: ConfigStore,
  hooks?: CockpitWindowHooks,
): Promise<{ ok: boolean; error?: string }> {
  const config = store.load();
  const base = (config.cockpitBaseUrl || config.controlPlaneUrl).replace(/\/+$/, '');
  if (!base) return { ok: false, error: 'Set the control-plane URL first.' };

  if (cockpitWin && !cockpitWin.isDestroyed()) {
    cockpitWin.focus();
    return { ok: true };
  }

  const path = config.cockpitPath || DEFAULT_COCKPIT_PATH;
  cockpitWin = createCockpitWindow(
    `${base}${path.startsWith('/') ? path : `/${path}`}`,
    'OSHAL — Jarvis',
    hooks,
    () => { cockpitWin = null; },
  );
  return { ok: true };
}

/**
 * @description Opens (or focuses) a NAMED cockpit app (?app=<name>) as its own frameless
 * window — this is what makes each app a real desktop application: launched from its own
 * shortcut (--app=<name>), alt-tabbable under its own title, several apps side by side.
 * Same OIDC session, same shell chrome, same in-window login flow as full Jarvis; only
 * the URL (and therefore the manifest the cockpit shapes itself from) differs.
 * @param store Persisted node configuration (control-plane / cockpit base URL).
 * @param appName A sanitized cockpit app name (callers validate via sanitizeCockpitAppName).
 * @param hooks Lifecycle callbacks (e.g. hide the orb console while a surface is up).
 * @returns ok=true when the window is showing; otherwise an operator-readable error.
 */
export async function openCockpitApp(
  store: ConfigStore,
  appName: string,
  hooks?: CockpitWindowHooks,
): Promise<{ ok: boolean; error?: string }> {
  const config = store.load();
  const base = (config.cockpitBaseUrl || config.controlPlaneUrl).replace(/\/+$/, '');
  if (!base) return { ok: false, error: 'Set the control-plane URL first.' };

  const existing = appWindows.get(appName);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return { ok: true };
  }

  const win = createCockpitWindow(
    `${base}${buildCockpitAppPath(appName)}`,
    `OSHAL — ${prettifyAppTitle(appName)}`,
    hooks,
    () => { appWindows.delete(appName); },
  );
  appWindows.set(appName, win);
  return { ok: true };
}

/** True when any cockpit surface (Jarvis or a named app) is currently open. */
export function hasOpenCockpitSurface(): boolean {
  if (cockpitWin && !cockpitWin.isDestroyed()) return true;
  for (const win of appWindows.values()) {
    if (!win.isDestroyed()) return true;
  }
  return false;
}

/** Queues one short-lived, audio-free native wake signal for the hosted Jarvis frame. */
export async function notifyNativeWake(phrase: string, detectedAt: string): Promise<boolean> {
  pendingNativeWake = {
    phrase: String(phrase || '').slice(0, 80),
    detectedAt,
    expiresAt: Date.now() + NATIVE_WAKE_TTL_MS,
  };
  return deliverPendingNativeWake();
}

/** Closes every authenticated cockpit surface (Jarvis + named app windows) during sign-out. */
export function closeFullJarvis(): void {
  pendingNativeWake = null;
  if (cockpitWin && !cockpitWin.isDestroyed()) cockpitWin.close();
  for (const win of appWindows.values()) {
    if (!win.isDestroyed()) win.close();
  }
  appWindows.clear();
}
