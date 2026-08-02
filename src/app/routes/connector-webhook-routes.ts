/**
 * Connector webhook ingress mount (ADR-065 — inbound events go live).
 *
 * Collects the `webhooks:` declared in every swarm-apps/connectors/*.yaml and serves them at
 * POST /api/hooks/:provider/:event — signature-verified (per the spec), deduped across replicas via
 * the oshal_webhook_deliveries table (migration 056), and turned into a swarm ticket. Machine-to-
 * machine, so it is mounted WITHOUT the OIDC wall (it self-guards by signature), mirroring the
 * existing Alertmanager webhook.
 *
 * Gated by CONNECTOR_WEBHOOKS. server.ts mounts this route through one guarded call; deployment
 * profiles decide whether the ingress is enabled.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Routed verified GitHub issue events through the configured idempotent ticket synchronizer
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Made connector webhook catalog read and parse failures visible in structured logs
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Exported connectorWebhookIngressEnabled() so the ON/OFF decision is a testable function instead of an inline env comparison in server.ts. ADR-065 Phase 4 listed "mount the webhook router" as outstanding while it was in fact mounted — nothing guarded that, so nothing noticed. The guard (tests/unit/connectors/connector-webhook-mount.spec.ts) now pins both halves: the gate, and that a mounted ingress REFUSES an unsigned or wrongly-signed delivery.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | BACKLOG "ENOMEM / healthy-but-degraded": the catalog read is no longer a one-shot readdirSync in a catch. The 2026-08-01 boot hit `ENOMEM: scandir '/app/swarm-apps/connectors'` in BOTH loadConnectorSpecs and loadWebhookEvents, and each logged once and served on with nothing loaded. It now goes through readCatalogDir (bounded retry on transient POSIX codes) and records the outcome so the /api/readiness `catalogs` leg fails a box whose webhook catalog is unreadable or parsed to nothing.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | MACHINE-WRITE IDENTITY (BACKLOG "Machine-write identity: audit every un-migrated identity-less WRITE"). This ingress was the third instance of the class that took down a2a-routes in July and the ADR-119 alert intake in August, and it failed in the second, quieter way: the dispatch ran under runWithSystemIdentity — the OPERATOR sentinel — so the INSERT was never refused, it simply landed a ticket with owner_sub = NULL. An owner-less row is invisible to every per-owner rail (RLS reads, "my tickets", budgets, DLQ attribution), and the operator stamp handed a party holding ONE connector's webhook secret read access across every tenant's tickets — precisely what Stage D's scan taught us to avoid. Replaced with the established rail: a synthetic namespaced webhookOwnerSub(provider) = `webhook:<provider>`, stamped via runWithRequestIdentity({ isOperator: false }) AFTER signature verification and stamped again as the row's owner_sub on both write paths (generic sink + the GitHub issue synchronizer). RLS is neither weakened nor bypassed and it holds under the K5 oshal_bot least-privilege posture. Guards: tests/unit/machine-write-identity.spec.ts (class-level) + tests/connector-webhook-rls-live.spec.ts (a REAL insert through REAL RLS).
 *
 * @module routes/connector-webhook-routes
 */

import path from 'path';
import express, { type Express } from 'express';
import { createChildLogger } from '@/shared/logger';
import { readCatalogDir, recordCatalogLoad } from '@/shared/observability';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { loadConnectorSpec } from '../connectors/runtime';
import {
  createWebhookIngressRouter, resolveSecret,
  type WebhookEvent, type WebhookEventSpec, type WebhookVerify,
} from '../connectors/webhooks/webhook-ingress';
import { dbSeenStore, ticketingWebhookHandler, type TicketSink } from '../connectors/webhooks/webhook-handlers';
import {
  createGitHubTicketWebhookSync,
  type GitHubTicketWebhookTicketService,
} from './github-ticket-webhook-sync';

const logger = createChildLogger({ module: 'connector-webhook-routes' });

/**
 * @description Whether this deployment serves the webhook ingress. The route is machine-to-machine
 * and sits OUTSIDE the OIDC wall (it self-guards by HMAC signature), so whether it exists at all is a
 * deployment decision — off unless CONNECTOR_WEBHOOKS is explicitly 'on'. Exported so the decision is
 * testable rather than an inline comparison buried in server.ts.
 * @param env - environment to read (defaults to process.env)
 * @returns true when the ingress should be mounted
 */
export function connectorWebhookIngressEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONNECTOR_WEBHOOKS === 'on';
}
const SPEC_DIR = path.join(process.cwd(), 'swarm-apps/connectors');

/** @description Catalog identity for the webhook-event load record (readiness reads it). */
export const WEBHOOK_EVENT_CATALOG = 'connector-webhook-events';

/**
 * @description Read every connector.yaml and flatten its declared webhooks into verified
 * event specs. The directory read retries transient POSIX errors and records its outcome
 * in the catalog registry — the same `ENOMEM: scandir '/app/swarm-apps/connectors'` that
 * emptied the connector catalog on 2026-08-01 hit this loader too, and a one-shot
 * `readdirSync` in a catch meant the box served a webhook ingress with zero verified
 * events while reporting ready.
 * @param specDir - Connector spec directory (defaults to `swarm-apps/connectors`).
 * @returns Every declared, verifiable webhook event spec.
 */
export function loadWebhookEvents(specDir = SPEC_DIR): WebhookEventSpec[] {
  const read = readCatalogDir(specDir, {
    catalog: WEBHOOK_EVENT_CATALOG,
    filter: (f) => f.endsWith('.yaml') || f.endsWith('.yml'),
  });
  const files = read.entries;
  const events: WebhookEventSpec[] = [];
  // Count PARSED SPECS, not events: most connectors declare no webhooks at all, so zero
  // events is normal — zero parsed specs from a directory full of them is the defect.
  let parsedSpecs = 0;
  for (const file of files) {
    let spec;
    try {
      spec = loadConnectorSpec(path.join(specDir, file));
      parsedSpecs += 1;
    } catch (error) {
      logger.warn({ err: error, file }, 'Skipping invalid connector webhook specification');
      continue;
    }
    for (const w of spec.webhooks || []) {
      const v = w.verify as { type?: string; header?: string; secret?: string };
      if (!v?.type || !v?.header) continue;
      events.push({
        provider: spec.provider,
        event: w.event,
        verify: { type: v.type, header: v.header, secret: resolveSecret(v.secret) } as WebhookVerify,
      });
    }
  }
  if (read.state === 'ok') {
    recordCatalogLoad({
      catalog: WEBHOOK_EVENT_CATALOG,
      source: specDir,
      state: files.length > 0 && parsedSpecs === 0 ? 'empty' : 'ok',
      discovered: files.length,
      loaded: parsedSpecs,
      attempts: read.attempts,
      detail: `${events.length} verifiable webhook event(s) across ${parsedSpecs} spec(s)`,
    });
  }
  return events;
}

/**
 * @description The synthetic, namespaced owner sub every webhook-born ticket is created under —
 * and the identity the ingress stamps on its database connection, so the two halves of the owner
 * RLS predicate agree (`owner_sub = current_setting('oshal.current_sub')`).
 *
 * WHY THIS EXISTS: POST /api/hooks/:provider/:event is a MACHINE caller. It authenticates with a
 * provider signature (HMAC / shared secret / JWT — webhook-ingress.ts `verifySignature`), never an
 * OIDC session, so the global request-identity middleware stamps anonymous non-operator. `tickets`
 * carries the enforce-stage owner policy, so an anonymous connection cannot insert into it at all
 * — the exact failure the ADR-119 alert intake hit live on 2026-08-01 ("new row violates row-level
 * security policy for table tickets"), and the one a2a-routes hit in July.
 *
 * THE RAIL THIS FOLLOWS is `ownerSubForA2aAgent()` (`a2a:<agentId>`) and `ALERT_INTAKE_OWNER_SUB`
 * (`alert:prometheus`): a namespaced synthetic sub, `isOperator: false`, stamped BOTH on the
 * connection and as the row's owner. Per-provider rather than one flat `webhook:*` because the
 * blast radius of a leaked provider secret should be that provider's own tickets and nothing else
 * — the GitHub sync's `getTicketByExternalId` lookup is scoped by the same predicate.
 *
 * DELIBERATELY NOT `runWithSystemIdentity` (which this handler previously used): the SYSTEM
 * sentinel is `isOperator: true`, so a party holding one connector's webhook secret would read
 * across every tenant's tickets, and the row it created carried NO owner at all — unattributable
 * to any per-owner rail. Deliberately not the deployment operator's sub either: that attributes
 * machine-authored work to a human who did not cause it.
 *
 * @param provider - The connector provider slug from the verified event (e.g. `github`).
 * @returns The synthetic owner sub, e.g. `webhook:github`.
 */
export function webhookOwnerSub(provider: string): string {
  return `webhook:${provider}`;
}

/** Adapt the swarm ticket service to the narrow TicketSink the handler needs, filling sane defaults. */
export function makeTicketSink(ticketService: { createTicket: (i: any) => Promise<{ ticketId: string }> }): TicketSink {
  return {
    createTicket: async (i) => ticketService.createTicket({
      title: i.title, ticketType: i.ticketType, description: i.description,
      externalProvider: i.externalProvider, externalId: i.externalId, externalUrl: null,
      status: 'backlog', workspaceId: null, assignedAgentId: null, parentTicketId: null,
      priority: 'medium', labels: i.labels, metadata: i.metadata,
      // The machine owner. Without it the owner-RLS WITH CHECK refuses the row outright once the
      // connection is stamped non-operator (see webhookOwnerSub above) — both halves ship together.
      ownerSub: i.ownerSub,
    }),
  };
}

/** Default event->ticket mapping (the mapper can be swapped per deployment). */
function defaultMapper(e: WebhookEvent) {
  const body = JSON.stringify(e.payload, null, 2).slice(0, 2000);
  return {
    title: `[${e.provider}] ${e.event}`,
    ticketType: 'intelligent-processing',
    description: `Inbound webhook from **${e.provider}** (event \`${e.event}\`).\n\n\`\`\`json\n${body}\n\`\`\``,
    labels: [],
  };
}

/**
 * @description Builds the verified-event dispatcher, specializing configured GitHub issue events while preserving generic connector behavior.
 *
 * IDENTITY: the whole dispatch runs under `runWithRequestIdentity({ sub: webhookOwnerSub(provider),
 * isOperator: false })`, established only AFTER `dispatchWebhook` has verified the provider
 * signature, so an unsigned delivery is rejected while still anonymous and never reaches the machine
 * identity. Both write paths (the generic ticket sink and the GitHub issue synchronizer) stamp that
 * same sub as the row's `owner_sub`, so the connection GUC and the row agree.
 *
 * @param ticketService - Canonical ticket service used by both webhook paths
 * @returns Webhook callback for the ingress router
 */
export function createConnectorWebhookHandler(
  ticketService: GitHubTicketWebhookTicketService,
): (event: WebhookEvent) => Promise<void> {
  const genericHandler = ticketingWebhookHandler(
    makeTicketSink(ticketService),
    defaultMapper,
    (e) => webhookOwnerSub(e.provider),
  );
  // The GitHub branch below is guarded on provider === 'github', so its owner is a constant —
  // built once, with the SAME sub the connection is stamped with for that provider.
  const githubIssueSync = createGitHubTicketWebhookSync({
    ticketService,
    ownerSub: webhookOwnerSub('github'),
  });

  return async (event) => runWithRequestIdentity(
    { sub: webhookOwnerSub(event.provider), isOperator: false },
    async () => {
      if (event.provider === 'github' && event.event === 'issues') {
        await githubIssueSync.handle(event.event, event.payload);
        return;
      }
      await genericHandler(event);
    },
  );
}

/**
 * Mount POST /api/hooks/:provider/:event. NOT behind requiresAuth — self-guarded by signature.
 * Returns the count of declared events wired. Caller gates behind CONNECTOR_WEBHOOKS.
 */
export function mountConnectorWebhookRoutes(
  app: Express,
  ctx: { pool: unknown; ticketService: GitHubTicketWebhookTicketService },
): number {
  const events = loadWebhookEvents();
  // Capture the raw body so HMAC verification sees the exact bytes the provider signed.
  const jsonWithRaw = express.json({ verify: (req, _res, buf) => { (req as { rawBody?: string }).rawBody = buf.toString('utf8'); } });
  const seen = dbSeenStore((sql, params) => (ctx.pool as { query: (s: string, p: unknown[]) => Promise<{ rows: unknown[] }> }).query(sql, params));
  const onEvent = createConnectorWebhookHandler(ctx.ticketService);
  app.use('/api/hooks', jsonWithRaw, createWebhookIngressRouter({
    events,
    onEvent,
    seen,
    deliveryIdHeader: 'x-github-delivery',
  }));
  logger.info({ events: events.length, providers: [...new Set(events.map((e) => e.provider))] }, 'ADR-065 connector webhook ingress mounted at /api/hooks/:provider/:event');
  return events.length;
}
