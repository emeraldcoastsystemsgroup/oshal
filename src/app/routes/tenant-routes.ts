/**
 * Tenant (household) management — ADR-042 Phase 1.
 *
 * Minimal API so a user can create a household (a `space` tenant), add members, and
 * see which households they belong to — enough to make SHARED connections usable:
 * create a household → connect a hub to it at /utilities → every member's bot uses it.
 * Full provisioning/invites (email links, leave, role UI) are ADR-042 Phase 3.
 *
 * Auth-gated (mounted behind requiresAuth). Every route scopes to the signed-in caller;
 * member management is admin-only (enforced in connector-tenancy.addMember).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — GET/POST /api/tenants (list mine / create household), POST /:id/members (admin add), GET /:id/connections (member-visible shared connections). Backs the /utilities household selector.
 *
 * @module tenant-routes
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import {
  createTenant, addMember, listUserTenants, isTenantMember, accessibleConnections,
  listTenantMembers, removeMember, setMemberRole,
} from './connector-tenancy';

const logger = createChildLogger({ module: 'tenant-routes' });

/** Pull the signed-in user's sub from the OIDC session (null if unauthenticated). */
function callerSub(req: Request): string | null {
  const oidc = (req as any).oidc;
  if (!oidc || typeof oidc.isAuthenticated !== 'function' || !oidc.isAuthenticated()) return null;
  const u = oidc.user || {};
  const sub = u.sub || u.oid;
  return sub ? String(sub) : null;
}

/**
 * @description Tenant management sub-router (mounted at /api/tenants, requiresAuth).
 * @param ctx - app context (db pool)
 * @returns an Express router
 */
export function createTenantRoutes(ctx: AppContext): Router {
  const router = Router();

  /** GET /api/tenants — households (and orgs) the caller belongs to, with their role. */
  router.get('/', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not authenticated' }); return; }
    try {
      res.json({ tenants: await listUserTenants(ctx.pool, sub) });
    } catch (err: any) {
      logger.error({ err }, 'list tenants failed');
      res.status(500).json({ error: err.message });
    }
  });

  /** POST /api/tenants { name, kind? } — create a household (default kind 'space'); caller becomes admin. */
  router.post('/', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not authenticated' }); return; }
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) { res.status(400).json({ error: 'name is required' }); return; }
    const kind = String((req.body && req.body.kind) || 'space').trim() === 'org' ? 'org' : 'space';
    try {
      res.json({ tenant: await createTenant(ctx.pool, { name, createdBySub: sub, kind }) });
    } catch (err: any) {
      logger.error({ err }, 'create tenant failed');
      res.status(500).json({ error: err.message });
    }
  });

  /** POST /api/tenants/:id/members { memberSub, role? } — add a member (caller must be admin). */
  router.post('/:id/members', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not authenticated' }); return; }
    const memberSub = String((req.body && req.body.memberSub) || '').trim();
    if (!memberSub) { res.status(400).json({ error: 'memberSub is required' }); return; }
    const role = String((req.body && req.body.role) || 'member');
    try {
      await addMember(ctx.pool, String(req.params.id), memberSub, sub, role);
      res.json({ success: true });
    } catch (err: any) {
      const code = /admin/.test(err.message || '') ? 403 : 500;
      logger.error({ err, tenantId: req.params.id }, 'add member failed');
      res.status(code).json({ error: err.message });
    }
  });

  /** GET /api/tenants/:id/members — members of a tenant with their role (members only). */
  router.get('/:id/members', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not authenticated' }); return; }
    const tenantId = String(req.params.id);
    try {
      if (!(await isTenantMember(ctx.pool, tenantId, sub))) { res.status(403).json({ error: 'not a member' }); return; }
      res.json({ members: await listTenantMembers(ctx.pool, tenantId) });
    } catch (err: any) {
      logger.error({ err, tenantId }, 'list members failed');
      res.status(500).json({ error: err.message });
    }
  });

  /** PATCH /api/tenants/:id/members/:sub { role } — change a member's role (admin; cannot demote last admin). */
  router.patch('/:id/members/:sub', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not authenticated' }); return; }
    const role = String((req.body && req.body.role) || '').trim();
    try {
      await setMemberRole(ctx.pool, String(req.params.id), String(req.params.sub), role, sub);
      res.json({ success: true });
    } catch (err: any) {
      const code = /admin|not found/.test(err.message || '') ? 403 : 500;
      logger.error({ err, tenantId: req.params.id }, 'set member role failed');
      res.status(code).json({ error: err.message });
    }
  });

  /** DELETE /api/tenants/:id/members/:sub — remove a member (caller must be admin; cannot remove last admin). */
  router.delete('/:id/members/:sub', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not authenticated' }); return; }
    try {
      await removeMember(ctx.pool, String(req.params.id), String(req.params.sub), sub);
      res.json({ success: true });
    } catch (err: any) {
      const code = /admin/.test(err.message || '') ? 403 : 500;
      logger.error({ err, tenantId: req.params.id }, 'remove member failed');
      res.status(code).json({ error: err.message });
    }
  });

  /** GET /api/tenants/:id/connections — connected providers shared in this tenant (members only). */
  router.get('/:id/connections', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not authenticated' }); return; }
    const tenantId = String(req.params.id);
    try {
      if (!(await isTenantMember(ctx.pool, tenantId, sub))) { res.status(403).json({ error: 'not a member' }); return; }
      const rows = (await accessibleConnections(ctx.pool, sub))
        .filter((r) => String(r.tenant_id) === tenantId)
        .map((r) => ({ provider: r.provider, account: r.account_email }));
      res.json({ connections: rows });
    } catch (err: any) {
      logger.error({ err, tenantId }, 'tenant connections failed');
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
