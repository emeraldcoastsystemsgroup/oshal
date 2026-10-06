/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 slice 2c: the swarm admin is not a user of the swarm. One global gate, mounted after identity resolution and before every route, lets the swarm-admin principal reach only swarm administration (admin pages, operator APIs, the mixed routers whose admin functions it runs, and its own sign-in) and refuses every personal surface: chat, tickets, tasks, connections, calendar, content, access tokens. A trusted service call acting as the admin's sub is refused outright. No-op for everyone else.
 */

import type { Request, RequestHandler } from 'express';
import { createChildLogger } from '@/shared/logger';
import { getTrustedServiceUserSub } from './authz';
import { LOCAL_AUTH_PRINCIPAL_ISSUER } from './principal-issuer';

const logger = createChildLogger({ module: 'swarm-admin-scope' });

/** The swarm admin's subject: localSubForEmail('admin'), the reserved login's deterministic local sub. */
export const SWARM_ADMIN_SUB = 'local-8c6976e5b5410415';

/** Pages, assets and session endpoints of the admin's own surface. */
export const SWARM_ADMIN_SURFACE_PATHS: readonly string[] = [
  '/login/admin', '/logout/admin', '/logout', '/api/admin-auth', '/api/local-auth/2fa', '/api/user',
  '/shared', '/fonts', '/favicon.ico',
  '/admin', '/users', '/access', '/access-review', '/app-loader', '/applications', '/config', '/data-model',
  '/utilities', '/governance', '/eval-wall', '/process-lab', '/workflow-studio', '/health-dashboard',
  '/system-health', '/redis-visibility', '/queue-dashboard', '/queue-manager-admin', '/mesh-dashboard',
  '/ops-dashboard', '/swarm-control', '/alert-pipeline-admin', '/rag-center', '/cockpit/tools',
];

/**
 * APIs the swarm admin runs: every operator-only mount, plus the mixed routers whose administrative
 * functions it owns (swarm defaults and logins, apps, connectors, roles, users and households, budgets,
 * the shared knowledge corpus, operations). Personal surfaces are deliberately absent.
 */
export const SWARM_ADMIN_API_PREFIXES: readonly string[] = [
  // Operator-only mounts.
  '/api/admin', '/api/bot', '/api/logs', '/api/persona-evals', '/api/personal-graph', '/api/process-lab',
  '/api/proxy-health', '/api/qm', '/api/redis-visibility', '/api/security', '/api/swarm/ops', '/api/updates',
  // Mixed routers: the admin runs their operator functions.
  '/api/a2a/agents', '/api/access-review', '/api/agents', '/api/antigravity/auth', '/api/claude-code/auth',
  '/api/gemini/auth', '/api/openai-codex/oauth', '/api/facebook-auth', '/api/batch-jobs', '/api/budgets',
  '/api/capability-providers', '/api/channels', '/api/config', '/api/connectors', '/api/dev-console', '/api/devops',
  '/api/join', '/api/memory', '/api/notify', '/api/ops/alert-pipeline', '/api/queue/dlq', '/api/swarm/agents',
  '/api/swarm/apps', '/api/swarm/config', '/api/swarm/memory', '/api/swarm/registries', '/api/swarm/roles',
  '/api/swarm/bots', '/api/swarm/packs', '/api/test-lab', '/api/token-chase', '/api/tools/verify',
  '/api/workflow-studio', '/api/governance', '/api/llm-governance', '/api/tenants', '/api/local-auth', '/api/rag',
  '/api/eval-wall', '/api/providers',
];

const ALLOWED = [...SWARM_ADMIN_SURFACE_PATHS, ...SWARM_ADMIN_API_PREFIXES];

/** True when `pathname` is `prefix` itself or lies beneath it. */
function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** @description Whether the swarm admin may reach this path. */
export function swarmAdminMayReach(pathname: string): boolean {
  return ALLOWED.some((prefix) => under(pathname, prefix));
}

/** @description True when the request's signed-in principal is the configuration-only swarm admin. */
export function isSwarmAdminPrincipal(req: Request): boolean {
  const oidc = (req as { oidc?: { isAuthenticated?: () => boolean; user?: { iss?: string; sub?: string; oshal_account_kind?: string } } }).oidc;
  if (!oidc?.isAuthenticated?.()) return false;
  const user = oidc.user ?? {};
  return user.oshal_account_kind === 'swarm-admin' || (user.iss === LOCAL_AUTH_PRINCIPAL_ISSUER && user.sub === SWARM_ADMIN_SUB);
}

/**
 * @description The gate (ADR-174 D1: the admin is not a user of the swarm). Mount once, after identity
 * resolution and before every route. API calls outside the admin's reach answer 403; pages redirect to
 * the admin console. A trusted service call carrying the admin's sub is refused: nothing runs as the admin.
 *
 * @returns Express middleware.
 */
export function createSwarmAdminScopeGuard(): RequestHandler {
  return (req, res, next) => {
    if (getTrustedServiceUserSub(req) === SWARM_ADMIN_SUB) {
      res.status(403).json({ error: 'swarm_admin_not_a_user', message: 'Nothing runs on behalf of the swarm admin.' });
      return;
    }
    if (!isSwarmAdminPrincipal(req) || swarmAdminMayReach(req.path)) return next();
    logger.info({ method: req.method, path: req.path }, 'swarm admin refused on a user surface');
    if (req.path.startsWith('/api/') || req.method !== 'GET') {
      res.status(403).json({
        error: 'swarm_admin_not_a_user',
        message: 'The swarm admin configures the swarm and has no personal workspace. Sign in with your own account to use it.',
      });
      return;
    }
    res.redirect(302, '/admin');
  };
}
