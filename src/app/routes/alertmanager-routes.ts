/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prometheus Alertmanager webhook -> incident ticket intake for swarm self-healing
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P1 (ADR-119): intake now runs Stage A canonicalization + Stage C consolidation (@/features/alert-triage) — a refire on an open incident UPDATES that ticket (updateCount/lastSeen/priority-escalation) instead of the old silent skipped++; unapproved alertnames are counted as noise per-alertname instead of vanishing; identity-less alerts drop counted; and GET /intake-stats (same fail-closed bearer guard) serves the FR-A3 decision counters. severityToPriority/targetOf moved into the feature so create + escalate rank severities identically
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P2 (ADR-119 Stage D): a firing alert that did not consolidate now BUNDLES onto an open related incident (same target, or dependency-connected within ALERT_CORRELATION_DEPTH, inside ALERT_CORRELATION_WINDOW) instead of opening a sibling ticket — the api-down drill is ONE ticket with members + rootCandidate, not three tickets and three RCA bills. `bundled` joins the response counts and the FR-A3 stats; outcome tallying extracted so the handler stays within the function cap
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P3 (ADR-119 Stage B + E): the claim REGISTRY replaces the inline ALERT_APPROVED_NAMES set as the noise gate — rules {match, incidentKey?, intake?, bundleHints?} from ALERT_CLAIMS_FILE, with ALERT_APPROVED_NAMES surviving as a pure-claim shorthand (identical behavior) and no registry at all keeping the accept-all dev default. A claim's key template re-keys the canonical alert (Stage A hand-off), its intake slots between the per-alert label (SRE wins) and the env defaults, and its rootFilter rides to genesis. ALERT_UNCLAIMED_POLICY=backlog parks unclaimed alerts instead of dropping them. Resolved events now DO something (FR-E4): consolidation.intakeResolved marks members / opt-in self-closes. The route accepts an optional RcaSpendReader so the app layer can wire the FR-E2 budget gate's cost-ledger actuals
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | LIVE FIX (container-kill drill, 2026-08-01): the intake could not create a ticket AT ALL — "new row violates row-level security policy for table tickets". Alertmanager is a machine caller with no user identity, so the global request-identity middleware stamped anonymous non-operator and the owner-RLS WITH CHECK refused every INSERT; every P1–P4 guard passed because they all stub the ticket gateway. The authenticated intake now runs under runWithRequestIdentity({ sub: ALERT_INTAKE_OWNER_SUB, isOperator: false }) — the A2A gateway's synthetic-machine-sub rail (ownerSubForA2aAgent), NOT the operator sentinel — and the consolidation service stamps the same sub as owner_sub. Least-privilege on purpose: a non-operator intake scopes Stage D's bundle scan to alert-born tickets instead of every tenant's. Applied AFTER the bearer + HMAC guards so an unauthenticated caller never reaches the machine identity
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
 *            that ticket; else bundle (ADR-119 P2): a RELATED alert — same target or
 *            dependency-connected within the correlation window — attaches to the
 *            open incident as a member; otherwise create one (externalProvider:
 *            'prometheus')
 *           -> incident-rca pipeline investigates + proposes a fix
 *             -> ticket lands at the approve-or-close gate (human-in-the-loop)
 *
 * Claim gate (ADR-119 Stage B): a firing alert becomes a ticket only when a rule
 * in the claim registry claims it — rules load from ALERT_CLAIMS_FILE, and every
 * ALERT_APPROVED_NAMES entry remains valid as a pure-claim shorthand. With NO
 * registry configured at all, every firing alert is accepted (dev default).
 * Unclaimed alerts are COUNTED as noise per alertname (FR-A3) — never an
 * uncounted vanish — or parked as backlog tickets when
 * ALERT_UNCLAIMED_POLICY=backlog (the cautious migration setting).
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
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import {
  ALERT_INTAKE_OWNER_SUB,
  AlertBundlingService,
  AlertClaimRegistry,
  AlertConsolidationService,
  AlertIntakeStats,
  RcaBudgetGate,
  canonicalizeAlert,
  unclaimedPolicy,
  type CanonicalAlert,
  type ClaimResolution,
  type ConsolidationOutcome,
  type RawAlertmanagerAlert,
  type RcaSpendReader,
} from '@/features/alert-triage';
import { TicketTypeSchema } from '@/entities/ticket';

const logger = createChildLogger({ module: 'alertmanager-routes' });

/**
 * @description Optional app-layer wiring for the alert intake (all seams default off/null
 * so the P1/P2 call shape keeps working unchanged).
 */
export interface AlertmanagerRouteOptions {
  /** FR-E2 actuals source (the per-event cost ledger); null/absent = budget gate passes through. */
  rcaSpend?: RcaSpendReader | null;
}

/** Per-request intake tally backing the webhook response counts. */
interface IntakeTally {
  created: string[];
  consolidated: string[];
  bundled: string[];
  noise: number;
  dropped: number;
  resolved: number;
  backlogged: number;
}

/**
 * @description Records one consolidation outcome on the response tally and the FR-A3
 * counters (created / consolidated / bundled), keeping the webhook handler under the
 * function cap.
 * @param tally - The per-request tally (mutated).
 * @param stats - The FR-A3 intake counters.
 * @param outcome - What the consolidation service did with the alert.
 * @param intakeStatus - The alert's resolved intake policy.
 * @param canonical - The canonical alert (for the log line).
 */
function tallyOutcome(
  tally: IntakeTally,
  stats: AlertIntakeStats,
  outcome: ConsolidationOutcome,
  intakeStatus: 'approved' | 'backlog',
  canonical: CanonicalAlert,
): void {
  if (outcome.decision === 'created') {
    stats.record('created');
    tally.created.push(outcome.ticketId);
    // FR-E2: a budget-parked create landed in backlog no matter what intake asked for.
    if (intakeStatus === 'backlog' || outcome.budgetParked === true) tally.backlogged += 1;
    logger.info(
      { ticketId: outcome.ticketId, alertname: canonical.alertname, target: canonical.target, intake: intakeStatus, budgetParked: outcome.budgetParked ?? false },
      'Opened incident ticket from Prometheus alert',
    );
  } else if (outcome.decision === 'bundled') {
    stats.record('bundled');
    tally.bundled.push(outcome.ticketId);
    logger.info(
      { ticketId: outcome.ticketId, alertname: canonical.alertname, target: canonical.target },
      'Alert bundled onto open related incident (ADR-119 Stage D)',
    );
  } else {
    stats.record('consolidated');
    tally.consolidated.push(outcome.ticketId);
  }
}

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
 * @param options - Optional app-layer seams (FR-E2 cost-ledger reader).
 * @returns Express router exposing POST /alertmanager + GET /intake-stats
 *   (mount at /api/alerts).
 */
export function createAlertmanagerRoutes(ticketService: TicketService, options: AlertmanagerRouteOptions = {}): Router {
  const router = Router();

  // Stage B claim registry (FR-B1..B4): ALERT_CLAIMS_FILE rules + the
  // ALERT_APPROVED_NAMES shorthand. Unconfigured => accept all firing alerts
  // (dev default, unchanged from P1).
  const registry = AlertClaimRegistry.fromEnvironment();

  // Backlog-intake policy. Some alerts should NOT auto-flow into the incident-rca
  // pipeline — they land as `backlog` so an operator triages them from the cockpit
  // ticket surface (Status=Backlog, Type=Incident) and pulls them in manually.
  // Resolution order, first match wins:
  //   1. per-alert label `intake` ("backlog"/"manual"/"queue" vs "auto"/"approved")
  //      — the SRE who writes the alert rule owns its routing (FR-B1 precedence)
  //   2. the claiming rule's own `intake` declaration (P3 Stage B)
  //   3. alertname in ALERT_BACKLOG_NAMES -> backlog
  //   4. ALERT_DEFAULT_INTAKE (default "approved" = auto-flow, as before)
  const backlogRaw = (process.env.ALERT_BACKLOG_NAMES || '').trim();
  const backlogNames = backlogRaw
    ? new Set(backlogRaw.split(',').map((s) => s.trim()).filter(Boolean))
    : new Set<string>();
  const defaultIntake: 'approved' | 'backlog' =
    (process.env.ALERT_DEFAULT_INTAKE || 'approved').trim().toLowerCase() === 'backlog'
      ? 'backlog'
      : 'approved';

  const resolveIntakeStatus = (
    alertname: string,
    labels: Record<string, string>,
    ruleIntake?: 'approved' | 'backlog',
  ): 'approved' | 'backlog' => {
    const hint = (labels.intake || labels.ticket_status || '').toLowerCase();
    if (hint === 'backlog' || hint === 'manual' || hint === 'queue') return 'backlog';
    if (hint === 'auto' || hint === 'approved' || hint === 'flow') return 'approved';
    if (ruleIntake) return ruleIntake;
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
  // stays decoupled from the ticketing slice (FSD same-layer rule). P3 wires the
  // FR-E2 budget gate over the app-supplied cost-ledger reader (absent = explicit
  // pass-through, never a silent park).
  const stats = new AlertIntakeStats();
  const consolidation = new AlertConsolidationService(
    ticketService,
    new AlertBundlingService(),
    new RcaBudgetGate(options.rcaSpend ?? null),
  );

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
   * POST-AUTH IDENTITY RE-ENTRY (the 2026-08-01 live fix).
   *
   * server.ts mounts the global RLS request-identity middleware ABOVE every /api route, and
   * for this machine-to-machine webhook `getCaller(req).sub` is null and `isOperator(req)` is
   * false — so the GUC pool stamps `oshal.current_sub=''`, `oshal.is_operator='off'` and the
   * enforce-stage owner policy on `tickets` refuses the INSERT outright. Same defect, same
   * fix as a2a-routes.ts: once the caller has PROVEN possession of the shared secret, re-enter
   * the identity store as the synthetic machine sub that owns alert-born work.
   *
   * Deliberately `isOperator: false`. The machine gets exactly its own rows: Stage C's
   * incident-key lookup and Stage D's bundle scan then see alert-born tickets and nothing
   * else, so a webhook token can never correlate an alert onto a user's personal ticket.
   *
   * Placed AFTER `guard` (and after the HMAC guard on the POST) so an unauthenticated caller
   * is rejected while still anonymous and never touches the machine identity.
   */
  const asMachineIdentity = (_req: Request, _res: Response, next: NextFunction): void => {
    runWithRequestIdentity({ sub: ALERT_INTAKE_OWNER_SUB, isOperator: false }, () => next());
  };

  /**
   * POST /api/alerts/alertmanager
   * Alertmanager webhook receiver. Accepts the v4 payload; each approved firing
   * alert consolidates onto the open ticket for its incident key (ADR-119 P1 —
   * ten identical alerts are ONE ticket carrying updateCount=9), bundles onto an
   * open RELATED incident (ADR-119 P2 — the api-down drill is ONE ticket with
   * members + rootCandidate), or opens a new ticket.
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

  router.post('/alertmanager', guard, hmacGuard, asMachineIdentity, async (req: Request, res: Response) => {
    const payload = (req.body || {}) as AlertmanagerPayload;
    const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];

    if (alerts.length === 0) {
      res.json({ success: true, created: 0, consolidated: 0, bundled: 0, message: 'no alerts in payload' });
      return;
    }

    const tally: IntakeTally = { created: [], consolidated: [], bundled: [], noise: 0, dropped: 0, resolved: 0, backlogged: 0 };

    for (const alert of alerts) {
      // Stage A: canonicalize + identity gate (FR-A1/A2). Identity-less alerts are
      // unactionable — dropped AND counted (reason=no_identity), never invisible.
      const canonicalized = canonicalizeAlert(alert);
      if (!canonicalized) {
        stats.record('dropped');
        tally.dropped += 1;
        continue;
      }

      // Stage B: claim gate (FR-B1..B4). A claim re-keys the alert with its rule's
      // incident-key template; unclaimed alerts are NOISE (counted per alertname,
      // queryable via GET /intake-stats — tunable from evidence) or, under
      // ALERT_UNCLAIMED_POLICY=backlog, park as backlog tickets. No registry at all
      // keeps the accept-all dev default.
      let canonical = canonicalized;
      let claim: ClaimResolution | null = null;
      let unclaimedBacklog = false;
      if (registry.configured) {
        claim = registry.claim(canonicalized);
        if (claim) {
          canonical = { ...canonicalized, incidentKey: claim.incidentKey, usedFingerprintKeyFallback: claim.usedFingerprintFallback };
        } else if (canonicalized.status !== 'resolved') {
          if (unclaimedPolicy() === 'drop') {
            stats.record('noise', canonical.alertname);
            tally.noise += 1;
            logger.info({ alertname: canonical.alertname }, 'No claim rule claims this alert — counted as noise, no ticket (FR-B2)');
            continue;
          }
          unclaimedBacklog = true;
        }
      }

      // Resolved alerts never open work; the FR-A3 decision is counted and FR-E4
      // marks the matching member (opt-in self-close for fully-resolved backlog).
      if (canonical.status === 'resolved') {
        stats.record('resolved');
        tally.resolved += 1;
        try {
          await consolidation.intakeResolved(canonical, ticketType);
        } catch (err) {
          logger.error({ err, alertname: canonical.alertname }, 'Failed to apply resolved event to the incident (FR-E4)');
        }
        continue;
      }

      // approved => auto-flows into incident-rca; backlog => waits for operator triage.
      // An unclaimed alert under the backlog policy always parks (FR-B2).
      const intakeStatus = unclaimedBacklog
        ? 'backlog'
        : resolveIntakeStatus(canonical.alertname, canonical.labels, claim?.intake);

      // Stage C + D + E: consolidate or bundle (FR-C2..C6, FR-D1..D7), dispatch-gated
      // (FR-E2 budget park, FR-E3 flap damping). Refire of an open incident updates
      // that ticket; a RELATED alert attaches to the open incident inside the
      // correlation window; otherwise a new ticket opens (recurrence-linked within
      // the TTL).
      try {
        const outcome = await consolidation.intake(canonical, {
          title: `[${canonical.severity}] ${canonical.alertname || 'UnnamedAlert'} on ${canonical.target || 'unknown-target'}`,
          ticketType,
          description: buildDescription(alert, canonical, intakeStatus),
          intakeStatus,
          externalUrl: alert.generatorURL ?? null,
          rootFilter: claim?.rootFilter ?? [],
        });
        tallyOutcome(tally, stats, outcome, intakeStatus, canonical);
      } catch (err) {
        logger.error({ err, alertname: canonical.alertname }, 'Failed to intake alert into the ticket queue');
      }
    }

    res.json({
      success: true,
      created: tally.created.length,
      consolidated: tally.consolidated.length,
      bundled: tally.bundled.length,
      noise: tally.noise,
      dropped: tally.dropped,
      resolved: tally.resolved,
      backlogged: tally.backlogged,
      autoFlowed: tally.created.length - tally.backlogged,
      ticketIds: tally.created,
      consolidatedTicketIds: tally.consolidated,
      bundledTicketIds: tally.bundled,
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
