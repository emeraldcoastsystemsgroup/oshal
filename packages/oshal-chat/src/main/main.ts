/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Electron main process: window, IPC bridge, and mesh-client lifecycle
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added the worker (pull + run swarm tasks locally), local-account auth IPC, and verified OIDC sign-in window
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Full-Jarvis mode: jarvis:open IPC + auto-open on launch when fullJarvisEnabled — the node presents the swarm-hosted cockpit under its verified OIDC session while the local worker keeps running
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Sign-in targets cockpitBaseUrl (public origin when OIDC is tunnel-hosted) and the app presents a Chrome-like UA — Google rejects OAuth from user agents advertising Electron
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Orb hides while the cockpit window is open (one Jarvis on screen) and returns when it closes — operator feedback: the orb fallback was being mistaken for the Jarvis surface
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Native window chrome: hidden title bar + midnight overlay controls on the orb window, menu bar hidden everywhere (operator feedback: default Windows chrome broke the app illusion)
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | titleBarStyle:'hidden' didn't hide the frame on the satellite build — orb window is frame:false with its own min/close buttons (win:minimize/win:close IPC), topbar is the drag handle
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | The white title bar the operator kept seeing was the SIGN-IN window (520x680, showing the cockpit after silent SSO) — it never got frame:false. Made it frameless with Escape-to-cancel.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Full-Jarvis = ONLY Jarvis on screen (operator: "weird having the background app visible"): orb console starts HIDDEN, the cockpit is the sole window, sign-in redirects happen in-window (no separate window). Orb reappears only if the cockpit is closed, or if the cockpit fails to open (never an invisible process).
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Grant microphone: the cockpit's push-to-talk getUserMedia was silently denied by Electron (no permission handler), so voice turns recorded nothing → "didn't catch that" every time. Server STT itself was fine.
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Per-app desktop launch: --app=<name> opens that cockpit app as its own window (operator: each app should be a real clickable Windows application, not a browser trick). Single-instance lock added — a second launch forwards its argv to the running instance (which opens/focuses the requested app window) instead of spawning a second Electron sharing the same profile (Chromium locks the session store; two instances silently corrupt cookies). --make-shortcuts=<a,b,c> writes real desktop .lnk entries per app via shell.writeShortcutLink and exits.
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | ADR-135 amendment H: the print service now comes up WITH the node. Operator: "add it to the remote node, and when the remote node is up it is running the print service, and that service is then accessible on the intranet the remote node is running on." The standalone -AtStartup scheduled task was a SEPARATE install with a separately placed token that knew nothing about the node; this ties the printer to the node's own connection lifecycle, advertised on the node's LOCAL segment (so an overlay having no broadcast domain stops mattering) and delivering on the node's OWN plane with the node's OWN credential. Opt-in: it is an outward-facing service, so it is OFF unless printServiceEnabled.
 */

import { app, BrowserWindow, ipcMain, Menu, nativeImage, session, shell, Tray } from 'electron';
import { join } from 'path';
import { parseLaunchAppArg, parseMakeShortcutsArg, prettifyAppTitle } from './app-launch';
import { ConfigStore, type OshalChatConfig } from './config';
import { MeshChatClient, type ChatReply, type MeshStatus } from './mesh-client';
import { resolveEnrollmentIdentity } from './enrollment';
import { TaskWorker, type WorkerEvent } from './worker';
import { PrintService } from './print-service';
import { accountStatus, launchLogin } from './auth-manager';
import { connectHeadscale } from './vpn';
import { ensureAgentClis } from './ensure-clis';
import { closeFullJarvis, hasOpenCockpitSurface, notifyNativeWake, openCockpitApp, openFullJarvis, type CockpitWindowHooks } from './cockpit-window';
import {
  BackgroundWakeService,
  WindowsSystemSpeechWakeDetector,
  sanitizeAssistantName,
  type BackgroundWakeStatus,
} from './background-wake';

// The swarm cockpit is the whole app in full-Jarvis mode: hide the local orb console
// entirely while it is up (the user wants ONLY Jarvis, not the node window behind it).
// With per-app windows there can be several surfaces open at once — the orb returns
// (and the wake listener reclaims the microphone) only when the LAST one closes, so
// the app never becomes an invisible, unquittable process.
const cockpitHooks: CockpitWindowHooks = {
  onOpen: () => {
    if (win && !win.isDestroyed()) win.hide();
    void wakeService.setSurfaceOwnsMicrophone(true);
  },
  onClosed: () => {
    if (hasOpenCockpitSurface()) return;
    if (win && !win.isDestroyed()) win.show();
    void wakeService.setSurfaceOwnsMicrophone(false);
  },
};

const store = new ConfigStore();
let win: BrowserWindow | null = null;
let client: MeshChatClient | null = null;
let worker: TaskWorker | null = null;
let printService: PrintService | null = null;

/** Package root (compiled main lives at dist/main/), used to locate the bundled print-drop. */
const PACKAGE_ROOT = join(__dirname, '..', '..');
let tray: Tray | null = null;
let quitting = false;

const wakeService = new BackgroundWakeService({
  detector: new WindowsSystemSpeechWakeDetector(),
  onStatus: (status) => {
    send('wake:status', status);
    updateTray(status);
  },
  onWake: async (detection) => {
    const opened = await openFullJarvis(store, cockpitHooks);
    if (!opened.ok) throw new Error(opened.error || 'Jarvis could not open.');
    await notifyNativeWake(detection.phrase, detection.detectedAt);
  },
});

// Google's OAuth page refuses user agents that advertise an embedded shell
// ("disallowed_useragent"). Present the underlying Chrome UA instead — strip the
// Electron and app tokens — so the swarm's OIDC sign-in completes in our windows.
app.userAgentFallback = app.userAgentFallback
  .replace(/\sElectron\/\S+/i, '')
  .replace(/\soshal-chat\/\S+/i, '');

// ── Launch mode ───────────────────────────────────────────────────────────────
// --app=<name>            open that cockpit app as its own window (per-app shortcut)
// --make-shortcuts=<a,b>  write desktop .lnk entries per app, then exit
// Only ONE Electron instance may own the profile (Chromium locks the session store;
// a second instance sharing userData silently corrupts cookies) — so app launches
// forward their argv to the running instance instead of starting a second one.
const launchAppRequest = parseLaunchAppArg(process.argv);
const shortcutRequest = parseMakeShortcutsArg(process.argv);
type LaunchMode = 'main' | 'shortcut-writer' | 'duplicate';
const launchMode: LaunchMode = shortcutRequest.length > 0
  ? 'shortcut-writer'
  : app.requestSingleInstanceLock({ launchApp: launchAppRequest }) ? 'main' : 'duplicate';
if (launchMode === 'duplicate') app.quit();

/**
 * @description Writes one desktop shortcut per app, each launching this executable with
 * --app=<name> — the thing that makes a cockpit app a first-class clickable Windows
 * application (own icon on the desktop, own window, pinnable). Dev launches (unpackaged)
 * get the app path injected before the flag so the shortcut still resolves.
 * @param appNames Sanitized cockpit app names to write shortcuts for.
 * @returns Written and failed .lnk paths for operator-readable logging.
 */
function writeAppShortcuts(appNames: string[]): { written: string[]; failed: string[] } {
  const desktop = app.getPath('desktop');
  const written: string[] = [];
  const failed: string[] = [];
  for (const name of appNames) {
    const title = prettifyAppTitle(name);
    const lnkPath = join(desktop, `OSHAL ${title}.lnk`);
    const args = app.isPackaged ? `--app=${name}` : `"${app.getAppPath()}" --app=${name}`;
    const ok = process.platform === 'win32' && shell.writeShortcutLink(lnkPath, {
      target: process.execPath,
      args,
      description: `OSHAL — ${title} (opens as its own desktop app)`,
      icon: process.execPath,
      iconIndex: 0,
    });
    (ok ? written : failed).push(lnkPath);
  }
  return { written, failed };
}

/**
 * @description Forwards a second launch's --app request into this (the lock-holding)
 * instance: opens or focuses that app's window under the shared authenticated session.
 * A plain second launch (no --app) surfaces the node console so the relaunch is never
 * an invisible no-op.
 */
function registerSecondInstanceForwarding(): void {
  app.on('second-instance', (_event, argv, _cwd, additionalData) => {
    const forwarded = parseLaunchAppArg(argv)
      || (additionalData as { launchApp?: string } | null | undefined)?.launchApp
      || undefined;
    if (forwarded) {
      void openCockpitApp(store, forwarded, cockpitHooks);
      return;
    }
    showNodeWindow();
  });
}

/**
 * @description Creates the orb/console window and loads the local UI. In full-Jarvis
 * mode it starts HIDDEN: the swarm cockpit is the only surface the user wants to see,
 * so the orb becomes a background console that only appears if the cockpit is closed.
 * @param startHidden When true, the window is created but not shown.
 */
function createWindow(startHidden = false): void {
  win = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 520,
    minHeight: 480,
    title: 'OSHAL Node',
    backgroundColor: '#0b1020',
    autoHideMenuBar: true,
    frame: false,
    show: !startHidden,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void win.loadFile(join(__dirname, '..', '..', 'src', 'renderer', 'index.html'));
  win.on('close', (event) => {
    if (!quitting && wakeService.isEnabled()) {
      event.preventDefault();
      win?.hide();
      updateTray(wakeService.getStatus());
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

/**
 * @description Forwards a value to the renderer if the window is alive.
 */
function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function showNodeWindow(): void {
  if (!win || win.isDestroyed()) createWindow();
  win?.show();
  win?.focus();
}

function trayIcon() {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAABjSURBVDhP5YyxDcAgDATpaRghQ2TmLJSBiBwJRA5sOTQUnHTd/4WwH+d9ZU1uVXgcyU8HD5b8Vjj0yMZLOyjEdHz8HRIZcYU4YMAdEjhiZH3IIxsVDi357eBhJD8qPE5FlvIAxgpkpp+CfD4AAAAASUVORK5CYII=';
  return nativeImage.createFromBuffer(Buffer.from(png, 'base64'));
}

function ensureTray(): void {
  if (tray) return;
  tray = new Tray(trayIcon());
  tray.on('click', showNodeWindow);
  updateTray(wakeService.getStatus());
}

function updateTray(status: BackgroundWakeStatus): void {
  if (!tray) return;
  const label = status.state === 'listening'
    ? `Listening for "${status.phrase}"`
    : status.state === 'paused' ? 'Background wake paused' : `Background wake ${status.state}`;
  tray.setToolTip(`OSHAL Node — ${label}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open OSHAL Node', click: showNodeWindow },
    { label: 'Open Jarvis', click: () => { void openFullJarvis(store, cockpitHooks); } },
    { type: 'separator' },
    { label, enabled: false },
    {
      label: status.state === 'paused' ? 'Resume background wake' : 'Pause background wake',
      enabled: status.enabled && status.state !== 'unavailable' && status.state !== 'error',
      click: () => { void wakeService.setUserPaused(status.state !== 'paused'); },
    },
    {
      label: 'Turn background wake off',
      enabled: status.enabled,
      click: () => {
        const config = store.save({ backgroundWakeEnabled: false });
        syncBackgroundStartup(false);
        void wakeService.configure(wakeConfig(config));
      },
    },
    { type: 'separator' },
    { label: 'Quit OSHAL Node', click: () => void quitApplication() },
  ]));
}

function wakeConfig(config: OshalChatConfig) {
  return {
    enabled: config.backgroundWakeEnabled,
    assistantName: config.wakeAssistantName,
    identityReady: Boolean(config.userSub && (config.cockpitBaseUrl || config.controlPlaneUrl)),
    locale: 'en-US',
  };
}

function syncBackgroundStartup(enabled: boolean): void {
  if (!app.isPackaged || (process.platform !== 'win32' && process.platform !== 'darwin')) return;
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: enabled });
}

async function quitApplication(): Promise<void> {
  if (quitting) return;
  quitting = true;
  await wakeService.shutdown();
  await teardownClient();
  tray?.destroy();
  tray = null;
  app.quit();
}

/**
 * @description Tears down any existing client and connects a fresh one.
 */
async function connect(): Promise<MeshStatus> {
  await teardownClient();

  let config = store.load();
  if (!config.controlPlaneUrl || !config.sharedSecret) {
    return { connected: false, clientId: config.clientId, agentId: '', lastError: 'Control-plane URL and shared secret are required.' };
  }

  // Learn WHO OWNS this computer before registering: an enrollment token is exchanged once for its
  // user's verified sub, so the node binds to a real person instead of coming up unowned (an unowned
  // node is invisible to owner-scoped dispatch on the control plane). Never fatal — a stale or
  // expired token leaves the node unowned rather than blocking the connection.
  const enrollment = await resolveEnrollmentIdentity(config, store);
  if (enrollment.status === 'enrolled') {
    config = store.load();
    console.log(`[oshal] enrolled: this computer is registered to ${enrollment.email || enrollment.sub}`);
  } else if (enrollment.status === 'failed') {
    console.warn(`[oshal] enrollment could not be completed: ${enrollment.error}`);
  }

  client = new MeshChatClient(config, {
    onReply: (reply: ChatReply) => send('chat:reply', reply),
    onStatus: (status: MeshStatus) => send('mesh:status', status),
  });

  await client.start();

  // Become a worker node: pull + run swarm-dispatched tasks locally.
  if (config.workerEnabled) {
    // Install + always-update the agent CLIs (claude/codex/…) on start so the worker's
    // claude.exec/codex.exec/swarm.exec tools are present + current — never ENOENT. Best-effort;
    // awaited before the worker pulls so the first task already has a working CLI.
    await ensureAgentClis({ onLog: (message: string) => send('worker:event', { type: 'log', message }) });
    worker = new TaskWorker(config, { onEvent: (event: WorkerEvent) => send('worker:event', event) });
    worker.start();
  }

  // Serve this site's intranet: while the node is up it advertises a print-to-rag printer on
  // its OWN network segment, so people on that segment print into the swarm with no client
  // software and no credential. Discovery stays local (which is why an overlay having no
  // broadcast domain stops mattering); only the delivery POST crosses it.
  if (PrintService.enabled(config)) {
    printService = new PrintService(config, PACKAGE_ROOT, (message: string) => send('worker:event', { type: 'log', message }));
    printService.start();
  }

  return { connected: true, clientId: config.clientId, agentId: config.targetAgentId || '(default chat agent)', lastError: null };
}

/** Stops the chat client + worker if running. */
async function teardownClient(): Promise<void> {
  // Stop the printer with the node: a printer still advertised after the node disconnects
  // would accept jobs it can no longer deliver.
  if (printService) {
    printService.stop();
    printService = null;
  }
  if (worker) {
    worker.stop();
    worker = null;
  }
  if (client) {
    await client.stop();
    client = null;
  }
}

/**
 * @description Opens the swarm's OIDC /login in a window, then reads GET /api/user
 * in that authenticated session to capture a VERIFIED sub + email (replacing the
 * caller-asserted userSub). Persists them so chat/task calls carry a real identity.
 */
async function signIn(): Promise<{ ok: boolean; sub?: string; email?: string; error?: string }> {
  const config = store.load();
  // Sign in against the cockpit origin: with tunnel-hosted OIDC the IdP only ever
  // sets the session cookie on the public host, never the LAN control-plane URL.
  const base = (config.cockpitBaseUrl || config.controlPlaneUrl).replace(/\/+$/, '');
  if (!base) return { ok: false, error: 'Set the control-plane URL first.' };

  return new Promise((resolve) => {
    const authWin = new BrowserWindow({
      width: 520,
      height: 680,
      parent: win ?? undefined,
      modal: true,
      title: 'Sign in to the swarm',
      backgroundColor: '#0b1020',
      autoHideMenuBar: true,
      frame: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    // Frameless: Escape cancels the sign-in (there is no native close button).
    authWin.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') authWin.close();
    });

    let settled = false;
    const finish = (result: { ok: boolean; sub?: string; email?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      if (!authWin.isDestroyed()) authWin.close();
      resolve(result);
    };

    // After each navigation, try to read the authenticated identity. Before login
    // this 401s (ignored); once the session cookie is set it returns the user.
    const tryReadUser = async (): Promise<void> => {
      try {
        const user = (await authWin.webContents.executeJavaScript(
          `fetch('${base}/api/user', { credentials: 'include' }).then(r => r.ok ? r.json() : null).catch(() => null)`,
        )) as { sub?: string; oid?: string; email?: string; name?: string } | null;
        const sub = user?.sub || user?.oid;
        if (sub) {
          const updated = store.save({ userSub: String(sub), userEmail: user?.email || user?.name || '' });
          void wakeService.configure(wakeConfig(updated));
          finish({ ok: true, sub: String(sub), email: user?.email || user?.name || '' });
        }
      } catch {
        // keep waiting for the user to finish logging in
      }
    };

    authWin.webContents.on('did-navigate', () => void tryReadUser());
    authWin.webContents.on('did-navigate-in-page', () => void tryReadUser());
    authWin.on('closed', () => finish({ ok: false, error: 'Sign-in window closed.' }));

    void authWin.loadURL(`${base}/login`);
  });
}

/** Stops all user-scoped listening/transport before clearing this app's OIDC cookies. */
async function signOut(): Promise<{ ok: boolean; error?: string }> {
  try {
    const config = store.load();
    const updated = store.save({ userSub: '', userEmail: '', backgroundWakeEnabled: false });
    syncBackgroundStartup(false);
    await wakeService.configure(wakeConfig(updated));
    await teardownClient();
    closeFullJarvis();

    const rawBase = config.cockpitBaseUrl || config.controlPlaneUrl;
    if (rawBase) {
      const base = new URL(rawBase);
      const cookies = await session.defaultSession.cookies.get({ url: base.origin });
      for (const cookie of cookies) {
        const scheme = cookie.secure ? 'https:' : base.protocol;
        const domain = cookie.domain?.replace(/^\./, '') || base.hostname;
        await session.defaultSession.cookies.remove(`${scheme}//${domain}${cookie.path || '/'}`, cookie.name);
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Sign-out failed.' };
  }
}

/**
 * @description Registers all IPC handlers the renderer calls through the preload bridge.
 */
function registerIpc(): void {
  ipcMain.handle('config:get', () => store.load());
  ipcMain.handle('config:save', async (_event, update: Partial<OshalChatConfig>) => {
    // Enabling background capture is deliberately excluded from the generic settings
    // writer. Only wake:set-enabled, called after getUserMedia succeeds on a user click,
    // may persist that consent.
    const { backgroundWakeEnabled: _ignored, ...safeUpdate } = update;
    if (safeUpdate.wakeAssistantName !== undefined) {
      safeUpdate.wakeAssistantName = sanitizeAssistantName(safeUpdate.wakeAssistantName);
    }
    const updated = store.save(safeUpdate);
    await wakeService.configure(wakeConfig(updated));
    return updated;
  });
  ipcMain.handle('vpn:connect', () => connectHeadscale(store.load()));

  ipcMain.handle('mesh:connect', async () => {
    try {
      return await connect();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'connect failed';
      return { connected: false, clientId: store.load().clientId, agentId: '', lastError: message };
    }
  });

  ipcMain.handle('mesh:disconnect', async () => {
    await teardownClient();
    return { connected: false };
  });

  ipcMain.handle('chat:send', async (_event, text: string) => {
    if (!client) {
      throw new Error('Not connected to the swarm.');
    }
    return client.sendChat(text);
  });

  // Local accounts (codex / claude / gcloud / aws) — probe + browser-popup login.
  ipcMain.handle('auth:status', () => accountStatus());
  ipcMain.handle('auth:login', (_event, id: string) => launchLogin(id));

  // Verified identity via the swarm's OIDC login.
  ipcMain.handle('identity:signin', () => signIn());
  ipcMain.handle('identity:signout', () => signOut());

  // Native background wake word. Enabling comes only after the renderer has
  // obtained explicit OS/Chromium microphone permission from a user gesture.
  ipcMain.handle('wake:get-status', () => wakeService.getStatus());
  ipcMain.handle('wake:set-enabled', async (_event, enabled: boolean, assistantName?: string) => {
    const current = store.load();
    if (enabled && !current.userSub) {
      return { ...wakeService.getStatus(), state: 'error', detail: 'Sign in to the swarm before enabling background wake word.' };
    }
    if (enabled && process.platform !== 'win32') {
      return {
        ...wakeService.getStatus(), enabled: false, state: 'unavailable',
        detail: 'This platform needs an approved signed local wake-word helper. No cloud fallback is used.',
      };
    }
    const updated = store.save({
      backgroundWakeEnabled: Boolean(enabled),
      wakeAssistantName: sanitizeAssistantName(assistantName || current.wakeAssistantName),
    });
    syncBackgroundStartup(Boolean(enabled));
    return wakeService.configure(wakeConfig(updated));
  });
  ipcMain.handle('wake:set-paused', (_event, paused: boolean) => wakeService.setUserPaused(paused));
  ipcMain.handle('wake:microphone-owner', (_event, active: boolean) => wakeService.setCaptureOwnsMicrophone(active));

  // Full Jarvis: the swarm-hosted cockpit in its own frameless window (auth in-window).
  ipcMain.handle('jarvis:open', () => openFullJarvis(store, cockpitHooks));

  // Frameless window controls for the orb console (no native title bar).
  ipcMain.handle('win:minimize', () => { win?.minimize(); });
  ipcMain.handle('win:close', () => { win?.close(); });

  // Open the swarm's web connectors hub (Gmail/SmartThings/…) in the browser.
  ipcMain.handle('connections:open', () => {
    const base = store.load().controlPlaneUrl.replace(/\/+$/, '');
    if (base) void shell.openExternal(`${base}/connections`);
    return { ok: Boolean(base) };
  });
}

/**
 * @description Grants microphone/media so the swarm cockpit's voice pipeline works.
 * The cockpit's push-to-talk captures audio with getUserMedia and POSTs it to the
 * server for transcription — but Electron denies the mic unless we handle the
 * permission ourselves. Without this, every voice turn silently records nothing and
 * the surface reports "didn't catch that." Only audio media from the local renderer
 * or configured OSHAL origins is allowed; camera and unrelated permissions fail closed.
 */
function grantMediaPermissions(): void {
  const trusted = (urlValue: string): boolean => {
    try {
      const candidate = new URL(urlValue);
      if (candidate.protocol === 'file:') return true;
      const config = store.load();
      return [config.controlPlaneUrl, config.cockpitBaseUrl]
        .filter(Boolean)
        .some((value) => {
          try { return new URL(value).origin === candidate.origin; } catch { return false; }
        });
    } catch {
      return false;
    }
  };

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes || [];
    const audioOnly = mediaTypes.length === 0 || mediaTypes.every((type) => type === 'audio');
    const requestingUrl = (details as { requestingUrl?: string }).requestingUrl || webContents.getURL();
    callback(permission === 'media' && audioOnly && trusted(requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return permission === 'media'
      && details.mediaType === 'audio'
      && trusted(details.requestingUrl || requestingOrigin || webContents?.getURL() || '');
  });
}

app.whenReady().then(async () => {
  if (launchMode === 'duplicate') return; // quitting — the running instance handles the request
  if (launchMode === 'shortcut-writer') {
    const result = writeAppShortcuts(shortcutRequest);
    console.log(`[oshal] shortcuts written: ${result.written.join(', ') || '(none)'}`
      + (result.failed.length ? ` — FAILED: ${result.failed.join(', ')}` : ''));
    app.quit();
    return;
  }
  registerSecondInstanceForwarding();
  grantMediaPermissions();
  registerIpc();
  ensureTray();
  const cfg = store.load();
  syncBackgroundStartup(cfg.backgroundWakeEnabled);
  // Surface-on-launch nodes present ONLY the swarm cockpit: create the orb console
  // hidden (it's a background settings/worker surface), then open the surface — the
  // requested app window for an --app launch, else full Jarvis — as the sole visible
  // window. Plain non-full-Jarvis launches show the orb as before.
  const fullJarvis = Boolean(cfg.fullJarvisEnabled && cfg.controlPlaneUrl);
  const surfaceOnLaunch = Boolean(launchAppRequest) || fullJarvis;
  if (surfaceOnLaunch) await wakeService.setSurfaceOwnsMicrophone(true);
  await wakeService.configure(wakeConfig(cfg));
  createWindow(surfaceOnLaunch);
  // Auto-connect on launch when already configured, so the node rejoins the swarm
  // (and its worker starts pulling) without a manual click. Errors are surfaced to
  // the UI via the status channel inside connect().
  if (cfg.controlPlaneUrl && cfg.sharedSecret) {
    connect()
      .then((status) => send('mesh:status', status))
      .catch((error) => send('mesh:status', {
        connected: false,
        clientId: cfg.clientId,
        agentId: '',
        lastError: error instanceof Error ? error.message : 'auto-connect failed',
      }));
  }
  if (surfaceOnLaunch) {
    // Open the surface; if it can't (no base URL), reveal the orb so the app is never
    // an invisible, unquittable process. cockpitHooks.onOpen hides the orb on success.
    const openSurface = launchAppRequest
      ? openCockpitApp(store, launchAppRequest, cockpitHooks)
      : openFullJarvis(store, cockpitHooks);
    openSurface
      .then((r) => { if (!r.ok && win && !win.isDestroyed()) win.show(); })
      .catch(() => { if (win && !win.isDestroyed()) win.show(); });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (wakeService.isEnabled()) return;
  if (process.platform !== 'darwin') void quitApplication();
});

app.on('before-quit', () => {
  quitting = true;
  void wakeService.shutdown();
});
