/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-137 amendment A, node half: push the vendor login this machine holds (the file `codex login` / `claude auth login` wrote after its own localhost redirect, the way VS Code's extension does it) into the swarm under the user's verified OIDC session, and wait for a just-launched browser login to finish before pushing. The credential travels only over the session's cookie jar to the configured swarm origin.
 */
import { readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { session } from 'electron';
import type { ConfigStore } from './config';
import {
  LOGIN_TARGETS,
  classifyPushResponse,
  importRequestBody,
  isPushableLogin,
  loginFileChanged,
  loginFilePath,
  parseLoginFile,
  swarmBaseUrl,
  type LoginFileSnapshot,
  type PushOutcome,
  type PushableLogin,
} from './login-push-core';

const DEFAULT_LOGIN_WAIT_MS = 5 * 60_000;
const DEFAULT_POLL_MS = 2_000;
/** The CLI writes, then may rewrite once (token refresh); a short settle avoids pushing a torn file. */
const SETTLE_MS = 1_500;

function failure(reason: string, detail: string, status = 0): PushOutcome {
  return { ok: false, status, needsSignIn: false, refused: false, reason, detail };
}

/**
 * @description Snapshot of the login file so a later poll can tell "the browser login finished".
 * @param id - Which login
 * @returns Presence + mtime + size
 */
export function snapshotLogin(id: PushableLogin): LoginFileSnapshot {
  try {
    const stat = statSync(loginFilePath(homedir(), id));
    return { present: true, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { present: false, mtimeMs: 0, size: 0 };
  }
}

/**
 * @description Reads this machine's vendor login file and posts it to the swarm's import route
 * under the Electron default session (the OIDC cookie jar the sign-in window filled).
 * @param store - Node configuration (swarm origin)
 * @param id - Which login to push
 * @returns Classified outcome the renderer can show verbatim
 */
export async function pushLoginToSwarm(store: ConfigStore, id: string): Promise<PushOutcome> {
  if (!isPushableLogin(id)) return failure('unknown_account', `"${id}" cannot be pushed to the swarm.`);
  const base = swarmBaseUrl(store.load());
  if (!base.ok) return failure(base.reason, base.detail);
  const file = loginFilePath(homedir(), id);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return failure('not_logged_in_here', `Log in first — ${file} does not exist yet.`);
  }
  const parsed = parseLoginFile(id, raw);
  if (!parsed.ok) return failure('login_file_invalid', parsed.error);
  try {
    const response = await session.defaultSession.fetch(`${base.url}${LOGIN_TARGETS[id].importPath}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(importRequestBody(id, parsed.body)),
    });
    return classifyPushResponse(response.status, await readJson(response));
  } catch (error) {
    return failure('network', error instanceof Error ? error.message : String(error));
  }
}

/**
 * @description Asks the swarm whether it currently holds a usable login for this vendor.
 * @param store - Node configuration (swarm origin)
 * @param id - Which login
 * @returns authenticated flag, or why it could not be read
 */
export async function swarmLoginStatus(
  store: ConfigStore,
  id: string,
): Promise<{ ok: boolean; authenticated: boolean; needsSignIn: boolean; detail?: string }> {
  if (!isPushableLogin(id)) return { ok: false, authenticated: false, needsSignIn: false, detail: 'unknown account' };
  const base = swarmBaseUrl(store.load());
  if (!base.ok) return { ok: false, authenticated: false, needsSignIn: false, detail: base.detail };
  try {
    const response = await session.defaultSession.fetch(`${base.url}${LOGIN_TARGETS[id].statusPath}`, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (response.status === 401) return { ok: false, authenticated: false, needsSignIn: true, detail: 'not signed in to the swarm' };
    if (response.status === 403) return { ok: false, authenticated: false, needsSignIn: false, detail: 'operator only' };
    const body = (await readJson(response)) as { authenticated?: unknown } | null;
    return { ok: response.ok, authenticated: body?.authenticated === true, needsSignIn: false };
  } catch (error) {
    return { ok: false, authenticated: false, needsSignIn: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * @description After the vendor login was launched in a terminal + browser, waits for the CLI to
 * (re)write its login file — the redirect landed and the login finished — then pushes it.
 * @param store - Node configuration
 * @param id - Which login
 * @param before - Snapshot taken before the login was launched
 * @param options - Wait ceiling and poll cadence
 * @returns The push outcome, or a login_timeout failure
 */
export async function waitForLoginThenPush(
  store: ConfigStore,
  id: PushableLogin,
  before: LoginFileSnapshot,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<PushOutcome> {
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_LOGIN_WAIT_MS);
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  while (Date.now() < deadline) {
    if (loginFileChanged(before, snapshotLogin(id))) {
      await sleep(SETTLE_MS);
      return pushLoginToSwarm(store, id);
    }
    await sleep(pollMs);
  }
  return failure('login_timeout', `No new ${LOGIN_TARGETS[id].file} appeared — finish the browser login, then press "Push to swarm".`);
}

async function readJson(response: { text: () => Promise<string> }): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
