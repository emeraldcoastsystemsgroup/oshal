/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-137 amendment A, node half: the Electron-free logic behind "Log in + push" — which vendor login files are pushable, where the swarm accepts them, the vendor shapes we accept, the plain-http rule for the destination, how a finished browser login is detected (the vendor CLI writes its file), and how the swarm's answer is classified. Kept pure so core's vitest guards it.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added the ESPN Fantasy target and its pure halves — cookie-pair extraction from a jar listing and the connector's import body. Kept here, beside the vendor logins, so both live under the same vitest guard; ESPN is deliberately NOT folded into PushableLogin, because it is a connector credential rather than a vendor CLI file and shares none of the file-shape logic. A connector answer names the account in `account`, so that is accepted alongside `email`.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ESPN loginUrl now opens ESPN's own sign-in entry (`/login`, returnURL back to the Fantasy home) instead of the Fantasy home page. On the home page the first control a user reaches for — the person icon's Log In — does nothing in the node's Electron window, and the one that works sat in a side card; `/login` puts the MyDisney email + password form up with no click, and signing in or dismissing it returns the window to the Fantasy home the old entry opened on. Pinned by tests/unit/node-espn-cookie-login.spec.ts; `npm run test:espn-login` holds live ESPN to it.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Google joins the pushable logins as a THIRD row, not a third code path: the table already carried the file/import/status triple, so widening PushableLogin plus one LOGIN_TARGETS entry and one parseLoginFile arm is the whole client half, and the popup-login + push flow picks it up with no special-casing. The file is `.gemini/oauth_creds.json` — read from the installed @google/gemini-cli bundle, where packages/core/src/config/storage.ts declares `OAUTH_FILE = "oauth_creds.json"` under `getGlobalGeminiDir()` = `<home>/.gemini`. Its shape is the google-auth-library Credentials object (snake_case access_token/refresh_token), which is why it gets its own arm rather than reusing codex's `tokens` block or claude's `claudeAiOauth` block.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | The Google target is marked DORMANT rather than pushable, and isPushableLogin now reads that flag off the table instead of listing ids. Measured on the operator's box 2026-09-22: choosing "Sign in with Google" in the `gemini` CLI answers "Failed to sign in. Message: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google". oauth_creds.json therefore cannot be produced by a sign-in any more, so a Push to swarm button on that row is a button with nothing to send - the same class of defect as offering a brain option nothing can run. The row, the file shape, the parse arm and the swarm-side import route are all KEPT: they are correct, they are proven by their own guards, and they cost nothing while dormant. Reviving the row is deleting one `dormant` block.
 */

/** The vendor logins the swarm can adopt (codex via platform promotion, claude + gemini via ADR-137 A). */
export type PushableLogin = 'codex' | 'claude' | 'gemini';

/** Where a vendor login lives on this machine and where the swarm accepts it. */
export interface LoginTarget {
  id: PushableLogin;
  label: string;
  /** Path of the file the vendor CLI writes, relative to the home directory. */
  file: string;
  importPath: string;
  statusPath: string;
  /**
   * Set when the vendor has retired the sign-in that produces `file`. A dormant target keeps its
   * row, its shape check and its swarm-side import route — all of which are correct — but
   * {@link isPushableLogin} refuses it, so the Config screen stops offering a push that has
   * nothing to send. This is a statement about the VENDOR, not about our code: the day the
   * credential becomes obtainable again, deleting this block is the whole revival.
   */
  dormant?: { since: string; reason: string };
}

export const LOGIN_TARGETS: Readonly<Record<PushableLogin, LoginTarget>> = {
  codex: {
    id: 'codex',
    label: 'Codex (OpenAI)',
    file: '.codex/auth.json',
    importPath: '/api/openai-codex/oauth/import',
    statusPath: '/api/openai-codex/oauth/status',
  },
  claude: {
    id: 'claude',
    label: 'Anthropic (Claude)',
    file: '.claude/.credentials.json',
    importPath: '/api/claude-code/auth/import',
    statusPath: '/api/claude-code/auth/status',
  },
  gemini: {
    id: 'gemini',
    label: 'Google (Gemini)',
    // Verified against the installed @google/gemini-cli bundle: packages/core/src/config/storage.ts
    // declares OAUTH_FILE = "oauth_creds.json" and getOAuthCredsPath() joins it onto
    // getGlobalGeminiDir(), which is `<home>/.gemini`. The sign-in also writes
    // google_accounts.json beside it; that file names the account and carries no token, so it is
    // deliberately NOT pushed — the swarm only ever needs the credential.
    file: '.gemini/oauth_creds.json',
    importPath: '/api/gemini/auth/import',
    statusPath: '/api/gemini/auth/status',
    dormant: {
      since: '2026-09-22',
      reason:
        'Google retired Gemini Code Assist sign-in for individuals. The CLI answers "This client '
        + 'is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, '
        + 'please migrate to the Antigravity suite of products: https://antigravity.google", so '
        + 'oauth_creds.json can no longer be produced by a sign-in and there is nothing to push.',
    },
  },
};

/**
 * The ESPN Fantasy connector, which is a DIFFERENT SHAPE from the vendor logins above and cannot
 * reuse them. Codex and Claude are adopted by reading a file their CLI wrote after its own browser
 * redirect. ESPN publishes no CLI and no OAuth at all: the only credential that exists is a pair of
 * browser cookies, so it is captured from a real signed-in session's cookie jar instead.
 *
 * ⚠ These are ACCOUNT SESSION cookies, not a scoped token — no per-app revocation, and signing out
 * of ESPN everywhere is the only way to kill them. They are read once, posted straight to the
 * connector under the user's own swarm session, and never written to disk by this node.
 */
export const ESPN_TARGET = {
  id: 'espn-fantasy' as const,
  label: 'ESPN Fantasy',
  /** The connector's token-paste endpoint: `email` carries the SWID, `token` the espn_s2. */
  importPath: '/api/connect/espn-fantasy/token',
  /**
   * Where the user signs in. A real page in a real window — this node never handles the password.
   *
   * ESPN's own sign-in entry, not the Fantasy home page. On the home page the person icon's Log In
   * does nothing inside this Electron window (reproduced 2026-09-09), and the control that works
   * sits in a side card a first-time user has to hunt for. `/login` opens the MyDisney email +
   * password form with no click, and both signing in and dismissing the form send the window to
   * `returnURL`, the Fantasy home page the old entry opened on. `npm run test:espn-login` loads
   * this exact URL live, so ESPN moving the entry fails a run instead of the button.
   */
  loginUrl: 'https://www.espn.com/login?returnURL=https%3A%2F%2Fwww.espn.com%2Ffantasy%2F',
  /** Cookie jar to read from, and the domain that owns the pair. */
  cookieDomain: '.espn.com',
  /**
   * A PARTITIONED session, deliberately not the default one. The node clears defaultSession cookies
   * on swarm sign-out, so sharing the jar would silently wipe the ESPN login every time the user
   * signed out of the swarm.
   */
  partition: 'persist:espn-fantasy',
};

/** The two cookies that authenticate an ESPN fantasy read. Both are required; one alone is useless. */
export interface EspnCookiePair {
  swid: string;
  espnS2: string;
}

/**
 * @description Pull the SWID/espn_s2 pair out of a cookie jar listing, normalising the SWID to its
 * braced form so a paste from either place behaves identically.
 * @param cookies - Cookies as Electron's session API returns them.
 * @returns The pair, or null while either half is still missing — which is the normal state before
 * the user has finished signing in, not an error.
 */
export function readEspnCookies(
  cookies: ReadonlyArray<{ name?: string; value?: string }>,
): EspnCookiePair | null {
  let swid = '';
  let espnS2 = '';
  for (const c of cookies || []) {
    const name = String(c?.name || '');
    const value = String(c?.value || '').trim();
    if (!value) continue;
    if (name === 'SWID') swid = value;
    else if (name === 'espn_s2' || name === 'ESPN_S2') espnS2 = value;
  }
  if (!swid || !espnS2) return null;
  return { swid: swid.startsWith('{') ? swid : `{${swid}}`, espnS2 };
}

/**
 * @description The body the connector's token-paste route expects. It stores `email:token`, which
 * the Sports Edge package splits on the FIRST colon — safe because a braced GUID contains none.
 * @param pair - The captured cookies.
 * @returns The POST body.
 */
export function espnImportBody(pair: EspnCookiePair): Record<string, unknown> {
  return { email: pair.swid, token: pair.espnS2, label: 'ESPN Fantasy (captured from browser login)' };
}

/** Snapshot of a vendor login file used to notice that a browser login has completed. */
export interface LoginFileSnapshot {
  present: boolean;
  mtimeMs: number;
  size: number;
}

/** Outcome of one push, shaped for the renderer: every refusal carries a reason it can show. */
export interface PushOutcome {
  ok: boolean;
  status: number;
  /** The swarm session has expired or was never established — sign in and retry. */
  needsSignIn: boolean;
  /** The swarm declined on policy (not an operator, not a demo deployment, read-only mount…). */
  refused: boolean;
  reason?: string;
  detail?: string;
  email?: string;
}

/**
 * @description Narrows an account id to the logins that can be pushed RIGHT NOW.
 *
 * Reads {@link LOGIN_TARGETS} rather than listing ids, so a target the vendor has retired
 * (`dormant`) stops being offered everywhere at once — the Config screen's push button, the
 * login-and-push flow and the swarm-status poll all narrow through this one predicate. The guard
 * is deliberately narrower than the `PushableLogin` TYPE: the gemini row, its file shape and its
 * import route are all still correct and still compile, they simply have no credential to carry
 * while Google's individual sign-in is retired.
 * @param id - Account id from the local account list (codex / claude / gemini / antigravity / gcloud / aws)
 * @returns true for codex and claude; false for gemini while its target is dormant
 */
export function isPushableLogin(id: unknown): id is PushableLogin {
  if (typeof id !== 'string') return false;
  const target = (LOGIN_TARGETS as Record<string, LoginTarget | undefined>)[id];
  return Boolean(target) && !target!.dormant;
}

/**
 * @description Absolute path of the vendor login file on this machine.
 * @param home - The user's home directory
 * @param id - Which login
 * @returns Absolute file path (forward slashes are fine on every platform Node supports)
 */
export function loginFilePath(home: string, id: PushableLogin): string {
  const trimmed = home.replace(/[\\/]+$/, '');
  return `${trimmed}/${LOGIN_TARGETS[id].file}`;
}

/**
 * @description True when a login file appeared or was rewritten since the earlier snapshot — the
 * only signal we need that the vendor's browser login finished (the CLI writes the file last).
 * @param before - Snapshot taken before the login was launched
 * @param after - Snapshot taken now
 * @returns true when the file is new or changed
 */
export function loginFileChanged(before: LoginFileSnapshot, after: LoginFileSnapshot): boolean {
  if (!after.present) return false;
  if (!before.present) return true;
  return after.mtimeMs !== before.mtimeMs || after.size !== before.size;
}

/**
 * @description Resolves the swarm origin a push goes to, refusing to send a credential over plain
 * HTTP to anything but a loopback or private-network host.
 * @param config - Node configuration (cockpit origin preferred — it is where the OIDC cookie lives)
 * @returns The origin without a trailing slash, or the reason it cannot be used
 */
export function swarmBaseUrl(
  config: { cockpitBaseUrl?: string; controlPlaneUrl?: string },
): { ok: true; url: string } | { ok: false; reason: string; detail: string } {
  const raw = (config.cockpitBaseUrl || config.controlPlaneUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return { ok: false, reason: 'no_swarm_url', detail: 'Set the control-plane URL first.' };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'bad_swarm_url', detail: `"${raw}" is not a URL.` };
  }
  if (parsed.protocol === 'http:' && !isPrivateOrLoopbackHost(parsed.hostname)) {
    return { ok: false, reason: 'plain_http_public', detail: `Refusing to send a login over plain http to ${parsed.hostname}. Use https for a public swarm.` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'bad_swarm_url', detail: `Unsupported scheme ${parsed.protocol}` };
  }
  return { ok: true, url: raw };
}

/** Loopback, RFC1918, link-local, and .local hosts are the LAN cases a satellite legitimately uses over http. */
function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true;
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

/**
 * @description Validates the file the vendor CLI wrote before it leaves this machine: only the
 * exact per-vendor shapes are accepted, so a stray file can never be pushed as a login.
 * @param id - Which login
 * @param raw - File contents
 * @returns The parsed object, or the reason it was rejected
 */
export function parseLoginFile(
  id: PushableLogin,
  raw: string,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `${LOGIN_TARGETS[id].file} is not valid JSON — log in again.` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: `${LOGIN_TARGETS[id].file} is not a login file.` };
  }
  const body = parsed as Record<string, unknown>;
  if (id === 'codex') {
    const tokens = (body.tokens ?? body) as Record<string, unknown>;
    if (typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string') {
      return { ok: false, error: 'auth.json has no access/refresh token yet — finish `codex login` first.' };
    }
    return { ok: true, body };
  }
  if (id === 'gemini') {
    // The google-auth-library Credentials object the CLI caches after its browser sign-in.
    // A refresh token is what makes the push worth anything (access tokens expire within the
    // hour), so a file without one is refused here rather than adopted and found dead later.
    if (typeof body.access_token !== 'string' || !body.access_token.trim()
      || typeof body.refresh_token !== 'string' || !body.refresh_token.trim()) {
      return { ok: false, error: 'oauth_creds.json has no access/refresh token yet — finish the `gemini` sign-in (`/auth`) first.' };
    }
    return { ok: true, body };
  }
  const oauth = body.claudeAiOauth as Record<string, unknown> | undefined;
  if (!oauth || typeof oauth !== 'object' || typeof oauth.accessToken !== 'string' || !oauth.accessToken) {
    return { ok: false, error: '.credentials.json has no claudeAiOauth token yet — finish `claude auth login` first.' };
  }
  return { ok: true, body };
}

/**
 * @description Shapes the request body each swarm import route reads.
 * @param id - Which login
 * @param parsed - Validated file object
 * @returns JSON-serialisable body
 */
export function importRequestBody(id: PushableLogin, parsed: Record<string, unknown>): Record<string, unknown> {
  // claude and gemini both read `credentials`; codex's route reads `authJson`.
  return id === 'codex' ? { authJson: parsed } : { credentials: parsed };
}

/**
 * @description Turns the swarm's HTTP answer into something the Config screen can act on.
 * @param status - HTTP status
 * @param body - Parsed JSON body (or null when the body was not JSON)
 * @returns Classified outcome
 */
export function classifyPushResponse(status: number, body: unknown): PushOutcome {
  const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const error = typeof record.error === 'string' ? record.error : undefined;
  // `email` is what the vendor import routes return; `account` is what the connector token route
  // returns for the same idea. Reading both lets one classifier serve both without a second copy.
  const email = typeof record.email === 'string' ? record.email
    : typeof record.account === 'string' ? record.account : undefined;
  const hint = typeof record.hint === 'string' ? record.hint : typeof record.detail === 'string' ? record.detail : undefined;
  if (status >= 200 && status < 300 && record.success !== false) {
    return { ok: true, status, needsSignIn: false, refused: false, email };
  }
  if (status === 401) return { ok: false, status, needsSignIn: true, refused: false, reason: 'sign_in_required', detail: 'Sign in to the swarm, then push again.' };
  if (status === 403) return { ok: false, status, needsSignIn: false, refused: true, reason: 'not_operator', detail: 'Only the deployment operator can push a login into the swarm.' };
  if (status === 409) return { ok: false, status, needsSignIn: false, refused: true, reason: error || 'refused', detail: hint || describeRefusal(error) };
  if (status === 400) return { ok: false, status, needsSignIn: false, refused: false, reason: error || 'invalid', detail: hint || 'The swarm rejected the login file shape.' };
  return { ok: false, status, needsSignIn: false, refused: false, reason: error || `http_${status}`, detail: hint || `The swarm answered HTTP ${status}.` };
}

/** Plain-language reasons for the refusals the swarm can send. */
function describeRefusal(error: string | undefined): string {
  if (error === 'credential_distribution_disabled_pending_versioned_revocation_rail') {
    return 'This swarm is not in DEMO_MODE, or you are not its exact operator — logins are only adopted on a demo deployment.';
  }
  if (error === 'claude_credentials_path_read_only') {
    return 'The swarm mounts its Claude login read-only; set CLAUDE_AUTH_MOUNT_MODE=rw there and recreate the api.';
  }
  if (error === 'gemini_credentials_path_read_only') {
    return 'The swarm mounts its Gemini login read-only; set GEMINI_AUTH_MOUNT_MODE=rw there and recreate the api.';
  }
  if (error === 'gemini_credentials_path_unset') {
    return 'The swarm has no Gemini login path configured; set GEMINI_OAUTH_CREDS_PATH there and recreate the api.';
  }
  return 'The swarm declined the push.';
}
