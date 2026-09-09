/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-137 amendment A, node half: the Electron-free logic behind "Log in + push" — which vendor login files are pushable, where the swarm accepts them, the vendor shapes we accept, the plain-http rule for the destination, how a finished browser login is detected (the vendor CLI writes its file), and how the swarm's answer is classified. Kept pure so core's vitest guards it.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added the ESPN Fantasy target and its pure halves — cookie-pair extraction from a jar listing and the connector's import body. Kept here, beside the vendor logins, so both live under the same vitest guard; ESPN is deliberately NOT folded into PushableLogin, because it is a connector credential rather than a vendor CLI file and shares none of the file-shape logic. A connector answer names the account in `account`, so that is accepted alongside `email`.
 */

/** The two vendor logins the swarm can adopt (codex via platform promotion, claude via ADR-137 A). */
export type PushableLogin = 'codex' | 'claude';

/** Where a vendor login lives on this machine and where the swarm accepts it. */
export interface LoginTarget {
  id: PushableLogin;
  label: string;
  /** Path of the file the vendor CLI writes, relative to the home directory. */
  file: string;
  importPath: string;
  statusPath: string;
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
  /** Where the user signs in. A real page in a real window — this node never handles the password. */
  loginUrl: 'https://www.espn.com/fantasy/',
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
 * @description Narrows an account id to the two logins that can be pushed.
 * @param id - Account id from the local account list (codex / claude / gcloud / aws)
 * @returns true for codex and claude
 */
export function isPushableLogin(id: unknown): id is PushableLogin {
  return id === 'codex' || id === 'claude';
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
 * @description Validates the file the vendor CLI wrote before it leaves this machine: only the two
 * exact shapes are accepted, so a stray file can never be pushed as a login.
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
  return 'The swarm declined the push.';
}
