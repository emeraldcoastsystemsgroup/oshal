/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add per-user enablement routes (BACKLOG.md:2718) alongside the untouched deployment routes: POST /marketplace/:provider/enable-for-me, POST /marketplace/:provider/disable-for-me, and GET /marketplace/my-enablement — each scoped to callerFromRequest(req).sub (the whole router is already requiresAuth-gated in server.ts). NON-BREAKING override layer; deployment enable/disable/remove behavior is unchanged.
 *
 * @module connector-marketplace-routes
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { emitAuditEvent, callerFromRequest } from '@/features/governance';
import type { AppContext } from '../composition-root';
import type { ConnectorMarketplaceEntry, ConnectorMarketplaceSummary } from '../connectors/runtime/marketplace';

const logger = createChildLogger({ module: 'connector-marketplace-routes' });

/**
 * Audit a deployment-level connector action (enable/disable/remove) to the append-only
 * access trail. Best-effort and non-throwing: delegates to emitAuditEvent (which self-heals
 * the schema and swallows errors) and no-ops when no pool is available, so auditing can never
 * block or break a connector action. Exported for unit coverage of the event mapping.
 */
export async function emitConnectorAudit(
  pool: Pool | null | undefined,
  actorSub: string | null,
  action: string,
  provider: string,
): Promise<boolean> {
  if (!pool) return false;
  return emitAuditEvent(pool, {
    actorSub,
    action,
    resourceType: 'connector',
    resourceId: provider,
    decision: 'allow',
    metadata: { surface: 'marketplace' },
  });
}

export interface ConnectorAuditExport {
  generatedAt: string;
  exportedAt: string;
  totals: ConnectorMarketplaceSummary['totals'];
  entries: Array<{
    id: string;
    label: string;
    category: string;
    installState: ConnectorMarketplaceEntry['installState'];
    enabled: boolean;
    riskLevel: ConnectorMarketplaceEntry['riskLevel'];
    authType: ConnectorMarketplaceEntry['authType'];
    credProvider: string;
    onboarding: ConnectorMarketplaceEntry['onboarding'];
    sourcePath: string;
    resourceCount: number;
    toolCount: number;
    readCount: number;
    writeCount: number;
    destructiveCount: number;
    audit: ConnectorMarketplaceEntry['audit'];
    actions: ConnectorMarketplaceEntry['actions'];
  }>;
}

/**
 * @description ADR-067 connector marketplace routes.
 *
 * These routes manage deployment-level connector enablement. Credentials remain per-user and
 * broker-resolved at execution time; enabling only exposes the audited connector definition and
 * its scoped framework tools. The `*-for-me` / `my-enablement` routes add a per-user OVERRIDE
 * layer (BACKLOG.md:2718) on top: a connector is usable for a caller when it is deployment-enabled
 * AND NOT explicitly user-disabled (absence of an override = allowed). The whole router is mounted
 * behind requiresAuth in server.ts, so every route here — including the per-user ones — is authed.
 */
export function createConnectorMarketplaceRoutes(ctx: AppContext): Router {
  const router = Router();

  // ── Per-user enablement OVERRIDE layer (BACKLOG.md:2718) ─────────────────────
  // Registered BEFORE `/marketplace/:provider` so `/marketplace/my-enablement`
  // is not captured by the :provider param. Scoped to the authenticated caller.
  router.get('/marketplace/my-enablement', async (req: Request, res: Response) => {
    const sub = callerFromRequest(req).sub ?? null;
    if (!sub) {
      res.status(401).json({ success: false, error: 'Not authenticated' });
      return;
    }
    try {
      const [overrides, enabledForUser] = await Promise.all([
        ctx.connectorMarketplaceService.userEnablementRows(sub),
        ctx.connectorMarketplaceService.enabledProviderSetForUser(sub),
      ]);
      res.json({
        success: true,
        data: {
          overrides,
          disabledProviders: overrides.filter((row) => row.enabled === false).map((row) => row.provider),
          enabledForUser: Array.from(enabledForUser).sort(),
        },
      });
    } catch (error) {
      logger.warn({ err: error }, 'Connector marketplace my-enablement read failed');
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'my-enablement read failed' });
    }
  });

  router.post('/marketplace/:provider/enable-for-me', (req, res) => perUserEnablement(ctx, req, res, true));
  router.post('/marketplace/:provider/disable-for-me', (req, res) => perUserEnablement(ctx, req, res, false));

  router.get('/marketplace', (req: Request, res: Response) => {
    const summary = ctx.connectorMarketplaceService.list();
    res.json({ success: true, data: req.query.full === '1' ? summary : compactSummary(summary) });
  });

  router.get('/marketplace/audit-export', (req: Request, res: Response) => {
    const auditExport = buildConnectorAuditExport(ctx.connectorMarketplaceService.list());
    if (String(req.query.format || '').toLowerCase() === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="connector-marketplace-audit-export.csv"');
      res.send(connectorAuditExportCsv(auditExport));
      return;
    }
    res.json({ success: true, data: auditExport });
  });

  router.get('/marketplace/:provider', (req: Request, res: Response) => {
    const entry = ctx.connectorMarketplaceService.get(String(req.params.provider));
    if (!entry) {
      res.status(404).json({ success: false, error: 'Connector not found' });
      return;
    }
    res.json({ success: true, data: entry });
  });

  router.post('/marketplace/:provider/enable', async (req: Request, res: Response) => {
    try {
      const provider = String(req.params.provider);
      const entry = ctx.connectorMarketplaceService.enableProvider(provider);
      const registrations = await ctx.connectorSpecToolService.registerConnectorProvider(
        provider,
        ctx.toolRegistryService,
        ctx.dynamicToolExecutorRegistry,
      );
      await emitConnectorAudit(ctx.pool, callerFromRequest(req).sub ?? null, 'connector.enable', provider);
      res.json({
        success: true,
        data: {
          entry,
          registeredTools: registrations.map((registration) => registration.tool.name),
          summary: ctx.connectorMarketplaceService.list().totals,
        },
      });
    } catch (error) {
      logger.warn({ err: error, provider: req.params.provider }, 'Connector marketplace enable failed');
      res.status(statusFor(error)).json({
        success: false,
        error: error instanceof Error ? error.message : 'Connector enable failed',
      });
    }
  });

  router.post('/marketplace/:provider/disable', async (req: Request, res: Response) => {
    try {
      const provider = String(req.params.provider);
      const entry = ctx.connectorMarketplaceService.disableProvider(provider);
      const deregisteredTools = await ctx.connectorSpecToolService.deregisterConnectorProvider(
        provider,
        ctx.toolRegistryService,
        ctx.dynamicToolExecutorRegistry,
      );
      await emitConnectorAudit(ctx.pool, callerFromRequest(req).sub ?? null, 'connector.disable', provider);
      res.json({
        success: true,
        data: {
          entry,
          deregisteredTools,
          summary: ctx.connectorMarketplaceService.list().totals,
        },
      });
    } catch (error) {
      logger.warn({ err: error, provider: req.params.provider }, 'Connector marketplace disable failed');
      res.status(statusFor(error)).json({
        success: false,
        error: error instanceof Error ? error.message : 'Connector disable failed',
      });
    }
  });

  const removeProvider = async (req: Request, res: Response) => {
    try {
      const provider = String(req.params.provider);
      const entry = ctx.connectorMarketplaceService.removeProvider(provider);
      const deregisteredTools = await ctx.connectorSpecToolService.deregisterConnectorProvider(
        provider,
        ctx.toolRegistryService,
        ctx.dynamicToolExecutorRegistry,
      );
      await emitConnectorAudit(ctx.pool, callerFromRequest(req).sub ?? null, 'connector.remove', provider);
      res.json({
        success: true,
        data: {
          entry,
          deregisteredTools,
          summary: ctx.connectorMarketplaceService.list().totals,
        },
      });
    } catch (error) {
      logger.warn({ err: error, provider: req.params.provider }, 'Connector marketplace remove failed');
      res.status(statusFor(error)).json({
        success: false,
        error: error instanceof Error ? error.message : 'Connector remove failed',
      });
    }
  };

  router.post('/marketplace/:provider/remove', removeProvider);
  router.delete('/marketplace/:provider', removeProvider);

  router.post('/marketplace/:provider/audit-refresh', async (req: Request, res: Response) => {
    try {
      const provider = String(req.params.provider);
      const entry = ctx.connectorMarketplaceService.refreshProviderAudit(provider);
      const deregisteredTools = !entry.enabled
        ? await ctx.connectorSpecToolService.deregisterConnectorProvider(
          provider,
          ctx.toolRegistryService,
          ctx.dynamicToolExecutorRegistry,
        )
        : [];
      const registrations = entry.enabled
        ? await ctx.connectorSpecToolService.registerConnectorProvider(
          provider,
          ctx.toolRegistryService,
          ctx.dynamicToolExecutorRegistry,
        )
        : [];
      res.json({
        success: true,
        data: {
          entry,
          registeredTools: registrations.map((registration) => registration.tool.name),
          deregisteredTools,
          summary: ctx.connectorMarketplaceService.list().totals,
        },
      });
    } catch (error) {
      logger.warn({ err: error, provider: req.params.provider }, 'Connector marketplace audit refresh failed');
      res.status(statusFor(error)).json({
        success: false,
        error: error instanceof Error ? error.message : 'Connector audit refresh failed',
      });
    }
  });

  return router;
}

/**
 * @description Apply a per-user connector enablement override for the authenticated caller and
 * return the caller's refreshed enablement state. NON-BREAKING: an `enabled=false` override blocks
 * the connector for this caller only; `enabled=true` is an explicit opt-in. Deployment state and
 * every other user are unaffected. 401 when unauthenticated; audited to the access trail.
 * @param ctx - app context (marketplace service + pool)
 * @param req - the authed request (provider param + caller sub)
 * @param res - the response
 * @param enabled - true = enable-for-me, false = disable-for-me
 * @returns resolves after the response is sent
 */
async function perUserEnablement(ctx: AppContext, req: Request, res: Response, enabled: boolean): Promise<void> {
  const provider = String(req.params.provider);
  const sub = callerFromRequest(req).sub ?? null;
  if (!sub) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }
  try {
    if (enabled) {
      await ctx.connectorMarketplaceService.enableProviderForUser(sub, provider);
    } else {
      await ctx.connectorMarketplaceService.disableProviderForUser(sub, provider);
    }
    await emitConnectorAudit(ctx.pool, sub, enabled ? 'connector.enable-for-user' : 'connector.disable-for-user', provider);
    const [overrides, enabledForUser] = await Promise.all([
      ctx.connectorMarketplaceService.userEnablementRows(sub),
      ctx.connectorMarketplaceService.enabledProviderSetForUser(sub),
    ]);
    res.json({
      success: true,
      data: {
        provider,
        enabled,
        usable: enabledForUser.has(provider),
        overrides,
        enabledForUser: Array.from(enabledForUser).sort(),
      },
    });
  } catch (error) {
    logger.warn({ err: error, provider }, `Connector marketplace ${enabled ? 'enable' : 'disable'}-for-me failed`);
    res.status(statusFor(error)).json({
      success: false,
      error: error instanceof Error ? error.message : 'Per-user enablement failed',
    });
  }
}

function compactSummary(summary: ConnectorMarketplaceSummary): ConnectorMarketplaceSummary {
  return {
    ...summary,
    entries: summary.entries.map(compactEntry),
  };
}

function compactEntry(entry: ConnectorMarketplaceEntry): ConnectorMarketplaceEntry {
  return {
    ...entry,
    actions: entry.actions.slice(0, 8),
    audit: {
      ...entry.audit,
      issues: entry.audit.issues.slice(0, 8),
    },
  };
}

export function buildConnectorAuditExport(summary: ConnectorMarketplaceSummary): ConnectorAuditExport {
  return {
    generatedAt: summary.generatedAt,
    exportedAt: new Date().toISOString(),
    totals: summary.totals,
    entries: summary.entries.map((entry) => ({
      id: entry.id,
      label: entry.label,
      category: entry.category,
      installState: entry.installState,
      enabled: entry.enabled,
      riskLevel: entry.riskLevel,
      authType: entry.authType,
      credProvider: entry.credProvider,
      onboarding: entry.onboarding,
      sourcePath: entry.source.path,
      resourceCount: entry.resourceCount,
      toolCount: entry.toolCount,
      readCount: entry.readCount,
      writeCount: entry.writeCount,
      destructiveCount: entry.destructiveCount,
      audit: entry.audit,
      actions: entry.actions,
    })),
  };
}

export function connectorAuditExportCsv(auditExport: ConnectorAuditExport): string {
  const headers = [
    'id',
    'label',
    'category',
    'installState',
    'enabled',
    'riskLevel',
    'authType',
    'credProvider',
    'onboardingMode',
    'setupLevel',
    'credentialScope',
    'resources',
    'tools',
    'reads',
    'writes',
    'destructive',
    'auditPass',
    'auditErrors',
    'auditWarnings',
    'sourcePath',
  ];
  const rows = auditExport.entries.map((entry) => [
    entry.id,
    entry.label,
    entry.category,
    entry.installState,
    String(entry.enabled),
    entry.riskLevel,
    entry.authType,
    entry.credProvider,
    entry.onboarding.mode,
    entry.onboarding.setupLevel,
    entry.onboarding.credentialScope,
    String(entry.resourceCount),
    String(entry.toolCount),
    String(entry.readCount),
    String(entry.writeCount),
    String(entry.destructiveCount),
    String(entry.audit.pass),
    String(entry.audit.errors),
    String(entry.audit.warnings),
    entry.sourcePath,
  ]);
  return [headers, ...rows]
    .map((row) => row.map(csvCell).join(','))
    .join('\n') + '\n';
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function statusFor(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/not in the local marketplace catalog|not found/i.test(message)) {
    return 404;
  }
  if (/audit gate|cannot be enabled/i.test(message)) {
    return 400;
  }
  return 500;
}
