/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added contextBridge preload exposing the safe IPC surface to the renderer
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Exposed worker events, local-account auth, verified sign-in, and connectors-hub APIs
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Exposed openJarvis — opens the full swarm-hosted cockpit window (full-Jarvis mode)
 */

import { contextBridge, ipcRenderer } from 'electron';

/**
 * @description Safe, typed API exposed to the renderer as `window.oshal`.
 * The renderer never touches Node or ipcRenderer directly (contextIsolation on).
 */
const api = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (update: Record<string, unknown>) => ipcRenderer.invoke('config:save', update),
  connectVpn: () => ipcRenderer.invoke('vpn:connect'),
  connect: () => ipcRenderer.invoke('mesh:connect'),
  disconnect: () => ipcRenderer.invoke('mesh:disconnect'),
  sendChat: (text: string) => ipcRenderer.invoke('chat:send', text),
  onReply: (cb: (reply: unknown) => void) =>
    ipcRenderer.on('chat:reply', (_event, reply) => cb(reply)),
  onStatus: (cb: (status: unknown) => void) =>
    ipcRenderer.on('mesh:status', (_event, status) => cb(status)),

  // Worker node — lifecycle events for tasks this machine runs for the swarm.
  onWorkerEvent: (cb: (event: unknown) => void) =>
    ipcRenderer.on('worker:event', (_event, payload) => cb(payload)),

  // Local accounts (codex / claude / gcloud / aws).
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authLogin: (id: string) => ipcRenderer.invoke('auth:login', id),

  // Verified identity + web connectors hub.
  signIn: () => ipcRenderer.invoke('identity:signin'),
  signOut: () => ipcRenderer.invoke('identity:signout'),
  openConnections: () => ipcRenderer.invoke('connections:open'),

  // Local background wake word. The renderer requests OS microphone permission
  // before it calls setBackgroundWake(true); the main process owns the detector.
  getBackgroundWakeStatus: () => ipcRenderer.invoke('wake:get-status'),
  setBackgroundWake: (enabled: boolean, assistantName: string) =>
    ipcRenderer.invoke('wake:set-enabled', enabled, assistantName),
  setBackgroundWakePaused: (paused: boolean) => ipcRenderer.invoke('wake:set-paused', paused),
  setBackgroundMicOwner: (active: boolean) => ipcRenderer.invoke('wake:microphone-owner', active),
  onBackgroundWakeStatus: (cb: (status: unknown) => void) =>
    ipcRenderer.on('wake:status', (_event, status) => cb(status)),

  // Full Jarvis — the swarm-hosted cockpit in its own window.
  openJarvis: () => ipcRenderer.invoke('jarvis:open'),

  // Frameless window controls.
  minimizeWindow: () => ipcRenderer.invoke('win:minimize'),
  closeWindow: () => ipcRenderer.invoke('win:close'),
};

contextBridge.exposeInMainWorld('oshal', api);
