/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added optional headscale VPN connect helper (shells the local tailscale CLI)
 */

import { execFile } from 'child_process';
import type { OshalChatConfig } from './config';

/** Result of a VPN connect attempt. */
export interface VpnResult {
  ok: boolean;
  message: string;
}

/**
 * @description Brings the local tailscale client onto the configured headscale
 * tailnet so the control-plane URL becomes reachable. No-ops gracefully when
 * headscale settings are blank or the tailscale CLI is not installed — the app
 * still works if the machine is already on the tailnet by other means.
 *
 * @param config - Connection settings (headscale login server + auth key)
 * @returns Whether the connect attempt succeeded and a human-readable message
 */
export function connectHeadscale(config: OshalChatConfig): Promise<VpnResult> {
  return new Promise((resolve) => {
    if (!config.headscaleLoginServer || !config.headscaleAuthKey) {
      resolve({ ok: true, message: 'No headscale settings configured; assuming the tailnet is already reachable.' });
      return;
    }

    const args = [
      'up',
      '--login-server',
      config.headscaleLoginServer,
      '--authkey',
      config.headscaleAuthKey,
      '--accept-dns=false',
    ];

    execFile('tailscale', args, { timeout: 30_000 }, (error, _stdout, stderr) => {
      if (error) {
        resolve({
          ok: false,
          message: `tailscale up failed: ${stderr?.trim() || error.message}. Install Tailscale or connect manually.`,
        });
        return;
      }
      resolve({ ok: true, message: `Connected to headscale at ${config.headscaleLoginServer}.` });
    });
  });
}
