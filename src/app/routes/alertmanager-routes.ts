/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prometheus Alertmanager webhook -> incident ticket intake for swarm self-healing
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P1 (ADR-119): intake now runs Stage A canonicalization + Stage C consolidation (@/features/alert-triage) — a refire on an open incident UPDATES that ticket (updateCount/lastSeen/priority-escalation) instead of the old silent skipped++; unapproved alertnames are counted as noise per-alertname instead of vanishing; identity-less alerts drop counted; and GET /intake-stats (same fail-closed bearer guard) serves the FR-A3 decision counters. severityToPriority/targetOf moved into the feature so create + escalate rank severities identically
 */

/**
 * Alertmanager webhook intake — turns Prometheus alerts about the swarm's own
 * containers into incident tickets that flow through the incident-rca pipeline.
 *
 * Flow (self-healing on itself):
 *   cAdvisor/Prometheus watch the oshal-* containers
 *     -> Alertmanager fires on a rule (container down, restart loop, unhealthy)
 *       -> POST /api/alerts/alertmanager (this route)
 *         -> approved? consolidate (ADR-119 P1): refire of an open incident updates
 *            that ticket; otherwise create one (externalProvider: 'prometheus')
 *           -> incident-rca pipeline investigates + proposes a fix
 *             -> ticket lands at the approve-or-close gate (human-in-the-loop)
 *
 * "Approved alert" gate: only firing alerts whose alertname is in
 * ALERT_APPROVED_NAMES (comma-separated) become tickets. If that env var is
 * unset, every firing alert is accepted (dev default) and logged. Unapproved
 * alerts are COUNTED as noise per alertname (FR-A3) — never an uncounted vanish.
 *
 * Auth: machine-to-machine, so this router is mounted WITHOUT the OIDC
 * requiresAuth guard. It self-guards with a shared bearer token when
 * ALERT_WEBHOOK_TOKEN is set (recommended). Alertmanager sends it via its
 * http_config bearer_token / authorization config. GET /intake-stats shares the
 * same fail-closed guard (see tests/helpers/unguarded-route-allowlist.ts —
 * keeping the whole family self-guarded keeps the route-auth inventory truthful).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { createChildLogger } from '@/shared/logger';
import { hmacWebhookGuard } from '@/features/security';
import type { TicketService } from '@/features/ticketing';
import {
  AlertConsolidationService,
  AlertIntakeStats,
  canonicalizeAlert,
  type CanonicalAlert,
  type RawAlertmanagerAlert,
} from '@/features/alert-triage';
import { TicketTypeSchema } from '@/entities/ticket';

const logger = createChildLogger({ module: 'alertmanager-routes' });

/** Alertmanager v4 webhook envelope. */
interface AlertmanagerPayload {
  version?: string;
  status?: 'firing' | 'resolved';
  groupLabels?: Record<string, string>;
  commonLabels?: Record<string, string>;
  alerts?: RawAlertmanagerAlert[];
}

/** Build the incident ticket body from the alert. */
function buildDescription(
  alert: RawAlertmanagerAlert,
  canonical: CanonicalAlert,
  intakeStatus: 'approved' | 'backlog',
): string {
  const labels = alert.labels ?? {};
  const ann = alert.annotations ?? {};
  const labelLines = Object.entries(labels)
    .map(([k, v]) => `- **${k}:** ${v}`)
    .join('\n');

  const intakeLine = intakeStatus === 'backlog'
    ? 'Intake: BACKLOG — parked for operator triage. Pull it into the incident-rca pipeline from the cockpit ticket surface when you want it worked.'
    : 'Intake: APPROVED — auto-flows into the incident-rca pipeline now; the proposed remediation is gated at the approve-or-close step before any container action.';

  return [
    `**Alert:** ${canonical.alertname || 'unnamed alert'}`,
    `**Target:** ${canonical.target || 'unknown-target'}`,
    `**Severity:** ${labels.severity || 'unknown'}`,
    `**Fired at:** ${alert.startsAt || 'unknown'}`,
    '',
    ann.summary ? `**Summary:** ${ann.summary}` : '',
    ann.description ? `\n${ann.description}` : '',
    '',
    '**Labels**',
    labelLines || '- (none)',
    '',
    ann.runbook_url ? `**Runbook:** ${ann.runbook_url}` : '',
    '',
    '---',
    'Source: Prometheus Alertmanager (swarm self-monitoring).',
    intakeLine,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * @description Mounts the Alertmanager webhook intake route.
 * @param ticketService - The DB-backed ticket service (multi-tenant, persistent).
 * @returns Express router exposing POST /alertmanager + GET /intake-stats
 *   (mount at /api/alerts).
 */
export function createAlertmanagerRoutes(ticketService: TicketService): Router {
  const router = Router();

  // Approved-alert allowlist. Unset => accept all firing alerts (dev default).
  const approvedRaw = (process.env.ALERT_APPROVED_NAMES || '').trim();
  const approvedNames = approvedRaw
    ? new Set(approvedRaw.split(',').map((s) => s.trim()).filter(Boolean))
    : null;

  // Backlog-intake policy. Some alerts should NOT auto-flow into the incident-rca
  // pipeline — they land as `backlog` so an operator triages them from the cockpit
  // ticket surface (Status=Backlog, Type=Incident) and pulls them in manually.
  // Resolution order, first match wins:
  //   1. per-alert label `intake` ("backlog"/"manual"/"queue" vs "auto"/"approved")
  //   2. alertname in ALERT_BACKLOG_NAMES -> backlog
  //   3. ALERT_DEFAULT_INTAKE (default "approved" = auto-flow, as before)
  const backlogRaw = (process.env.ALERT_BACKLOG_NAMES || '').trim();
  const backlogNames = backlogRaw
    ? new Set(backlogRaw.split(',').map((s) => s.trim()).filter(Boolean))
    : new Set<string>();
  const defaultIntake: 'approved' | 'backlog' =
    (process.env.ALERT_DEFAULT_INTAKE || 'approved').trim().toLowerCase() === 'backlog'
      ? 'backlog'
      : 'approved';

  const resolveIntakeStatus = (alertname: string, labels: Record<string, string>): 'approved' | 'backlog' => {
    const hint = (labels.intake || labels.ticket_status || '').toLowerCase();
    if (hint === 'backlog' || hint === 'manual' || hint === 'queue') return 'backlog';
    if (hint === 'auto' || hint === 'approved' || hint === 'flow') return 'approved';
    if (backlogNames.has(alertname)) return 'backlog';
    return defaultIntake;
  };

  // Queue (ticketType) these alerts land in. Default is the dedicated
  // `intelligent-processing` workflow so self-healing alerts filter cleanly and
  // never mix with generic `incident` work. Routed through incident-rca by the
  // swarm-apps/intelligent-processing.yaml manifest. Validated against the enum
  // so a bad ALERT_TICKET_TYPE falls back instead of inserting a junk type.
  const ticketTypeParse = TicketTypeSchema.safeParse((process.env.ALERT_TICKET_TYPE || 'intelligent-processing').trim());
  const ticketType = ticketTypeParse.success ? ticketTypeParse.data : 'intelligent-processing';

  const webhookToken = (process.env.ALERT_WEBHOOK_TOKEN || '').trim();

  // ADR-119 P1: intake decision counters (FR-A3) + the Stage C consolidator.
  // TicketService structurally satisfies TriageTicketGateway — the feature slice
  // stays decoupled from the ticketing slice (FSD same-layer rule).
  const stats = new AlertIntakeStats();
  const consolidation = new AlertConsolidationService(ticketService);

  // Shared-secret guard for machine-to-machine posting (Alertmanager bearer token).
  // FAIL-CLOSED: with no ALERT_WEBHOOK_TOKEN configured the receiver rejects everything.
  // This endpoint is mounted WITHOUT the OIDC wall, so an unset token previously let any
  // internet caller forge incident tickets into the self-healing pipeline.
  const guard = (req: Request, res: Response, next: NextFunction): void => {
    if (!webhookToken) {
      logger.warn('Rejected Alertmanager webhook: ALERT_WEBHOOK_TOKEN is not configured');
      res.status(401).json({ success: false, error: 'webhook token not configured' });
      return;
    }
    const auth = req.header('authorization') || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
    if (bearer === webhookToken || queryToken === webhookToken) {
      next();
      return;
    }
    logger.warn('Rejected Alertmanager webhook: bad or missing token');
    res.status(401).json({ success: false, error: 'unauthorized' });
  };

  /**
   * POST /api/alerts/alertmanager
   * Alertmanager webhook receiver. Accepts the v4 payload; each approved firing
   * alert consolidates onto the open ticket for its incident key or opens one
   * (ADR-119 P1 — ten identical alerts are ONE ticket carrying updateCount=9).
   */
  // Defense-in-depth body integrity on top of the bearer `guard`. No-op until
  // ALERT_WEBHOOK_HMAC_SECRET is set, so default behavior is unchanged. NOTE before
  // enabling: this needs the RAW request bytes — global express.json() has already
  // parsed the body here, so the module's fallback re-serializes req.body, which only
  // byte-matches if Alertmanager's signer used identical JSON. Wire a raw-body capture
  // (express.json({ verify }) ahead of this route) before turning the secret on.
  const hmacGuard = hmacWebhookGuard({
    secretEnv: 'ALERT_WEBHOOK_HMAC_SECRET',
    header: 'x-alert-signature-256',
    prefix: 'sha256=',
  });

  router.post('/alertmanager', guard, hmacGuard, async (req: Request, res: Response) => {
    const payload = (req.body || {}) as AlertmanagerPayload;
    const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];

    if (alerts.length === 0) {
      res.json({ success: true, created: 0, consolidated: 0, message: 'no alerts in payload' });
      return;
    }

    const created: string[] = [];
    const consolidated: string[] = [];
    let noise = 0;
    let dropped = 0;
    let resolved = 0;
    let backlogged = 0;

    for (const alert of alerts) {
      // Stage A: canonicalize + identity gate (FR-A1/A2). Identity-less alerts are
      // unactionable — dropped AND counted (reason=no_identity), never invisible.
      const canonical = canonicalizeAlert(alert);
      if (!canonical) {
        stats.record('dropped');
        dropped += 1;
        continue;
      }

      // Resolved alerts: don't open work; count the decision for the trace (FR-A3).
      // Resolved-handling (member resolution, ALERT_AUTO_RESOLVE) is P3 (FR-E4).
      if (canonical.status === 'resolved') {
        stats.record('resolved');
        resolved += 1;
        logger.info({ alertname: canonical.alertname, fingerprint: canonical.fingerprint }, 'Alert resolved (no ticket action)');
        continue;
      }

      // "Approved alert" gate — unclaimed alerts are NOISE: counted per alertname
      // (queryable via GET /intake-stats) so the allowlist can be tuned from
      // evidence. This replaces the pre-P1 uncounted vanish (FR-B2-lite/FR-A3).
      if (approvedNames && !approvedNames.has(canonical.alertname)) {
        stats.record('noise', canonical.alertname);
        noise += 1;
        logger.info({ alertname: canonical.alertname }, 'Alert not in ALERT_APPROVED_NAMES — counted as noise, no ticket');
        continue;
      }

      // approved => auto-flows into incident-rca; backlog => waits for operator triage.
      const intakeStatus = resolveIntakeStatus(canonical.alertname, canonical.labels);

      // Stage C: consolidate (FR-C2/C3/C4/C5/C6). Refire of an open incident updates
      // that ticket; otherwise a new ticket opens (recurrence-linked within the TTL).
      try {
        const outcome = await consolidation.intake(canonical, {
          title: `[${canonical.severity}] ${canonical.alertname || 'UnnamedAlert'} on ${canonical.target || 'unknown-target'}`,
          ticketType,
          description: buildDescription(alert, canonical, intakeStatus),
          intakeStatus,
          externalUrl: alert.generatorURL ?? null,
        });
        if (outcome.decision === 'created') {
          stats.record('created');
          created.push(outcome.ticketId);
          if (intakeStatus === 'backlog') backlogged += 1;
          logger.info(
            { ticketId: outcome.ticketId, alertname: canonical.alertname, target: canonical.target, intake: intakeStatus },
            'Opened incident ticket from Prometheus alert',
          );
        } else {
          stats.record('consolidated');
          consolidated.push(outcome.ticketId);
        }
      } catch (err) {
        logger.error({ err, alertname: canonical.alertname }, 'Failed to intake alert into the ticket queue');
      }
    }

    res.json({
      success: true,
      created: created.length,
      consolidated: consolidated.length,
      noise,
      dropped,
      resolved,
      backlogged,
      autoFlowed: created.length - backlogged,
      ticketIds: created,
      consolidatedTicketIds: consolidated,
    });
  });

  /**
   * GET /api/alerts/intake-stats
   * FR-A3: every intake decision, queryable — totals per decision class plus the
   * per-alertname noise breakdown ("top noise sources"). Same fail-closed bearer
   * guard as the webhook: the /api/alerts family mounts outside the OIDC wall and
   * must never be open by omission.
   */
  router.get('/intake-stats', guard, (_req: Request, res: Response) => {
    res.json({ success: true, stats: stats.snapshot() });
  });

  return router;
}
