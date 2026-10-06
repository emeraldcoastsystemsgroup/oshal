/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B (D2, step B5-4): one token-free, identity-free status of the swarm's vendor logins (Claude Code, OpenAI Codex, Gemini, Antigravity) for the Swarm Admin logins screen. GET /api/admin/swarm-logins (mounted behind requiresAuth + requiresOperator) reads each login's presence and expiry from the same sources the runtime reads, never an account email or a token, and says per login whether THIS caller may adopt a login pushed from a computer, exactly as that vendor's import route decides it (Claude Code, Gemini, Antigravity: DEMO_MODE on and the caller's exact subject on OSHAL_OPERATOR_SUBS; Codex: any signed-in operator), with the reason when not. Gemini's expired state is reported as such. The screen's actions keep using the vendors' own routes.
 */

import { Router as createRouter, type Request, type Router } from 'express';
import { ClaudeCodeAuthService } from '@/features/claude-code-auth';
import { antigravityPushedLoginPresent, getGeminiAuthStatus, liveCodexAuthExpiry } from '@/features/llm-provider';
import { demoModeEnabled, isDeploymentOperatorSub } from '@/shared/deployment-mode';
import { getCaller } from '@/shared/middleware/authz';

/** One vendor login as the screen shows it: no identity, no token, only presence, expiry and the routes to act on it. */
export interface SwarmLoginStatus {
  id: 'claude-code' | 'openai-codex' | 'gemini' | 'antigravity';
  title: string;
  connected: boolean;
  /** ISO-8601 expiry when the credential declares one; null otherwise. */
  expiresAt: string | null;
  expired: boolean;
  /** A short machine-readable note (Gemini's lane or reason, Codex's and Claude's file presence). */
  detail: string;
  /** Which of the vendor's own routes exist for this login, for the screen's buttons. */
  rails: { status: string; import?: string; signout?: string; start?: string; submitCode?: string };
  /** Whether THIS caller may import a pushed login for this vendor, exactly as that vendor's import route decides. */
  adoption: { allowed: boolean; reason: SwarmLoginAdoptionReason };
}

/** Why this caller may or may not adopt a login pushed from a computer. */
export type SwarmLoginAdoptionReason = 'ok' | 'not-demo' | 'not-operator-subject';

/** The readers the API uses; injectable so the guard can run without the vendors' files. */
export interface SwarmLoginsDeps {
  claude: () => { present: boolean; expiresAt: number | null; expired: boolean };
  codex: () => { present: boolean; expiresAt: number | null; expired: boolean };
  gemini: () => { connected: boolean; method: string; reason: string; expiresAt?: string };
  antigravity: () => boolean;
  demo: () => boolean;
  isOperatorSubject: (sub: string | null) => boolean;
}

/**
 * @description The production readers: the persisted Claude Code login, the live Codex auth file,
 * the Gemini probe and the adopted Antigravity credential, plus the deployment-mode rule.
 * @returns The readers.
 */
export function defaultSwarmLoginsDeps(): SwarmLoginsDeps {
  const claude = new ClaudeCodeAuthService();
  return {
    claude: () => claude.getPersistedLoginExpiry(),
    codex: () => liveCodexAuthExpiry(),
    gemini: () => getGeminiAuthStatus(),
    antigravity: () => antigravityPushedLoginPresent(),
    demo: () => demoModeEnabled(),
    isOperatorSubject: (sub) => isDeploymentOperatorSub(sub),
  };
}

/** @description An epoch-ms expiry as ISO-8601, or null. */
function iso(expiresAt: number | null | undefined): string | null {
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : null;
}

/**
 * @description Whether this caller may adopt a pushed login for the vendors whose import routes
 * require it (Claude Code, Gemini, Antigravity): DEMO_MODE on, and the caller's exact subject on
 * OSHAL_OPERATOR_SUBS; never an email. The Codex import route asks only for a signed-in caller,
 * so Codex is reported as adoptable for every operator who reaches this API.
 * @param deps - The readers.
 * @param sub - The caller's subject.
 * @returns The reason, 'ok' when adoption is allowed.
 */
export function swarmLoginAdoptionReason(deps: Pick<SwarmLoginsDeps, 'demo' | 'isOperatorSubject'>, sub: string | null): SwarmLoginAdoptionReason {
  if (!deps.demo()) return 'not-demo';
  return deps.isOperatorSubject(sub) ? 'ok' : 'not-operator-subject';
}

/**
 * @description The four logins' status, read now, with nothing that identifies an account, each with
 * this caller's standing to import a pushed login as that vendor's route decides it.
 * @param deps - The readers.
 * @param sub - The caller's subject.
 * @returns The statuses in the order the screen shows them.
 */
export function readSwarmLogins(deps: SwarmLoginsDeps, sub: string | null): SwarmLoginStatus[] {
  const claude = deps.claude();
  const codex = deps.codex();
  const gemini = deps.gemini();
  const antigravity = deps.antigravity();
  const gated = swarmLoginAdoptionReason(deps, sub);
  const pushed = { allowed: gated === 'ok', reason: gated };
  return [
    {
      id: 'claude-code', title: 'Claude Code', connected: claude.present && !claude.expired, expiresAt: iso(claude.expiresAt), expired: claude.expired,
      detail: claude.present ? (claude.expired ? 'login file present but expired' : 'login file present') : 'no login file',
      rails: { status: '/api/claude-code/auth/status', start: '/api/claude-code/auth/start', submitCode: '/api/claude-code/auth/submit-code', import: '/api/claude-code/auth/import', signout: '/api/claude-code/auth/signout' },
      adoption: pushed,
    },
    {
      id: 'openai-codex', title: 'OpenAI Codex (ChatGPT)', connected: codex.present && !codex.expired, expiresAt: iso(codex.expiresAt), expired: codex.expired,
      detail: codex.present ? (codex.expired ? 'auth file present but expired' : 'auth file present') : 'no auth file',
      rails: { status: '/api/openai-codex/oauth/status', import: '/api/openai-codex/oauth/import', signout: '/api/openai-codex/oauth/signout' },
      adoption: { allowed: true, reason: 'ok' },
    },
    {
      id: 'gemini', title: 'Gemini', connected: gemini.connected, expiresAt: gemini.expiresAt ?? null, expired: gemini.reason === 'expired',
      detail: `${gemini.method}: ${gemini.reason}`,
      rails: { status: '/api/gemini/auth/status', import: '/api/gemini/auth/import', signout: '/api/gemini/auth/signout' },
      adoption: pushed,
    },
    {
      id: 'antigravity', title: 'Antigravity', connected: antigravity, expiresAt: null, expired: false,
      detail: antigravity ? 'pushed login present' : 'no pushed login',
      rails: { status: '/api/antigravity/auth/status', import: '/api/antigravity/auth/import', signout: '/api/antigravity/auth/signout' },
      adoption: pushed,
    },
  ];
}

/**
 * @description The Swarm Admin logins API. Mount behind requiresAuth and requiresOperator.
 * @param deps - The readers (production: defaultSwarmLoginsDeps()).
 * @returns The router: GET / answers the four statuses and this caller's adoption standing.
 */
export function createSwarmLoginsRoutes(deps: SwarmLoginsDeps = defaultSwarmLoginsDeps()): Router {
  const router = createRouter();
  router.get('/', (req: Request, res) => {
    res.json({ logins: readSwarmLogins(deps, getCaller(req).sub) });
  });
  return router;
}
