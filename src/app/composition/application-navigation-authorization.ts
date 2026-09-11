/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Admit explicit browser workspace navigation and current shell-only member access without selecting a data workspace.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Explain denied document navigation with escaped static HTML while retaining API JSON and current policy decisions.
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

/** @description Render role guidance only for a denied browser document request; callers keep all other JSON errors.
 * @param req Current browser request. @param res Response. @param registration Active catalog.
 * @param operation Denied request. @param actor Verified caller. @param label Installed application display name.
 * @returns Whether the denial response was sent.
 */
export function sendApplicationNavigationDenied(req: Request, res: Response, registration: AuthorizationAppRegistration,
  operation: AuthorizationOperation, actor: AuthorizationActor, label: string): boolean {
  if (!applicationShell(registration, operation) || req.get('sec-fetch-mode') !== 'navigate' ||
    !['document', 'iframe', 'frame'].includes(req.get('sec-fetch-dest') ?? '') || !req.accepts('html')) return false;
  const name = escapeLabel(label || registration.app);
  const action = actor.isActive && actor.isSwarmAdmin
    ? '<a href="/access" target="_top">Review application access</a>'
    : '<a href="/users" target="_top">View your account</a>';
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
export function navigationWorkspace(req: Request): { valid: boolean; explicit: boolean; tenantId?: string } {
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
