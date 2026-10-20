/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Connect the desktop using portal-enrolled native device credentials without legacy mesh calls or user-session impersonation.
 */
import { lstatSync, readFileSync } from 'fs';
import type { MeshStatus } from './mesh-client';

/** @description Load an owned private enrollment file only for its exact configured origin. */
export function readNativeCredentials(file: string, origin: string): { node_id: string; token: string; base_url: string } {
  const info = lstatSync(file);
  if (!info.isFile() || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
    throw new Error('Native enrollment requires an owned private credential file.');
  }
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const endpoint = new URL(origin);
  if (endpoint.origin !== origin || endpoint.username || endpoint.password ||
      !(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)))) {
    throw new Error('Native enrollment requires HTTPS or local loopback.');
  }
  if (data.base_url !== origin || !/^[a-f0-9-]{36}$/.test(data.node_id) || typeof data.token !== 'string' || !data.token) {
    throw new Error('Native credentials do not match this installation.');
  }
  return data;
}

/** @description Maintain genuine native node presence; conversation uses the signed-in hosted portal. */
export class NativeNodeClient {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private abort: AbortController | null = null;
  private credentials: ReturnType<typeof readNativeCredentials>;
  constructor(file: string, origin: string, private readonly onStatus: (status: MeshStatus) => void) {
    this.credentials = readNativeCredentials(file, origin);
  }
  /** @description Return a status derived from this exact enrolled node and an acknowledged heartbeat. */
  status(connected: boolean, lastError: string | null = null): MeshStatus {
    return { connected, clientId: this.credentials.node_id, agentId: 'Native node; chat in the portal', lastError };
  }
  /** @description Verify the device credential before reporting connected and beginning periodic renewals. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.heartbeat();
    if (!this.stopped) this.timer = setInterval(() => { void this.heartbeat().catch(() => { console.error('[native-node] heartbeat failed; connection status updated'); }); }, 10000);
  }
  private async heartbeat(): Promise<void> {
    if (this.stopped || this.abort) return;
    const {base_url, node_id, token} = this.credentials;
    this.abort = new AbortController();
    const timeout = setTimeout(() => this.abort?.abort(), 8000);
    try {
      const response = await fetch(`${base_url}/nodes/${node_id}/heartbeat`, {
        method: 'POST', redirect: 'error', signal: this.abort.signal,
        headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, body: '{}',
      });
      if (!response.ok) throw new Error(`Native node connection refused (HTTP ${response.status}).`);
      const data = await response.json() as {status?: string; node?: string};
      if (data.status !== 'ok' || data.node !== node_id) throw new Error('Native heartbeat was not acknowledged.');
      if (!this.stopped) this.onStatus(this.status(true));
    } catch {
      if (!this.stopped) this.onStatus(this.status(false, 'Native node heartbeat failed. Check enrollment and the server connection.'));
      throw new Error('Native node heartbeat failed. Check enrollment and the server connection.');
    } finally { clearTimeout(timeout); this.abort = null; }
  }
  /** @description End renewal without emitting a late connected event from an in-flight request. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.abort?.abort();
    this.onStatus(this.status(false));
  }
  /** @description A device credential never authenticates a person's conversation; use the portal session. */
  async sendChat(_text: string): Promise<{ taskId: string; correlationId: string }> {
    throw new Error('Open the oshal portal window and sign in to chat. This device credential does not sign in as you.');
  }
}
