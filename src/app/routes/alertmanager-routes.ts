/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prometheus Alertmanager webhook -> incident ticket intake for swarm self-healing
 */

/**
 * Alertmanager webhook intake — turns Prometheus alerts about the swarm's own
 * containers into incident tickets that flow through the incident-rca pipeline.
 *
 * Flow (self-healing on itself):
 *   cAdvisor/Prometheus watch the oshal-* containers
 *     -> Alertmanager fires on a rule (container down, restart loop, unhealthy)
 *       -> POST /api/alerts/alertmanager (this route)
 *         -> approved? create incident ticket (externalProvider: 'prometheus')
 *           -> incident-rca pipeline investigates + proposes a fix
 *             -> ticket lands at the approve-or-close gate (human-in-the-loop)
 *
 * "Approved alert" gate: only firing alerts whose alertname is in
 * ALERT_APPROVED_NAMES (comma-separated) become tickets. If that env var is
 * unset, every firing alert is accepted (dev default) and logged.
 *
 * Auth: machine-to-machine, so this router is mounted WITHOUT the OIDC
 * requiresAuth guard. It self-guards with a shared bearer token when
 * ALERT_WEBHOOK_TOKEN is set (recommended). Alertmanager sends it via its
 * http_config bearer_token / authorization config.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { createChildLogger } from '@/shared/logger';
import { hmacWebhookGuard } from '@/features/security';
import type { TicketService } from '@/features/ticketing';
import { TicketTypeSchema, type TicketPriority } from '@/entities/ticket';

const logger = createChildLogger({ module: 'alertmanager-routes' });

/** One alert inside an Alertmanager v4 webhook payload. */
interface AlertmanagerAlert {
  status?: 'firing' | 'resolved';
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
  generatorURL?: string;
  fingerprint?: string;
}

/** Alertmanager v4 webhook envelope. */
interface AlertmanagerPayload {
  version?: string;
  status?: 'firing' | 'resolved';
  groupLabels?: Record<string, string>;
  commonLabels?: Record<string, string>;
  alerts?: AlertmanagerAlert[];
}

/** Map an alert severity label to a ticket priority. */
function severityToPriority(severity?: string): TicketPriority {
  switch ((severity || '').toLowerCase()) {
    case 'critical':
    case 'page':
      return 'urgent';
    case 'warning':
    case 'major':
      return 'high';
    case 'minor':
      return 'medium';
    case 'info':
    case 'none':
      return 'low';
    default:
      return 'medium';
  }
}

/** Best-effort human label for the failing target (container > pod > instance). */
function targetOf(labels: Record<string, string>): string {
  return (
    labels.container ||
    labels.container_name ||
    labels.name ||
    labels.pod ||
    labels.instance ||
    labels.job ||
    'unknown-target'
  );
}

/** Build the incident ticket body from the alert. */
function buildDescription(alert: AlertmanagerAlert, intakeStatus: 'approved' | 'backlog'): string {
  const labels = alert.labels ?? {};
  const ann = alert.annotations ?? {};
  const target = targetOf(labels);
  const labelLines = Object.entries(labels)
    .map(([k, v]) => `- **${k}:** ${v}`)
    .join('\n');

  const intakeLine = intakeStatus === 'backlog'
    ? 'Intake: BACKLOG — parked for operator triage. Pull it into the incident-rca pipeline from the cockpit ticket surface when you want it worked.'
    : 'Intake: APPROVED — auto-flows into the incident-rca pipeline now; the proposed remediation is gated at the approve-or-close step before any container action.';

  return [
    `**Alert:** ${labels.alertname || 'unnamed alert'}`,
    `**Target:** ${target}`,
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
 * @returns Express router exposing POST / (mount at /api/alerts/alertmanager).
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
   * Alertmanager webhook receiver. Accepts the v4 payload, opens one incident
   * ticket per approved firing alert (deduped by fingerprint while active).
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
      res.json({ success: true, created: 0, skipped: 0, message: 'no alerts in payload' });
      return;
    }

    const created: string[] = [];
    let skipped = 0;
    let resolved = 0;
    let backlogged = 0;

    for (const alert of alerts) {
      const labels = alert.labels ?? {};
      const alertname = labels.alertname || 'UnnamedAlert';
      const fingerprint = alert.fingerprint || `${alertname}:${targetOf(labels)}`;

      // Resolved alerts: don't open work; just dedupe-tag a note for the trace.
      if (alert.status === 'resolved') {
        resolved += 1;
        logger.info({ alertname, fingerprint }, 'Alert resolved (no ticket action)');
        continue;
      }

      // "Approved alert" gate.
      if (approvedNames && !approvedNames.has(alertname)) {
        skipped += 1;
        logger.info({ alertname }, 'Alert not in ALERT_APPROVED_NAMES; skipping');
        continue;
      }

      // Dedupe: don't reopen if an active ticket already exists for this alert.
      try {
        const existing = await ticketService.findActiveTicketByMetadataKey('alertFingerprint', fingerprint);
        if (existing) {
          skipped += 1;
          logger.info({ alertname, fingerprint, ticketId: existing.ticketId }, 'Active ticket already exists for alert; skipping');
          continue;
        }
      } catch (err) {
        logger.warn({ err, alertname }, 'Dedupe lookup failed; proceeding to create');
      }

      const severity = labels.severity || 'warning';
      const target = targetOf(labels);
      // approved => auto-flows into incident-rca; backlog => waits for operator triage.
      const intakeStatus = resolveIntakeStatus(alertname, labels);

      try {
        const ticket = await ticketService.createTicket({
          title: `[${severity}] ${alertname} on ${target}`,
          ticketType,
          description: buildDescription(alert, intakeStatus),
          // Trusted monitoring provider: ticket-service honors the status we pass
          // (approved auto-flows into incident-rca; backlog waits). Any fix is still
          // gated at the pipeline's approve-or-close step regardless.
          externalProvider: 'prometheus',
          externalId: fingerprint,
          externalUrl: alert.generatorURL ?? null,
          status: intakeStatus,
          workspaceId: null,
          assignedAgentId: null,
          parentTicketId: null,
          priority: severityToPriority(severity),
          labels: [
            'prometheus',
            'incident',
            'self-healing',
            'rca-requested',
            `severity:${severity}`,
            `target:${target}`,
            `intake:${intakeStatus}`,
          ],
          metadata: {
            source: 'prometheus',
            alertFingerprint: fingerprint,
            alertname,
            severity,
            target,
            intake: intakeStatus,
            startsAt: alert.startsAt ?? null,
            rawLabels: labels,
          },
        });
        created.push(ticket.ticketId);
        if (intakeStatus === 'backlog') backlogged += 1;
        logger.info({ ticketId: ticket.ticketId, alertname, target, intake: intakeStatus }, 'Opened incident ticket from Prometheus alert');
      } catch (err) {
        logger.error({ err, alertname }, 'Failed to create incident ticket from alert');
      }
    }

    res.json({
      success: true,
      created: created.length,
      backlogged,
      autoFlowed: created.length - backlogged,
      ticketIds: created,
      skipped,
      resolved,
    });
  });

  return router;
}
