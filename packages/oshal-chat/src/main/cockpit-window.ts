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
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Per-app windows (openCockpitApp): any cockpit app (?app=<name>) opens as its OWN frameless window keyed by name — open/focus semantics per app, several apps side by side, each alt-tabbable with its app title. createCockpitWindow generalized to build-and-return (title + close callback params); openFullJarvis keeps its dedicated window + the native-wake delivery contract unchanged.
 */

import { BrowserWindow, type WebContents } from 'electron';
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
const SHELL_INTEGRATION_CSS = `
header.header-bar { -webkit-app-region: drag; padding-right: 52px; }
header.header-bar button, header.header-bar a, header.header-bar input, header.header-bar select { -webkit-app-region: no-drag; }
body::after { content: ''; position: fixed; top: 0; left: 0; right: 0; height: 8px; z-index: 2147483646; -webkit-app-region: drag; }
`;

/**
 * Injected into the page context: a borderless window has no native controls, so
 * add one app-colored close button (top-right) that closes the window. The drag
 * strip already gives move + double-click-to-maximize (native drag-region behavior).
 * Guarded so re-injection on navigation never stacks duplicates.
 */
const SHELL_CONTROLS_JS = `(() => {
  if (document.getElementById('oshal-winclose')) return;
  const btn = document.createElement('button');
  btn.id = 'oshal-winclose';
  btn.setAttribute('aria-label', 'Close');
  btn.textContent = '\\u2715';
  Object.assign(btn.style, {
    position: 'fixed', top: '6px', right: '8px', zIndex: '2147483647',
    width: '30px', height: '26px', lineHeight: '24px', textAlign: 'center',
    padding: '0', border: '0', borderRadius: '7px', cursor: 'pointer',
    font: '13px system-ui, sans-serif', color: '#aab3d0',
    background: 'rgba(120,140,190,0.14)', WebkitAppRegion: 'no-drag',
  });
  btn.onmouseenter = () => { btn.style.background = '#c0392b'; btn.style.color = '#fff'; };
  btn.onmouseleave = () => { btn.style.background = 'rgba(120,140,190,0.14)'; btn.style.color = '#aab3d0'; };
  btn.onclick = () => window.close();
  document.body.appendChild(btn);
})();`;

/** Attach the frameless-shell CSS + close button to a webContents, re-run on each navigation. */
function injectShellChrome(contents: WebContents): void {
  contents.on('did-finish-load', () => {
    void contents.insertCSS(SHELL_INTEGRATION_CSS);
    void contents.executeJavaScript(SHELL_CONTROLS_JS).catch(() => undefined);
  });
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
  injectShellChrome(win.webContents);
  win.webContents.on('did-frame-finish-load', () => { void deliverPendingNativeWake(); });
  win.webContents.on('did-finish-load', () => { void deliverPendingNativeWake(); });
  // window.open children (the cockpit opens its app surfaces / OAuth popups as
  // popups) must ALSO be frameless + carry the close button, or they show the
  // default white Windows title bar — which is the frame the operator still saw.
  win.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      frame: false,
      backgroundColor: '#0b1020',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    },
  }));
  win.webContents.on('did-create-window', (child) => injectShellChrome(child.webContents));
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
