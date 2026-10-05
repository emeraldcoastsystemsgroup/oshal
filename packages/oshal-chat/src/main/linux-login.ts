/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Linux login commands that end in a login the node can push, found on the first real Linux desktop (DGX Spark, 2026-10-05). Antigravity on a desktop keeps its login in the Secret Service keyring, while the node reads only the file agy writes when no keyring is reachable, so "Log in + push" waited forever; the login now runs with the session bus disabled, which makes agy write the file. `codex login` listens on 127.0.0.1:1455 for its browser callback, which a swarm on the same machine already holds for its own Codex sign-in, so the device-code flow is used when that port is taken.
 */

import { readFileSync } from 'fs';

/** The local port `codex login` listens on for its browser callback. */
export const CODEX_CALLBACK_PORT = 1455;

/**
 * @description Whether a TCP port is listening on this machine, read from /proc/net/tcp{,6} text.
 * @param port - The port to look for.
 * @param procTables - The contents of /proc/net/tcp and /proc/net/tcp6.
 * @returns True when any row lists that local port in the LISTEN state (0A).
 */
export function portListening(port: number, procTables: readonly string[]): boolean {
  const hex = port.toString(16).toUpperCase().padStart(4, '0');
  return procTables.some((table) => table.split('\n').slice(1).some((row) => {
    const cols = row.trim().split(/\s+/);
    return cols.length > 3 && cols[1].toUpperCase().endsWith(`:${hex}`) && cols[3] === '0A';
  }));
}

/** @description Reads /proc/net/tcp and /proc/net/tcp6; a missing table reads as empty. */
export function readProcTcpTables(): string[] {
  return ['/proc/net/tcp', '/proc/net/tcp6'].map((file) => {
    try { return readFileSync(file, 'utf8'); } catch { return ''; }
  });
}

/**
 * @description The login command line a Linux terminal runs for one account, or null to keep the
 * account's default command.
 * @param id - The local account id.
 * @param procTables - /proc/net/tcp{,6} contents, for the Codex callback-port check.
 * @returns The command line, or null.
 */
export function linuxLoginCommand(id: string, procTables: readonly string[]): string | null {
  // No session bus means no keyring, so agy keeps the login in
  // ~/.gemini/antigravity-cli/antigravity-oauth-token, the file the node pushes and the swarm reads.
  if (id === 'antigravity') return 'env DBUS_SESSION_BUS_ADDRESS=disabled: agy';
  if (id === 'codex' && portListening(CODEX_CALLBACK_PORT, procTables)) return 'codex login --device-auth';
  return null;
}
