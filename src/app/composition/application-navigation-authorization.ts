/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Admit explicit browser workspace navigation and current shell-only member access without selecting a data workspace.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Explain denied document navigation with escaped static HTML while retaining API JSON and current policy decisions.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Accept the minimal navigation request shape so installed surfaces share workspace validation without unsafe Express casts.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Export roleGuidance(actor) — the one place that decides where the role-guidance page sends a person (access review for a swarm admin, the account page otherwise) — so the ADR-149 locked rail tile carries the same link the denial page offers. The rendered denial body is unchanged.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Explain a CATALOG-LESS refusal as a page too, and send an ordinary denied person to /access-review. applicationShell() cannot recognise the shell of a package that declares no catalog, because there are no bindings to match — yet `!app.catalog` is the only shape that raises authorization_app_admin_required, so the one refusal with nothing else to explain it fell through to res.status(403).json(...) and rendered as bare {"error":...,"decisionId":...} in the cockpit content pane. explainableNavigation() is presentation-only and is deliberately NOT used by authorizeApplicationNavigation, whose tenant retry stays bound to a declared shell binding. roleGuidance's non-admin branch moved from /users (swarm roles — that page states application permissions are managed separately) to /access-review, which answers "what am I allowed to do" and did not exist when this link was chosen; same requiresAuth-only page gate, so nobody reaches an administration surface they could not already reach.
 */
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { resolveOperationPermissions } from '@/features/application-authorization';
import type { AuthorizationActor, AuthorizationAppRegistration, AuthorizationDecision, AuthorizationOperation } from '@/shared/application-authorization';

const DENIED_STYLE = `body{margin:0;background:var(--bg-primary);color:var(--text-primary);font:16px/1.6 system-ui,sans-serif}
main{box-sizing:border-box;max-width:42rem;margin:8vh auto;padding:2rem}h1{font-size:1.65rem;line-height:1.25}
p{color:var(--text-secondary)}a{color:var(--accent-primary)}a:focus-visible{outline:2px solid currentColor;outline-offset:4px}nav{display:flex;gap:1.5rem;flex-wrap:wrap}`;
const DENIED_STYLE_HASH = createHash('sha256').update(DENIED_STYLE).digest('base64');

/** @description Identify the exact declared app-open binding without widening another read or write action.
 * @param registration Activated catalog. @param operation Matched request. @returns Whether this is a read-only shell binding.
 */
function applicationShell(registration: AuthorizationAppRegistration, operation: AuthorizationOperation): boolean {
  if (operation.kind !== 'http' || operation.method !== 'GET') return false;
  const permissions = resolveOperationPermissions({ ...registration, catalogRevision: '' }, operation);
  return permissions?.length === 1 && permissions[0] === 'app.open' && registration.catalog?.permissions['app.open']?.effect === 'read';
}

/** @description Escape a package display label for text-only HTML contexts.
 * @param value Installed label. @returns Escaped bounded text.
 */
function escapeLabel(value: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return value.slice(0, 160).replace(/[&<>"']/g, character => entities[character]);
}

/** @description Where the role-guidance page sends a person: application access administration for an active swarm
 * admin, who can act on the refusal; the read-only access review otherwise, which is the surface that answers
 * "what am I allowed to do" and names the source of every grant. Both are requiresAuth-only pages whose privileged
 * reads and every write are fenced inside their own APIs, so this chooses which explanation is useful, never who may
 * reach an administration surface. Shared with the cockpit rail so a locked tile (ADR-149) points where the denial
 * page does.
 * @param actor Verified caller. @returns Root-relative kernel page and the label the denial page shows for it.
 */
export function roleGuidance(actor: Pick<AuthorizationActor, 'isActive' | 'isSwarmAdmin'>): { href: string; label: string } {
  return actor.isActive && actor.isSwarmAdmin
    ? { href: '/access', label: 'Review application access' }
    : { href: '/access-review', label: 'See what you can access' };
}

/** @description Which denied requests the role-guidance page explains, as opposed to the JSON every API caller keeps.
 * A package with no authorization catalog declares no bindings at all, so applicationShell() — which has to see a
 * declared read-only `app.open` binding — can never recognise its shell; and `!app.catalog` is the only shape that
 * raises authorization_app_admin_required. That left the one refusal with nothing else to explain it falling through
 * to raw JSON in the cockpit content pane. Presentation only: it admits no request the policy did not already refuse,
 * and authorizeApplicationNavigation keeps using applicationShell() so its tenant retry stays bound to a declared
 * shell binding.
 * @param registration Activated registration. @param operation Denied request. @returns Whether the page explains this refusal.
 */
function explainableNavigation(registration: AuthorizationAppRegistration, operation: AuthorizationOperation): boolean {
  if (operation.kind !== 'http' || operation.method !== 'GET') return false;
  return !registration.catalog || applicationShell(registration, operation);
}

/** @description Render role guidance only for a denied browser document request; callers keep all other JSON errors.
 * @param req Current browser request. @param res Response. @param registration Active catalog.
 * @param operation Denied request. @param actor Verified caller. @param label Installed application display name.
 * @returns Whether the denial response was sent.
 */
export function sendApplicationNavigationDenied(req: Request, res: Response, registration: AuthorizationAppRegistration,
  operation: AuthorizationOperation, actor: AuthorizationActor, label: string): boolean {
  if (!explainableNavigation(registration, operation) || req.get('sec-fetch-mode') !== 'navigate' ||
    !['document', 'iframe', 'frame'].includes(req.get('sec-fetch-dest') ?? '') || !req.accepts('html')) return false;
  const name = escapeLabel(label || registration.app);
  const guidance = roleGuidance(actor);
  const action = `<a href="${guidance.href}" target="_top">${guidance.label}</a>`;
  res.status(403).set({ 'Cache-Control': 'private, no-store', 'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; script-src 'none'; style-src 'self' 'sha256-${DENIED_STYLE_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'` });
  res.send(`<!doctype html><html lang="en" data-theme="midnight"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Application role required — ${name}</title>
<link rel="stylesheet" href="/shared/ui/css/surface-themes.css"><style>${DENIED_STYLE}</style></head>
<body><main><h1>Application role required</h1><p>Your current access does not include <strong>${name}</strong>.</p>
<p>An administrator needs to review the application role for your account and workspace. Administrator access to OSHAL does not automatically grant access to application records.</p>
<nav aria-label="Access help">${action}<a href="/api/help" target="_top">Open help</a></nav></main></body></html>`);
  return true;
}

/** @description Read a browser GET selector using the same untrusted selection contract as the API header.
 * @param req Current request. @returns Valid selection or a closed malformed-input result.
 */
export function navigationWorkspace(req: Pick<Request, 'method' | 'url' | 'get'> & Partial<Pick<Request, 'originalUrl'>>): { valid: boolean; explicit: boolean; tenantId?: string } {
  const header = req.get('x-oshal-tenant-id');
  const parameters = new URL(req.originalUrl || req.url, 'http://navigation.invalid').searchParams;
  const values = req.method === 'GET' ? parameters.getAll('workspace') : [];
  if (req.method === 'GET' && (values.length > 1 || [...parameters.keys()].some(key => key.startsWith('workspace[')))) return { valid: false, explicit: true };
  const query = values[0];
  const valid = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
  if ((header !== undefined && !valid(header)) || (query !== undefined && !valid(query)) ||
    (header !== undefined && query !== undefined && header !== query)) return { valid: false, explicit: true };
  return { valid: true, explicit: header !== undefined || query !== undefined, tenantId: header || query || undefined };
}

/** @description Permit only a declared read-only application shell through current member grants when no workspace was selected.
 * @param registration Activated catalog. @param actor Verified current actor. @param operation Original HTTP operation.
 * @param explicit Whether the caller selected a workspace. @param authorize Current full policy check.
 * @returns Current decision; data operations and explicit selections never receive a fallback.
 */
export async function authorizeApplicationNavigation(registration: AuthorizationAppRegistration, actor: AuthorizationActor,
  operation: AuthorizationOperation, explicit: boolean,
  authorize: (operation: AuthorizationOperation) => Promise<AuthorizationDecision>): Promise<AuthorizationDecision> {
  const decision = await authorize(operation);
  if (decision.allowed || explicit || operation.method !== 'GET') return decision;
  if (!applicationShell(registration, operation)) return decision;
  for (const tenantId of actor.tenantIds ?? []) {
    const candidate = await authorize({ ...operation, tenantId });
    if (candidate.allowed) return candidate;
  }
  return decision;
}
