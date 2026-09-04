/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-137 amendment A, node half: the Electron-free logic behind "Log in + push" — which vendor login files are pushable, where the swarm accepts them, the vendor shapes we accept, the plain-http rule for the destination, how a finished browser login is detected (the vendor CLI writes its file), and how the swarm's answer is classified. Kept pure so core's vitest guards it.
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
  const email = typeof record.email === 'string' ? record.email : undefined;
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
