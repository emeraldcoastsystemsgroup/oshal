/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | "Trace my login" for ESPN Fantasy: open a real ESPN sign-in window in an isolated partition, watch its cookie jar for the SWID/espn_s2 pair the fantasy API authenticates with, and push that pair straight into the user's own connector under their swarm session. Exists because ESPN publishes no OAuth for fantasy — the alternative is the user opening DevTools and copying two cookies by hand.
 */
import { BrowserWindow, session, type Session } from 'electron';
import type { ConfigStore } from './config';
import {
  ESPN_TARGET,
  classifyPushResponse,
  espnImportBody,
  readEspnCookies,
  swarmBaseUrl,
  type EspnCookiePair,
  type PushOutcome,
} from './login-push-core';

/** How long the login window stays open waiting for the cookies before it gives up. */
const DEFAULT_LOGIN_WAIT_MS = 5 * 60_000;
/** ESPN sets the pair mid-redirect, so the jar is polled rather than waited on once. */
const POLL_MS = 1_000;

function failure(reason: string, detail: string, status = 0): PushOutcome {
  return { ok: false, status, needsSignIn: false, refused: false, reason, detail };
}

/**
 * @description The isolated cookie jar the ESPN login lives in.
 *
 * Deliberately NOT `defaultSession`: signing out of the swarm clears that jar wholesale, which
 * would silently log the user out of ESPN as a side effect of an unrelated action and leave the
 * connector looking broken for no visible reason.
 * @returns The partitioned session.
 */
export function espnSession(): Session {
  return session.fromPartition(ESPN_TARGET.partition);
}

/**
 * @description Read the credential pair out of the ESPN jar without opening anything.
 * @param jar - Session to read (defaults to the ESPN partition).
 * @returns The pair, or null when this machine has no ESPN login yet.
 */
export async function readStoredEspnCookies(jar: Session = espnSession()): Promise<EspnCookiePair | null> {
  const cookies = await jar.cookies.get({ domain: ESPN_TARGET.cookieDomain });
  return readEspnCookies(cookies);
}

/**
 * @description Send a captured pair to the user's connector, over the SWARM session's cookie jar.
 *
 * Two different jars are in play and swapping them would break both halves: the credential comes
 * from the ESPN partition, and the request that carries it is authenticated by the OIDC cookie in
 * `defaultSession`. The pair is held only for the duration of this call — never written to disk,
 * never logged, and never returned to the renderer.
 * @param store - Node configuration (the swarm origin).
 * @param pair - The captured cookies.
 * @returns The classified outcome the Config screen shows verbatim.
 */
export async function pushEspnCookies(store: ConfigStore, pair: EspnCookiePair): Promise<PushOutcome> {
  const base = swarmBaseUrl(store.load());
  if (!base.ok) return failure(base.reason, base.detail);
  try {
    const response = await session.defaultSession.fetch(`${base.url}${ESPN_TARGET.importPath}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(espnImportBody(pair)),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return classifyPushResponse(response.status, body);
  } catch (error) {
    return failure('network', error instanceof Error ? error.message : String(error));
  }
}

/**
 * @description Open ESPN's sign-in page and capture the fantasy credential the moment it exists.
 *
 * The user types their ESPN password into ESPN's own page in a normal framed window; this node
 * never sees it, and never navigates on the user's behalf beyond the first load. Closing the
 * window cancels — a cancel is reported as a cancel, not as a failure to find cookies.
 * @param store - Node configuration.
 * @param options - Wait ceiling and parent window, both for tests and for modality.
 * @returns The push outcome, or why nothing was pushed.
 */
export async function connectEspnFantasy(
  store: ConfigStore,
  options: { timeoutMs?: number; parent?: BrowserWindow | null } = {},
): Promise<PushOutcome> {
  // Resolve the destination BEFORE opening anything: a misconfigured swarm origin should not make
  // the user sign in to ESPN first and only then be told the push had nowhere to go.
  const base = swarmBaseUrl(store.load());
  if (!base.ok) return failure(base.reason, base.detail);

  const jar = espnSession();
  const existing = await readStoredEspnCookies(jar);
  if (existing) return pushEspnCookies(store, existing);

  const pair = await captureEspnCookies(jar, options);
  if (!pair.ok) return failure(pair.reason, pair.detail);
  return pushEspnCookies(store, pair.pair);
}

/** Result of watching the login window: the pair, or why it never arrived. */
type CaptureResult = { ok: true; pair: EspnCookiePair } | { ok: false; reason: string; detail: string };

/**
 * @description Show the ESPN login window and poll its jar until the pair appears.
 * @param jar - The partitioned session the window runs in.
 * @param options - Wait ceiling and parent window.
 * @returns The captured pair, or the reason the capture ended.
 */
function captureEspnCookies(
  jar: Session,
  options: { timeoutMs?: number; parent?: BrowserWindow | null },
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const loginWin = new BrowserWindow({
      width: 980,
      height: 820,
      parent: options.parent ?? undefined,
      title: 'Sign in to ESPN',
      backgroundColor: '#0b1020',
      autoHideMenuBar: true,
      webPreferences: { session: jar, contextIsolation: true, nodeIntegration: false },
    });

    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (result: CaptureResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      if (!loginWin.isDestroyed()) loginWin.close();
      resolve(result);
    };

    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_LOGIN_WAIT_MS);
    timer = setInterval(() => {
      if (Date.now() > deadline) {
        finish({ ok: false, reason: 'login_timeout', detail: 'Timed out waiting for the ESPN sign-in to finish.' });
        return;
      }
      void jar.cookies
        .get({ domain: ESPN_TARGET.cookieDomain })
        .then((cookies) => {
          const pair = readEspnCookies(cookies);
          if (pair) finish({ ok: true, pair });
        })
        .catch(() => {
          /* the jar is readable again on the next tick; a transient read is not a failure */
        });
    }, POLL_MS);

    // A closed window is the user cancelling, which must not read as "ESPN did not set cookies".
    loginWin.on('closed', () =>
      finish({ ok: false, reason: 'cancelled', detail: 'Sign-in window closed before ESPN was signed in.' }),
    );

    void loginWin.loadURL(ESPN_TARGET.loginUrl);
  });
}

/**
 * @description Forget the ESPN login held on THIS machine.
 *
 * This clears the local jar only. It does not revoke anything at ESPN and it does not remove the
 * credential already stored in the swarm connector — those are two separate acts, and saying so is
 * the point: the cookies are account session cookies, so the only real revocation is signing out
 * of ESPN everywhere.
 * @returns Whether the local jar was cleared.
 */
export async function forgetEspnLogin(): Promise<{ ok: boolean; detail?: string }> {
  try {
    await espnSession().clearStorageData({ storages: ['cookies'] });
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * @description Whether this machine currently holds an ESPN login, for the button's label.
 * @returns Presence only — never the cookie values themselves.
 * @returns The SWID is returned because it is an account identifier the user can recognise; the
 * espn_s2 half never leaves this module.
 */
export async function espnLoginStatus(): Promise<{ present: boolean; swid?: string }> {
  const pair = await readStoredEspnCookies();
  return pair ? { present: true, swid: pair.swid } : { present: false };
}
