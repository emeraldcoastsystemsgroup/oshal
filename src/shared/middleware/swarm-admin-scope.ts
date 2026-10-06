/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 slice 2c: the swarm admin is not a user of the swarm. One global gate, mounted after identity resolution and before every route, lets the swarm-admin principal reach only swarm administration (admin pages, operator APIs, the mixed routers whose admin functions it runs, and its own sign-in) and refuses every personal surface: chat, tickets, tasks, connections, calendar, content, access tokens. A trusted service call acting as the admin's sub is refused outright. No-op for everyone else.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The reach list now covers what the admin's own pages call. Access management (/api/authorization) and the user directory are allowed. The operations dashboards get exact GET-only reads (runs and work items, active tickets, the scheduler, metrics, the mesh, refusals, the trace viewer shell), so those routers' write paths stay refused. The session (/api/auth/user) and /api/health are reachable too. /cockpit/tools narrows to the dead-letter and chat-channel tools; the other tool pages are personal.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The admin's pages load their assets. /config loads its CSS and JS from the /config-admin static alias (src/pages/config-admin only, inferred in ui-surface-routes), which the gate redirected to /admin, so /config never rendered for the admin: /config-admin joins the surface paths. Two static cockpit files get exact GET/HEAD reads: /cockpit/js/theme-manager.js, which the /config module graph imports (it imports nothing and holds no user data), and /cockpit/css/themes/<id>.css, which surface-themes.css imports on every admin page and the optimizer page links. The rest of the cockpit stays refused. SWARM_ADMIN_DASHBOARD_READS is renamed SWARM_ADMIN_EXACT_READS, since it now holds those asset reads too; its only references were in this file.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 S02: the reach list is exact before any admin account exists. Broad prefixes also covered routes that act as the caller, so they are narrowed to exact calls, each checked against its route file. (1) SWARM_ADMIN_SUB and isSwarmAdminPrincipal move to the leaf module swarm-admin-identity.ts (besides the express Request type it imports only ./principal-issuer, so authz.ts and deployment-mode.ts can use it without a cycle) and are re-exported here. (2) SWARM_ADMIN_NEVER_PREFIXES (/api/remote-clients, /api/cli-tokens, /api/join) is checked first, on the lower-cased path because Express 5 routes case-insensitively, and refuses every method on the prefix and beneath it: the worker plane, the caller's own CLI tokens, and enrolment, the node installer, the add-computer page and the join code that prints the shared secret. No admin page calls any of them. (3) SWARM_ADMIN_EXACT_READS becomes the method-aware SWARM_ADMIN_EXACT_CALLS ({ methods, pattern }); every pattern is anchored and matched against the lower-cased path, so a case variant cannot slip past a narrower pattern. (4) Narrowed: /api/connectors to the marketplace reads and operator enable/disable/remove/audit-refresh/delete (refused: connector calls as the caller, which for the admin run on the deployment's shared provider accounts, writes included; the for-me overrides; my-enablement; the caller's action trail); /api/channels to /api/channels/admin, GET /api/channels and Telegram webhook registration (refused: linking an outside chat to the caller); /api/swarm/memory to /api/swarm/memory/agents and the operator approval (refused: shared store, query and context, which act as the caller); /api/notify to POST operator|alert (refused: the caller's prefs and test send); /api/dev-console to GET access; /api/join leaves the reach list for the never-list. (5) The audit of the remaining prefixes narrowed seven more, each refusing exactly the routes named here. /api/swarm/apps refuses only POST /:name/clone, which always makes a personal app owned by the caller; every read, load, publish, import, install-remote, per-user access, guest tier, toggle, schedule control (PATCH /:name/schedules/:id), service activation and deactivation, and uninstall stay. Service activation stays for the system class only: the class travels in the request body, which this gate does not read, so application-service-activation-routes.ts refuses the swarm admin runsAs 'user' (403 swarm_admin_not_a_user). A user activation makes the caller the service's principal and runs every tick as the caller. /api/swarm/packs refuses only POST /import/n8n, which saves a draft into the caller's own pack folder; reads and deploy stay. The /api/user surface path refuses PUT /api/user/onboarding, the caller's onboarding progress; GET /api/user, the session read, stays. Four become reads only, because every write in them acts as the caller: /api/security (scans and findings are stored per caller, a scan and an escalation file tickets owned by the caller, high and critical ones dispatched, and an assessment runs the security-analyst bot as the caller on its own LLM connection); /api/personal-graph (the ingest pulls connector data with the caller's token, or the deployment's when the caller has none); /api/test-lab (the golden run files dispatched build tickets owned by the caller and runs brain turns as the caller, and the scenario run, package runs and schedules act as the caller); and /api/persona-evals (its one write, POST /run, grades every answer with quality-judge brain turns run as the caller, each opening a chat task owned by the caller; no admin page calls it). Every operator-only mount stays reachable for reads. The RAG upload and ingest choose their owner from the request body too, so rag-routes.ts refuses the swarm admin a document it would own itself (an explicit private ingest, a metadata owner_sub naming it, or any ingest while it lacks the operator role); its writes to the shared corpus stay, and no admin page uploads or ingests. (6) A refused path the router reads as an API call answers 403 whatever its case. (7) Exactness against path tricks: a path with a '.' or '..' segment or a percent-encoded dot, slash or backslash is refused before any rule (static serving collapses them inside its mount), and the two cockpit tool pages are exact calls instead of prefixes, so /cockpit/tools/dlq.html/../../index.html cannot reach the cockpit shell.
 */

import type { RequestHandler } from 'express';
import { createChildLogger } from '@/shared/logger';
import { getTrustedServiceUserSub } from './authz';
import { SWARM_ADMIN_SUB, isSwarmAdminPrincipal } from './swarm-admin-identity';

// Re-exported so existing imports of the identity from this module keep working.
export { SWARM_ADMIN_SUB, isSwarmAdminPrincipal };

const logger = createChildLogger({ module: 'swarm-admin-scope' });

/**
 * Never reachable by the swarm admin, whatever any other rule says: the node worker plane
 * (/api/remote-clients: register, heartbeat, chat, swarm queues, tasks, task workspaces, prints,
 * token rotation, owner), the caller's own CLI access tokens (/api/cli-tokens), and enrolment
 * (/api/join: enrol a computer as the caller, the node installer, the add-computer page and the
 * join code that embeds the shared secret). Checked first, on the lower-cased path.
 */
export const SWARM_ADMIN_NEVER_PREFIXES: readonly string[] = ['/api/remote-clients', '/api/cli-tokens', '/api/join'];

/** Pages, assets and session endpoints of the admin's own surface. */
export const SWARM_ADMIN_SURFACE_PATHS: readonly string[] = [
  '/login/admin', '/logout/admin', '/logout', '/api/admin-auth', '/api/local-auth/2fa', '/api/auth/user',
  '/api/health', '/shared', '/fonts', '/favicon.ico',
  // /config-admin is /config's own directory (src/pages/config-admin) under the static alias its page loads from.
  '/admin', '/users', '/access', '/access-review', '/app-loader', '/applications', '/config', '/config-admin', '/data-model',
  '/utilities', '/governance', '/eval-wall', '/process-lab', '/workflow-studio', '/health-dashboard',
  '/system-health', '/redis-visibility', '/queue-dashboard', '/queue-manager-admin', '/mesh-dashboard',
  '/ops-dashboard', '/swarm-control', '/alert-pipeline-admin', '/rag-center',
];

/**
 * APIs the swarm admin runs: the operator-only mounts, plus the mixed routers whose administrative
 * functions it owns (swarm defaults and logins, roles, users and households, budgets, the shared
 * knowledge corpus, operations). A router whose writes act as the caller, operator-only or not, is not
 * listed here: the admin gets exact calls into it instead (SWARM_ADMIN_EXACT_CALLS), and every
 * operator-only mount stays reachable for reads. Personal surfaces are deliberately absent.
 */
export const SWARM_ADMIN_API_PREFIXES: readonly string[] = [
  // Operator-only mounts. /api/security, /api/personal-graph and /api/persona-evals are read-only exact calls instead.
  '/api/admin', '/api/bot', '/api/logs', '/api/process-lab', '/api/proxy-health', '/api/qm',
  '/api/redis-visibility', '/api/swarm/ops', '/api/updates',
  // Mixed routers: the admin runs their operator functions. /api/test-lab is a read-only exact call instead.
  // /api/rag is the shared corpus; its upload and ingest pick the owner from the body, which this gate does not
  // read, so rag-routes.ts itself refuses the swarm admin a document it would own.
  '/api/a2a/agents', '/api/access-review', '/api/agents', '/api/antigravity/auth', '/api/claude-code/auth',
  '/api/gemini/auth', '/api/openai-codex/oauth', '/api/facebook-auth', '/api/batch-jobs', '/api/budgets',
  '/api/capability-providers', '/api/config', '/api/devops', '/api/memory', '/api/ops/alert-pipeline',
  '/api/queue/dlq', '/api/swarm/agents', '/api/swarm/config', '/api/swarm/registries', '/api/swarm/roles',
  '/api/swarm/bots', '/api/token-chase', '/api/tools/verify', '/api/workflow-studio',
  '/api/governance', '/api/llm-governance', '/api/tenants', '/api/local-auth', '/api/rag', '/api/eval-wall',
  '/api/providers', '/api/authorization', '/api/user-directory',
  // The operator halves of mixed routers: the Discord bot setup card (chat-channel-admin-routes.ts) and
  // per-agent memory administration (extensions/swarm/routes/memory-routes.ts, operator-gated per route).
  '/api/channels/admin', '/api/swarm/memory/agents',
];

/** One exact call the swarm admin may make: the HTTP methods allowed and the anchored pattern of the lower-cased path. */
export interface SwarmAdminExactCall {
  readonly methods: readonly string[];
  readonly pattern: RegExp;
}

const READ: readonly string[] = ['GET', 'HEAD'];

/**
 * Exact calls into routers and directories that are otherwise personal or mixed, matched against the
 * lower-cased path (the form Express 5 routes) and only for the listed methods. Every pattern is anchored
 * and written in lower case. Each group names the route file it was checked against.
 */
export const SWARM_ADMIN_EXACT_CALLS: readonly SwarmAdminExactCall[] = [
  // Only the two administrative cockpit tools, matched exactly: express.static at /cockpit collapses dot
  // segments, so a prefix entry here would expose every file under src/pages/cockpit. The other tool pages
  // are personal (devices, data export, TV pairing).
  { methods: READ, pattern: /^\/cockpit\/tools\/(dlq|channels)\.html$/ },
  // The operations dashboards read the run and work queues, the active tickets, the scheduler, metrics, the
  // mesh, refusals and the trace viewer shell; those routers' writes (tickets, schedules) stay refused.
  { methods: READ, pattern: /^\/api\/swarm\/(runs|work-items)(\/[^/]+)?$/ },
  { methods: READ, pattern: /^\/api\/tickets\/active$/ },
  { methods: READ, pattern: /^\/api\/v1\/agent\/scheduler\/status$/ },
  { methods: READ, pattern: /^\/api\/v1\/agent\/schedules$/ },
  { methods: READ, pattern: /^\/api\/v1\/metrics\/(summary|agents)$/ },
  { methods: READ, pattern: /^\/api\/health-dashboard\/registry$/ },
  { methods: READ, pattern: /^\/api\/mesh\/channels$/ },
  { methods: READ, pattern: /^\/api\/ops\/refusals$/ },
  { methods: READ, pattern: /^\/api\/trace\/app(\/.*)?$/ },
  // Two static cockpit files the admin pages load: the theme catalogue /config imports (imports nothing,
  // holds no user data) and the theme stylesheets surface-themes.css and the optimizer page pull in.
  { methods: READ, pattern: /^\/cockpit\/js\/theme-manager\.js$/ },
  { methods: READ, pattern: /^\/cockpit\/css\/themes\/[a-z0-9-]+\.css$/ },
  // The session read (server.ts GET /api/user). GET and PUT /api/user/onboarding are the caller's own progress.
  { methods: READ, pattern: /^\/api\/user\/?$/ },
  // Connector marketplace (connector-marketplace-routes.ts): the catalogue, its audit export and one entry,
  // and the operator-gated deployment enable/disable/remove/audit-refresh/delete. Refused: connector calls
  // through shared deployment logins (/:provider/:resource, /_resources, /:id/actions/*), the caller's
  // enable-for-me/disable-for-me overrides and my-enablement, and the caller's action trail (/actions/audit).
  { methods: READ, pattern: /^\/api\/connectors\/marketplace(\/audit-export)?\/?$/ },
  { methods: READ, pattern: /^\/api\/connectors\/marketplace\/(?!my-enablement\/?$)[a-z0-9][a-z0-9-]*\/?$/ },
  { methods: ['POST'], pattern: /^\/api\/connectors\/marketplace\/[a-z0-9][a-z0-9-]*\/(enable|disable|remove|audit-refresh)\/?$/ },
  { methods: ['DELETE'], pattern: /^\/api\/connectors\/marketplace\/[a-z0-9][a-z0-9-]*\/?$/ },
  // Chat channels (chat-channel-routes.ts): the deployment's channel state and the operator-only Telegram
  // webhook registration. Refused: minting a link code or unlinking, which would tie an outside chat to the caller.
  { methods: READ, pattern: /^\/api\/channels\/?$/ },
  { methods: ['POST'], pattern: /^\/api\/channels\/telegram\/register-webhook$/ },
  // Shared swarm memory (extensions/swarm/routes/memory-routes.ts): the operator approval that promotes an
  // entry. Refused: shared/store, shared/query and shared/context, which store and read as the caller.
  { methods: ['POST'], pattern: /^\/api\/swarm\/memory\/shared\/[^/]+\/approve$/ },
  // Notifications (notify-routes.ts): the operator-only alerts over the deployment transport. Refused: the
  // caller's own notification preferences and the test send to the caller.
  { methods: ['POST'], pattern: /^\/api\/notify\/(operator|alert)$/ },
  // Developer console (dev-console-routes.ts): the access probe /applications makes. Everything else stays refused:
  // the caller's own self-edit sessions and their commits, apply and promote on the live tree, and the status reads.
  { methods: READ, pattern: /^\/api\/dev-console\/access$/ },
  // Applications (swarm-app-routes.ts and the routers it registers: app-store-remote.ts,
  // app-schedule-control-routes.ts, application-service-activation-routes.ts): every read, plus load, publish,
  // import, install-remote, per-user access, guest tier, toggle, schedule control, service activation and
  // deactivation, and uninstall. Refused: POST /:name/clone, which always makes a personal app owned by the caller.
  // The activation names its principal class in the body, which this gate does not read: the activation route
  // itself refuses the swarm admin runsAs 'user' (a user activation runs every tick as the caller), so the
  // admin activates services only as the application.
  { methods: READ, pattern: /^\/api\/swarm\/apps(\/.*)?$/ },
  { methods: ['POST'], pattern: /^\/api\/swarm\/apps\/(load|publish|import|install-remote)$/ },
  { methods: ['PUT'], pattern: /^\/api\/swarm\/apps\/[^/]+\/access$/ },
  { methods: ['PATCH'], pattern: /^\/api\/swarm\/apps\/[^/]+\/(guest-tier|toggle|schedules\/[^/]+)$/ },
  { methods: ['POST'], pattern: /^\/api\/swarm\/apps\/[^/]+\/services\/[^/]+\/activate$/ },
  { methods: ['DELETE'], pattern: /^\/api\/swarm\/apps\/[^/]+\/services\/[^/]+\/activation$/ },
  { methods: ['DELETE'], pattern: /^\/api\/swarm\/apps\/[^/]+$/ },
  // Packs (swarm-pack-routes.ts): the reads, including the Packs page /applications links to, and the
  // portal-admin deploy. Refused: POST /import/n8n, which saves a draft into the caller's own pack folder, and POST /:name/deploy, which loads a pack from the caller's own folder with the caller as owner (it can never succeed for the admin, whose folder no allowed call fills).
  { methods: READ, pattern: /^\/api\/swarm\/packs(\/.*)?$/ },
  // Security Center (security-routes.ts, operator-only): the page, status and findings reads. Refused: every
  // write, because each acts as the caller. Scans and findings are stored per caller. POST /scan also files
  // Trivy findings as tickets owned by the caller. POST /findings/:id/ticket files one, approved (so
  // dispatched) for high and critical. POST /findings/:id/assess runs the security-analyst bot as the caller
  // on the caller's own LLM connection. PATCH /findings/:id triages the caller's finding. POST
  // /api/security/csp-report is registered before this gate (server.ts) and never reaches it.
  { methods: READ, pattern: /^\/api\/security(\/.*)?$/ },
  // Personal graph (personal-graph-routes.ts, operator-only, off unless PERSONAL_GRAPH_ROUTES=on): the reads
  // of the shared graph. Refused: POST /ingest/:provider (personal-graph-ingest-routes.ts), which pulls
  // connector data with the caller's own token, or with the deployment's CONNECTOR_<X>_TOKEN when the caller
  // has none, for any resource the connector defines: a connector call as the caller, refused above too.
  { methods: READ, pattern: /^\/api\/personal-graph(\/.*)?$/ },
  // Test Lab (test-lab-routes.ts, test-lab-golden.ts, test-lab-run-routes.ts, test-lab-schedule-routes.ts):
  // the page, catalogs, visuals and the run, batch and schedule reads. Refused: every write. POST /golden/run
  // files approved build tickets owned by the caller, which the swarm dispatches at once, and runs judge and
  // fix brain turns as the caller; POST /run drives the scenario steps with the caller's session; /runs,
  // /runs/:id/cancel, /schedules, PATCH /schedules/:id and /schedules/:id/run-now run and schedule as the caller.
  { methods: READ, pattern: /^\/api\/test-lab(\/.*)?$/ },
  // Persona evals (persona-eval-routes.ts, operator-only; no admin page calls it): the suites, a run's status and
  // the stored reports. Refused: POST /run, which grades every answer with quality-judge brain turns run as the
  // caller (ctx.orchestrator.processMessage with userSub set to the caller, which pins that userSub for the bot
  // and opens a chat task owned by the caller).
  { methods: READ, pattern: /^\/api\/persona-evals(\/.*)?$/ },
];

/** The rule sets the gate decides with: the never-list first, then the prefixes, then the exact calls. */
export interface SwarmAdminReachRules {
  readonly never: readonly string[];
  readonly prefixes: readonly string[];
  readonly exactCalls: readonly SwarmAdminExactCall[];
}

const SWARM_ADMIN_REACH_RULES: SwarmAdminReachRules = {
  never: SWARM_ADMIN_NEVER_PREFIXES,
  prefixes: [...SWARM_ADMIN_SURFACE_PATHS, ...SWARM_ADMIN_API_PREFIXES],
  exactCalls: SWARM_ADMIN_EXACT_CALLS,
};

/**
 * A '.' or '..' path segment, or a percent-encoded dot, slash or backslash. Static file serving decodes the
 * path and collapses dot segments inside its mount, so such a path could reach a file the matched rule
 * never named. No admin page sends one, so the gate refuses them outright for the swarm admin.
 */
const DOT_SEGMENT_OR_ENCODED_SEPARATOR = /%2e|%2f|%5c|(?:^|\/)\.{1,2}(?:\/|$)/i;

/** True when `pathname` is `prefix` itself or lies beneath it. */
function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * @description Whether the swarm admin may make this call. The never-list is checked first, on the
 * lower-cased path, so no other rule can reopen it. Prefix rules compare the path as sent: every prefix
 * is lower case, so a case variant of an allowed prefix is refused (no admin page sends one). Exact calls
 * compare the lower-cased path, the form the router matches, so a case variant cannot slip past a
 * narrower pattern.
 *
 * @param pathname - The request path (Express `req.path`), without the query string.
 * @param method - The HTTP method; defaults to GET.
 * @param rules - The rule sets to decide with; the gate's own unless a guard proves an ordering property.
 * @returns True when the admin may make the call.
 */
export function swarmAdminMayReach(pathname: string, method = 'GET', rules: SwarmAdminReachRules = SWARM_ADMIN_REACH_RULES): boolean {
  if (DOT_SEGMENT_OR_ENCODED_SEPARATOR.test(pathname)) return false;
  const canonical = pathname.toLowerCase();
  if (rules.never.some((prefix) => under(canonical, prefix))) return false;
  if (rules.prefixes.some((prefix) => under(pathname, prefix))) return true;
  const verb = method.toUpperCase();
  return rules.exactCalls.some((call) => call.methods.includes(verb) && call.pattern.test(canonical));
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
    if (req.path.toLowerCase().startsWith('/api/') || req.method !== 'GET') {
      res.status(403).json({
        error: 'swarm_admin_not_a_user',
        message: 'The swarm admin configures the swarm and has no personal workspace. Sign in with your own account to use it.',
      });
      return;
    }
    res.redirect(302, '/admin');
  };
}
