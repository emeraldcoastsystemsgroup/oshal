/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Shared plumbing for the two A2A proof scripts (a2a-inbound-proof.ts, a2a-roundtrip-proof.ts): operator-PAT loading exactly the way the swarm-cli playbook does it (--token/OSHAL_CLI_TOKEN, else ~/.oshal/config.json contexts[currentContext].token), a minimal JSON HTTP helper, the JSON-RPC envelope builder, and raw mint/revoke calls against /api/a2a/agents. Kept assertion-free on purpose — each proof script owns its own pass/fail semantics and exit codes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/** @description Minimal HTTP result shape shared by the proof scripts. */
export interface ProofHttpResult {
  status: number;
  body: unknown;
  text: string;
}

/** @description Minted A2A agent credential as returned by POST /api/a2a/agents. */
export interface MintedA2aAgent {
  id: string;
  token: string;
  scopes: string[];
}

/**
 * @description Loads the operator PAT the same way the swarm-cli playbook does:
 * an explicit value (flag) first, then env OSHAL_CLI_TOKEN, then
 * `~/.oshal/config.json` → `contexts[currentContext].token` (state dir
 * overridable via OSHAL_CLI_STATE_DIR).
 * @param explicit - An explicitly provided token (e.g. from --token), if any.
 * @returns The PAT string, or null when none can be found.
 */
export function loadOperatorPat(explicit?: string | null): string | null {
  if (explicit && explicit.trim()) return explicit.trim();
  const fromEnv = process.env.OSHAL_CLI_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const stateDir = process.env.OSHAL_CLI_STATE_DIR || path.join(os.homedir(), '.oshal');
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8')) as {
      currentContext?: string; contexts?: Record<string, { token?: string }>;
    };
    const contextName = String(raw.currentContext || 'default');
    const token = String(raw.contexts?.[contextName]?.token ?? '').trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * @description One HTTP call with JSON handling. Never throws on HTTP status — the
 * caller asserts; throws only on network-level failure.
 * @param method - HTTP method.
 * @param url - Absolute URL.
 * @param headers - Extra headers (auth).
 * @param body - Optional JSON body.
 * @returns Status + parsed body (null when non-JSON) + raw text.
 */
export async function httpJson(
  method: string, url: string, headers: Record<string, string> = {}, body?: unknown,
): Promise<ProofHttpResult> {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON body tolerated */ }
  return { status: response.status, body: parsed, text };
}

/**
 * @description Builds a JSON-RPC 2.0 request envelope.
 * @param method - RPC method name.
 * @param params - RPC params object.
 * @param id - Request id.
 * @returns The envelope object.
 */
export function rpcEnvelope(method: string, params: unknown, id: number): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method, params };
}

/**
 * @description Mints one per-agent A2A credential through the operator management API.
 * Assertion-free: returns the raw HTTP status/text plus the parsed agent (or null),
 * so each proof script applies its own pass/fail + exit-code semantics.
 * @param baseUrl - API base URL (no trailing slash).
 * @param pat - Operator PAT.
 * @param name - Credential display name.
 * @returns Raw status/text + the minted agent when the response carried one.
 */
export async function mintA2aCredential(
  baseUrl: string, pat: string, name: string,
): Promise<{ status: number; text: string; agent: MintedA2aAgent | null }> {
  const res = await httpJson('POST', `${baseUrl}/api/a2a/agents`, { Authorization: `Bearer ${pat}` }, { name });
  const agent = (res.body as { agent?: MintedA2aAgent } | null)?.agent ?? null;
  return { status: res.status, text: res.text, agent: agent?.id && agent?.token ? agent : null };
}

/**
 * @description Revokes a minted A2A credential (cleanup path).
 * @param baseUrl - API base URL (no trailing slash).
 * @param pat - Operator PAT.
 * @param agentId - Credential id to revoke.
 * @returns True when the API confirmed the revoke.
 */
export async function revokeA2aCredential(baseUrl: string, pat: string, agentId: string): Promise<boolean> {
  try {
    const res = await httpJson('POST', `${baseUrl}/api/a2a/agents/${agentId}/revoke`, { Authorization: `Bearer ${pat}` });
    return res.status === 200 && (res.body as { revoked?: boolean } | null)?.revoked === true;
  } catch {
    return false;
  }
}
