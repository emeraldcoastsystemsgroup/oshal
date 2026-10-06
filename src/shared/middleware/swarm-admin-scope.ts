/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 slice 2c: the swarm admin is not a user of the swarm. One global gate, mounted after identity resolution and before every route, lets the swarm-admin principal reach only swarm administration (admin pages, operator APIs, the mixed routers whose admin functions it runs, and its own sign-in) and refuses every personal surface: chat, tickets, tasks, connections, calendar, content, access tokens. A trusted service call acting as the admin's sub is refused outright. No-op for everyone else.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The reach list now covers what the admin's own pages call. Access management (/api/authorization) and the user directory are allowed. The operations dashboards get exact GET-only reads (runs and work items, active tickets, the scheduler, metrics, the mesh, refusals, the trace viewer shell), so those routers' write paths stay refused. The session (/api/auth/user) and /api/health are reachable too. /cockpit/tools narrows to the dead-letter and chat-channel tools; the other tool pages are personal.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The admin's pages load their assets. /config loads its CSS and JS from the /config-admin static alias (src/pages/config-admin only, inferred in ui-surface-routes), which the gate redirected to /admin, so /config never rendered for the admin: /config-admin joins the surface paths. Two static cockpit files get exact GET/HEAD reads: /cockpit/js/theme-manager.js, which the /config module graph imports (it imports nothing and holds no user data), and /cockpit/css/themes/<id>.css, which surface-themes.css imports on every admin page and the optimizer page links. The rest of the cockpit stays refused. SWARM_ADMIN_DASHBOARD_READS is renamed SWARM_ADMIN_EXACT_READS, since it now holds those asset reads too; its only references were in this file.
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
  '/login/admin', '/logout/admin', '/logout', '/api/admin-auth', '/api/local-auth/2fa', '/api/user', '/api/auth/user',
  '/api/health', '/shared', '/fonts', '/favicon.ico',
  // /config-admin is /config's own directory (src/pages/config-admin) under the static alias its page loads from.
  '/admin', '/users', '/access', '/access-review', '/app-loader', '/applications', '/config', '/config-admin', '/data-model',
  '/utilities', '/governance', '/eval-wall', '/process-lab', '/workflow-studio', '/health-dashboard',
  '/system-health', '/redis-visibility', '/queue-dashboard', '/queue-manager-admin', '/mesh-dashboard',
  '/ops-dashboard', '/swarm-control', '/alert-pipeline-admin', '/rag-center',
  // Only the administrative cockpit tools; the rest of /cockpit/tools are personal (devices, data export, TV pairing).
  '/cockpit/tools/dlq.html', '/cockpit/tools/channels.html',
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
  '/api/eval-wall', '/api/providers', '/api/authorization', '/api/user-directory',
];

/**
 * Exact reads into routers and directories that are otherwise personal or mixed. The operations dashboards read the
 * run and work queues, the active-ticket queue, the scheduler, metrics, the mesh, refusals and the trace viewer shell.
 * The admin pages load two static files from the cockpit directory: the theme catalogue the /config page imports
 * (theme-manager.js, which imports nothing and holds no user data) and the theme stylesheets that surface-themes.css
 * and the optimizer page pull in. GET and HEAD only, matched exactly, so the routers' write paths (submitting tickets
 * or schedules) and the rest of the cockpit stay refused.
 */
export const SWARM_ADMIN_EXACT_READS: readonly RegExp[] = [
  /^\/api\/swarm\/(runs|work-items)(\/[^/]+)?$/, /^\/api\/tickets\/active$/, /^\/api\/v1\/agent\/scheduler\/status$/,
  /^\/api\/v1\/agent\/schedules$/, /^\/api\/v1\/metrics\/(summary|agents)$/, /^\/api\/health-dashboard\/registry$/,
  /^\/api\/mesh\/channels$/, /^\/api\/ops\/refusals$/, /^\/api\/trace\/app(\/.*)?$/,
  /^\/cockpit\/js\/theme-manager\.js$/, /^\/cockpit\/css\/themes\/[a-z0-9-]+\.css$/,
];

const ALLOWED = [...SWARM_ADMIN_SURFACE_PATHS, ...SWARM_ADMIN_API_PREFIXES];

/** True when `pathname` is `prefix` itself or lies beneath it. */
function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** @description Whether the swarm admin may make this call. */
export function swarmAdminMayReach(pathname: string, method = 'GET'): boolean {
  if (ALLOWED.some((prefix) => under(pathname, prefix))) return true;
  return (method === 'GET' || method === 'HEAD') && SWARM_ADMIN_EXACT_READS.some((pattern) => pattern.test(pathname));
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
    if (!isSwarmAdminPrincipal(req) || swarmAdminMayReach(req.path, req.method)) return next();
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
