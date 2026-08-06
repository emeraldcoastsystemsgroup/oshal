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
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Durable landing (Operations Stream): with a Pool wired, an authenticated delivery is written verbatim to oshal_alert_envelope and expanded into oshal_alert_event BEFORE anything canonicalizes, claims, or cuts a ticket, and the receiver answers 202 with the envelope id and the expanded event count. The response now states only what is DURABLE: a landing failure answers 503 so Alertmanager redelivers, and a body that is not an envelope is parked as an ingest deadletter and answered 400. Consolidation runs off the landed rows — the request drains them in-process so alert-to-ticket latency is the request itself, and a 5-second sweep claims any straggler through EnvelopeStore.withPendingEvents (SKIP LOCKED, so a sweep and a request never take the same row), stamping every event's durable claim decision. Pool-less runs keep the in-memory intake shape end to end
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Close the Alertmanager HMAC raw-body gap: the receiver now owns a bounded JSON parser whose verify hook captures the exact bytes before signature verification, while the global parser reserves only /api/alerts/alertmanager. Whitespace/key-order differences no longer depend on JSON reserialization, and a configured HMAC secret remains fail-closed.
 */

/**
 * Alertmanager webhook intake — turns Prometheus alerts about the swarm's own
 * containers into incident tickets that flow through the incident-rca pipeline.
 *
 * Flow (self-healing on itself):
 *   cAdvisor/Prometheus watch the oshal-* containers
 *     -> Alertmanager fires on a rule (container down, restart loop, unhealthy)
 *       -> POST /api/alerts/alertmanager (this route)
 *         -> LAND the delivery verbatim + expand it into events (one transaction),
 *            answer 202 with the envelope id — the receiver acknowledges exactly
 *            what is durable, so a landing failure is a 503 the sender redelivers
 *           -> drain the landed events (in-process now, swept every 5s after)
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

import { Router, Request, Response, NextFunction, json, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { hmacWebhookGuard } from '@/features/security';
import type { TicketService } from '@/features/ticketing';
import { runWithRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { registerShutdownHook } from '@/shared/services/shutdown-hooks';
import {
  DEFAULT_IDENTITY_FIELDS,
  DispatchLog,
  EnvelopeStore,
  IncidentStore,
  hasUsableIdentity,
  renderDedupKey,
  renderIdentitySource,
  resolveDeploymentId,
  type AlertEventRow,
  type ClaimDecision,
  type LandEnvelopeResult,
  type Queryable,
  type UnclaimedReason,
} from '@/features/alert-pipeline';
import {
  ALERT_INTAKE_OWNER_SUB,
  AlertBundlingService,
  AlertClaimRegistry,
  AlertConsolidationService,
  AlertIntakeStats,
  RcaBudgetGate,
  canonicalizeAlert,
  consolidationTtlSeconds,
  unclaimedPolicy,
  type CanonicalAlert,
  type ClaimResolution,
  type ConsolidationOutcome,
  type RawAlertmanagerAlert,
  type RcaSpendReader,
} from '@/features/alert-triage';
import { TicketTypeSchema } from '@/entities/ticket';

const logger = createChildLogger({ module: 'alertmanager-routes' });

/** Default receiver bound; alert batches larger than this require an explicit operator override. */
export const DEFAULT_ALERTMANAGER_BODY_LIMIT = '100kb';

/** Request shape populated by the body-parser verify hook for exact-byte HMAC verification. */
type RawBodyRequest = Request & { rawBody?: Buffer };

/**
 * @description Builds the receiver-local JSON parser. The global parser deliberately skips only
 * `/api/alerts/alertmanager`; this parser restores the same bounded JSON behavior and captures a
 * defensive copy of the original bytes before parsing so HMAC verification never reserializes.
 * @param env - Environment map used to resolve the optional ALERT_WEBHOOK_BODY_LIMIT override.
 * @returns Express JSON middleware with exact-byte capture.
 */
export function createAlertmanagerJsonParser(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  const configured = String(env.ALERT_WEBHOOK_BODY_LIMIT ?? '').trim();
  return json({
    limit: configured || DEFAULT_ALERTMANAGER_BODY_LIMIT,
    verify: (req, _res, body) => {
      (req as RawBodyRequest).rawBody = Buffer.from(body);
    },
  });
}

/** The lane every delivery on this receiver arrives by; scopes the per-lane pipeline counters. */
const ALERT_SOURCE = 'alertmanager';

/**
 * How often the sweep looks for events no request drained. Five seconds is short enough that a
 * straggler is worked within one Alertmanager group_interval and long enough that an idle swarm
 * is not polling a hot table for nothing.
 */
const PENDING_SWEEP_INTERVAL_MS = 5_000;

/** Ceiling on one drain, so a flood is worked in bounded slices instead of one unbounded lock. */
const PENDING_DRAIN_BATCH = 100;

/**
 * @description Optional app-layer wiring for the alert intake (all seams default off/null
 * so the P1/P2 call shape keeps working unchanged).
 */
export interface AlertmanagerRouteOptions {
  /** FR-E2 actuals source (the per-event cost ledger); null/absent = budget gate passes through. */
  rcaSpend?: RcaSpendReader | null;
  /**
   * Database behind the durable landing stage. With a pool the receiver stores every delivery
   * before it interprets it and acknowledges 202; without one it runs the intake entirely in
   * memory and answers with the per-request counts.
   */
  pool?: Pool | null;
}

/**
 * @description What one alert's trip through intake decided, in the durable vocabulary the
 * event row stores. Returned rather than written inline so the same intake serves both the
 * in-memory path (which only tallies) and the landed path (which also stamps the row).
 */
/**
 * @description Decisions that produced or bubbled a ticket, and therefore have an incident behind
 * them. Noise, drops and resolutions are recorded on the event row and mint nothing — an incident
 * that exists only because something was dropped would make "open incidents" meaningless.
 */
const TICKETED_DECISIONS: ReadonlySet<ClaimDecision> = new Set<ClaimDecision>([
  'created',
  'consolidated',
  'bundled',
  'reopened',
]);

interface IntakeDecision {
  decision: ClaimDecision;
  unclaimedReason?: UnclaimedReason | null;
  /** The ticket this alert bubbled or opened, so the incident row can point at it. */
  ticketId?: string | null;
  /** Where the ticket parked, mirrored onto a newly created incident. */
  intakeStatus?: string | null;
  /** The rule that admitted it, recorded on the incident at genesis. */
  claimRuleId?: string | null;
  /** True when the identity fell back to the upstream fingerprint — a coverage signal. */
  usedFingerprintFallback?: boolean;
}

/** A canonical alert past the claim gate: re-keyed by its rule, plus how that rule routes it. */
interface ClaimedAlert {
  canonical: CanonicalAlert;
  claim: ClaimResolution | null;
  /** True when no rule claimed a firing alert and the policy parks it instead of dropping it. */
  unclaimedBacklog: boolean;
}

/**
 * @description Whether the body signature was proven on a delivery that reached the handler. The
 * HMAC guard is fail-closed once its secret is set, so arriving here with a secret configured IS
 * the proof; with no secret the delivery is bearer-authenticated only, and the landed row records
 * that rather than claiming a verification nobody performed.
 * @returns True when the HMAC secret is configured.
 */
function hmacVerified(): boolean {
  return (process.env.ALERT_WEBHOOK_HMAC_SECRET || '').trim().length > 0;
}

/**
 * @description Parks a delivery that is not an envelope, at the ingest stage. Malformed input is
 * the only evidence a producer's contract changed, so it is stored with the peer that sent it. A
 * deadletter write that itself fails is logged rather than raised: the caller still owes the
 * sender an answer, and a 503 here would invite an endless redelivery of a body that can never
 * be parsed.
 * @param store - The landing store.
 * @param body - The unreadable body, exactly as parsed.
 * @param req - The request, for the peer address.
 * @returns Nothing.
 */
async function parkUnreadableDelivery(store: EnvelopeStore, body: unknown, req: Request): Promise<void> {
  try {
    await store.recordDeadletter({
      stage: 'ingest',
      failureReason: 'delivery body is not an Alertmanager envelope',
      raw: { body: body ?? null, remoteAddr: req.ip ?? null },
    });
  } catch (err) {
    logger.error({ err }, 'Unreadable alert delivery could not be parked in the deadletter');
  }
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
 * @description A zeroed tally. One per batch, never shared across batches — a tally that
 * outlived its batch would report another delivery's work as this one's.
 * @returns A fresh tally with every counter at zero.
 */
function emptyTally(): IntakeTally {
  return { created: [], consolidated: [], bundled: [], noise: 0, dropped: 0, resolved: 0, backlogged: 0 };
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
  groupKey?: string;
  receiver?: string;
  externalURL?: string;
  truncatedAlerts?: number;
  groupLabels?: Record<string, string>;
  commonLabels?: Record<string, string>;
  commonAnnotations?: Record<string, string>;
  alerts?: RawAlertmanagerAlert[];
}

/**
 * @description Whether a delivery body can be read as an Alertmanager envelope at all. The bar
 * is deliberately structural — an object carrying an `alerts` array — because everything past
 * this point stores the body verbatim and interprets it later: a batch of zero alerts is a
 * legitimate delivery worth recording, while a body with no alerts array is a producer contract
 * break that must leave evidence rather than a 2xx.
 * @param body - The parsed request body.
 * @returns True when the body has the envelope shape.
 */
function isReadableEnvelope(body: unknown): body is AlertmanagerPayload {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return false;
  }
  return Array.isArray((body as { alerts?: unknown }).alerts);
}

/**
 * @description Rebuilds the wire alert from a landed event row so the claim and consolidation
 * stages read exactly the shape they read from a live delivery. The row carries the envelope's
 * common labels and annotations already merged in, so an event drained by the sweep reaches the
 * same decision the request that landed it would have reached.
 * @param event - One normalized event row.
 * @returns The alert in Alertmanager wire shape.
 */
function toWireAlert(event: AlertEventRow): RawAlertmanagerAlert {
  return {
    status: event.status,
    labels: event.labels,
    annotations: event.annotations,
    startsAt: event.startedAt ? event.startedAt.toISOString() : undefined,
    endsAt: event.endedAt ? event.endedAt.toISOString() : undefined,
    generatorURL: event.generatorUrl ?? undefined,
    fingerprint: event.fingerprint,
  };
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
 * @param options - Optional app-layer seams (FR-E2 cost-ledger reader, landing pool).
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

  // The landing stage. Present => every delivery is durable before it is interpreted, and the
  // events it expands into are the queue the intake works from. Absent => the intake runs
  // entirely in memory over the request body, which is what a pool-less run can honestly offer.
  const envelopes = options.pool ? new EnvelopeStore(options.pool) : null;
  // The incident row is the state of record; the dispatch ledger is the audit behind it. Both are
  // pool-gated exactly like the landing store, so a pool-less run keeps the previous shape.
  const incidents = options.pool ? new IncidentStore(options.pool) : null;
  const dispatches = options.pool ? new DispatchLog(options.pool) : null;
  const deploymentId = resolveDeploymentId();

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
  // ALERT_WEBHOOK_HMAC_SECRET is set, so default behavior is unchanged. The receiver-local
  // parser below captures the exact bytes before parsing; never verify a JSON reserialization.
  const hmacGuard = hmacWebhookGuard({
    secretEnv: 'ALERT_WEBHOOK_HMAC_SECRET',
    header: 'x-alert-signature-256',
    prefix: 'sha256=',
  });

  /**
   * @description Stage B claim gate (FR-B1..B4). A claim re-keys the alert with its rule's
   * incident-key template; an unclaimed firing alert is NOISE (counted per alertname, queryable
   * via GET /intake-stats — tunable from evidence) or, under ALERT_UNCLAIMED_POLICY=backlog,
   * parks as a backlog ticket. No registry at all keeps the accept-all dev default.
   * @param canonicalized - The canonical alert from Stage A.
   * @returns The re-keyed alert plus its routing, or null when the alert is noise.
   */
  const resolveClaim = (canonicalized: CanonicalAlert): ClaimedAlert | null => {
    if (!registry.configured) {
      return { canonical: canonicalized, claim: null, unclaimedBacklog: false };
    }
    const claim = registry.claim(canonicalized);
    if (claim) {
      const canonical = { ...canonicalized, incidentKey: claim.incidentKey, usedFingerprintKeyFallback: claim.usedFingerprintFallback };
      return { canonical, claim, unclaimedBacklog: false };
    }
    if (canonicalized.status === 'resolved') {
      return { canonical: canonicalized, claim: null, unclaimedBacklog: false };
    }
    if (unclaimedPolicy() === 'drop') {
      return null;
    }
    return { canonical: canonicalized, claim: null, unclaimedBacklog: true };
  };

  /**
   * @description FR-E4: a resolved event opens no work — it is counted and marks the matching
   * member (opt-in self-close once every member of a backlog incident is resolved).
   * @param canonical - The canonical resolved alert.
   * @param tally - The batch tally (mutated).
   * @returns The durable decision for this event.
   */
  const intakeResolvedAlert = async (canonical: CanonicalAlert, tally: IntakeTally): Promise<IntakeDecision> => {
    stats.record('resolved');
    tally.resolved += 1;
    try {
      await consolidation.intakeResolved(canonical, ticketType);
    } catch (err) {
      logger.error({ err, alertname: canonical.alertname }, 'Failed to apply resolved event to the incident (FR-E4)');
    }
    return { decision: 'resolved' };
  };

  /**
   * @description Stage C + D + E: consolidate or bundle (FR-C2..C6, FR-D1..D7), dispatch-gated
   * (FR-E2 budget park, FR-E3 flap damping). A refire of an open incident updates that ticket; a
   * RELATED alert attaches to the open incident inside the correlation window; otherwise a new
   * ticket opens (recurrence-linked within the TTL).
   * @param alert - The alert in wire shape, for the ticket body.
   * @param claimed - The claim gate's answer for this alert.
   * @param tally - The batch tally (mutated).
   * @returns The durable decision for this event.
   */
  const consolidateFiringAlert = async (
    alert: RawAlertmanagerAlert,
    claimed: ClaimedAlert,
    tally: IntakeTally,
  ): Promise<IntakeDecision> => {
    const { canonical, claim, unclaimedBacklog } = claimed;
    // approved => auto-flows into incident-rca; backlog => waits for operator triage.
    // An unclaimed alert under the backlog policy always parks (FR-B2).
    const intakeStatus = unclaimedBacklog
      ? 'backlog'
      : resolveIntakeStatus(canonical.alertname, canonical.labels, claim?.intake);
    const outcome = await consolidation.intake(canonical, {
      title: `[${canonical.severity}] ${canonical.alertname || 'UnnamedAlert'} on ${canonical.target || 'unknown-target'}`,
      ticketType,
      description: buildDescription(alert, canonical, intakeStatus),
      intakeStatus,
      externalUrl: alert.generatorURL ?? null,
      rootFilter: claim?.rootFilter ?? [],
    });
    tallyOutcome(tally, stats, outcome, intakeStatus, canonical);
    return {
      decision: outcome.decision,
      ticketId: outcome.ticketId,
      intakeStatus,
      // The declarative claim rules carry no identifier — they are anonymous matchers. Genesis
      // records null rather than a synthesised id, so "which rule admitted this" stays honestly
      // unanswered until the rule set is served from oshal_alert_claim_rule, where rows have ids.
      claimRuleId: null,
      usedFingerprintFallback: claim?.usedFingerprintFallback ?? false,
    };
  };

  /**
   * @description The full intake for one alert — Stage A identity gate, Stage B claim gate, then
   * either the resolved-event path or consolidation. The consolidation failure is NOT caught
   * here: an event that could not be worked must be visible to whoever is accountable for
   * retrying it, and that differs between the in-memory batch and the landed queue.
   * @param alert - One alert in Alertmanager wire shape.
   * @param tally - The batch tally (mutated).
   * @returns The durable decision for this alert.
   */
  const intakeAlert = async (alert: RawAlertmanagerAlert, tally: IntakeTally): Promise<IntakeDecision> => {
    // Stage A: canonicalize + identity gate (FR-A1/A2). Identity-less alerts are
    // unactionable — dropped AND counted (reason=no_identity), never invisible.
    const canonicalized = canonicalizeAlert(alert);
    if (!canonicalized) {
      stats.record('dropped');
      tally.dropped += 1;
      return { decision: 'dropped', unclaimedReason: 'no_identity' };
    }
    const claimed = resolveClaim(canonicalized);
    if (!claimed) {
      stats.record('noise', canonicalized.alertname);
      tally.noise += 1;
      logger.info({ alertname: canonicalized.alertname }, 'No claim rule claims this alert — counted as noise, no ticket (FR-B2)');
      return { decision: 'noise', unclaimedReason: 'no_rule_match' };
    }
    if (claimed.canonical.status === 'resolved') {
      return intakeResolvedAlert(claimed.canonical, tally);
    }
    return consolidateFiringAlert(alert, claimed, tally);
  };

  /**
   * @description Runs the intake over a batch of alerts held in memory. One alert that cannot be
   * worked is logged and the rest of the batch continues — a single bad alert never costs the
   * others their tickets.
   * @param alerts - The alerts to work.
   * @returns The batch tally.
   */
  const runIntakeBatch = async (alerts: RawAlertmanagerAlert[]): Promise<IntakeTally> => {
    const tally = emptyTally();
    for (const alert of alerts) {
      try {
        await intakeAlert(alert, tally);
      } catch (err) {
        logger.error({ err, alertname: alert.labels?.alertname ?? null }, 'Failed to intake alert into the ticket queue');
      }
    }
    return tally;
  };

  /**
   * @description Works one landed event and stamps its durable decision on the SAME connection
   * that claimed it. A failure records the attempt rather than losing the event: the attempt
   * count is what eventually parks a permanently broken event in the deadletter, still replayable.
   * @param store - The landing store.
   * @param event - The claimed event row.
   * @param executor - The claiming transaction's connection.
   * @returns Nothing.
   */
  /**
   * @description Resolves the consolidation identity for a landed event: the normalized
   * (target, alertname) pair, joined with the unit separator and hashed, namespaced by the
   * deployment so a shared database cannot cross-suppress environments. Returns null when the
   * event carries neither half — such an alert is unactionable and must not mint an incident.
   * @param event - The landed event.
   * @returns The identity, or null when the event has no usable one.
   */
  const resolveEventIdentity = (event: AlertEventRow): { dedupKey: string; identitySource: string } | null => {
    if (!hasUsableIdentity(event)) return null;
    return {
      identitySource: renderIdentitySource(event, DEFAULT_IDENTITY_FIELDS),
      dedupKey: renderDedupKey(event, DEFAULT_IDENTITY_FIELDS, deploymentId),
    };
  };

  /**
   * @description Writes the durable incident for a decided event and points it at the ticket the
   * triage path produced. The incident row — not the ticket's metadata blob — is the state of
   * record: it carries the identity, the occurrence tally and the reopen history, and its partial
   * unique index is what makes "one open incident per identity" a database guarantee rather than
   * a convention. The ticket remains the operator artifact and is linked, not duplicated.
   *
   * This never throws into the caller's decision: an incident-write failure must not strand an
   * event that already has a ticket. It is logged and the event is still decided, so the row is
   * not re-claimed forever by the sweep.
   * @param event - The landed event.
   * @param decided - What the triage path did with it.
   * @param identity - The resolved consolidation identity, or null when it has none.
   * @returns The incident id, or null when no incident was written.
   */
  const recordIncident = async (
    event: AlertEventRow,
    decided: IntakeDecision,
    identity: { dedupKey: string; identitySource: string } | null,
  ): Promise<string | null> => {
    // Only a decision that produced or bubbled a ticket has an incident. Noise, drops and
    // resolutions are recorded on the event itself and deliberately mint nothing.
    if (!incidents || !identity || !TICKETED_DECISIONS.has(decided.decision)) return null;
    try {
      const outcome = await incidents.consolidate(
        { ...event, dedupKey: identity.dedupKey, identitySource: identity.identitySource },
        {
          reopenWindowSeconds: consolidationTtlSeconds(),
          claimRuleId: decided.claimRuleId ?? null,
          intakeStatus: decided.intakeStatus ?? 'backlog',
          ownerSub: ALERT_INTAKE_OWNER_SUB,
        },
      );
      const incident = outcome.incident;
      await incidents.upsertMember(incident.incidentId, {
        memberKey: identity.dedupKey,
        alertname: event.alertname,
        target: event.target,
        severity: event.severity,
        severityNum: event.severityNum,
        fingerprint: event.fingerprint || null,
        attachReason: outcome.wasCreated ? 'genesis' : 'same-key',
      });
      // Link the ticket once. A refire must not re-stamp it: the ticket a recurrence opens is a
      // different ticket, and arm C already gave that recurrence its own incident row.
      if (decided.ticketId && incident.ticketId !== decided.ticketId) {
        await incidents.updateIncident(incident.incidentId, incident.revision, { ticketId: decided.ticketId });
      }
      await dispatches?.record({
        incidentId: incident.incidentId,
        dedupKey: identity.dedupKey,
        targetChannel: 'ticket',
        action: outcome.wasReopened ? 'reopen' : outcome.wasCreated ? 'create' : 'update',
        attempted: true,
        suppressed: false,
        success: true,
        statusCode: null,
        error: null,
        ticketId: decided.ticketId ?? null,
        ttlSeconds: null,
        payload: null,
      });
      return incident.incidentId;
    } catch (err) {
      logger.error(
        { err, eventId: event.eventId, dedupKey: identity.dedupKey },
        'Incident row write failed — the ticket stands and the event is still decided',
      );
      return null;
    }
  };

  const decideLandedEvent = async (store: EnvelopeStore, event: AlertEventRow, executor: Queryable): Promise<void> => {
    try {
      const decided = await intakeAlert(toWireAlert(event), emptyTally());
      const identity = resolveEventIdentity(event);
      const incidentId = await recordIncident(event, decided, identity);
      await store.decideEvent(
        event.eventId,
        decided.decision,
        {
          unclaimedReason: decided.unclaimedReason ?? null,
          incidentId,
          dedupKey: identity?.dedupKey ?? null,
          identitySource: identity?.identitySource ?? null,
          usedFingerprintFallback: decided.usedFingerprintFallback ?? false,
        },
        executor,
      );
    } catch (err) {
      logger.error({ err, eventId: event.eventId, alertname: event.alertname }, 'Alert event intake failed — recording the attempt');
      await store.failEvent(event.eventId, err, executor);
    }
  };

  /**
   * @description Claims a bounded slice of undecided events and works them. `SKIP LOCKED` inside
   * the store is what lets the request that just landed events and the sweep run at the same
   * time without either one seeing rows the other holds.
   * @returns How many events this drain claimed.
   */
  const drainPendingEvents = async (): Promise<number> => {
    if (!envelopes) {
      return 0;
    }
    const store = envelopes;
    return store.withPendingEvents(PENDING_DRAIN_BATCH, async (events, executor) => {
      for (const event of events) {
        await decideLandedEvent(store, event, executor);
      }
    });
  };

  /**
   * @description Answers a delivery from the in-memory intake: every alert is worked inside the
   * request and the response carries the per-decision counts.
   * @param req - The webhook request.
   * @param res - The response to write.
   * @returns Nothing.
   */
  const answerFromMemory = async (req: Request, res: Response): Promise<void> => {
    const payload = (req.body || {}) as AlertmanagerPayload;
    const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];

    if (alerts.length === 0) {
      res.json({ success: true, created: 0, consolidated: 0, bundled: 0, message: 'no alerts in payload' });
      return;
    }

    const tally = await runIntakeBatch(alerts);
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
  };

  /**
   * @description Answers a delivery from the landing stage. The delivery is stored verbatim and
   * expanded into events in one transaction FIRST; only then is the sender told 202, and the
   * body says exactly what was accepted — the envelope it can quote in a replay and how many
   * events came out of it. A landing failure is a 503 the sender redelivers into, because a 2xx
   * over work that was never stored is how an alert disappears.
   * @param store - The landing store.
   * @param req - The webhook request.
   * @param res - The response to write.
   * @returns Nothing.
   */
  const answerFromLanding = async (store: EnvelopeStore, req: Request, res: Response): Promise<void> => {
    const body: unknown = req.body;
    if (!isReadableEnvelope(body)) {
      await parkUnreadableDelivery(store, body, req);
      res.status(400).json({ success: false, error: 'delivery body is not an Alertmanager envelope' });
      return;
    }

    let landed: LandEnvelopeResult;
    try {
      landed = await store.landEnvelope({
        body,
        source: ALERT_SOURCE,
        remoteAddr: req.ip ?? null,
        signatureVerified: hmacVerified(),
      });
    } catch (err) {
      logger.error(
        { err, alertCount: body.alerts?.length ?? 0 },
        'Alert delivery was not landed — answering 503 so Alertmanager redelivers it',
      );
      res.status(503).json({ success: false, error: 'alert landing unavailable' });
      return;
    }

    res.status(202).json({ success: true, envelopeId: landed.envelopeId, events: landed.eventIds.length });
    // The work runs on the delivery that just committed, so a ticket is cut in the same beat the
    // alert arrived; anything this drain does not reach is claimed by the sweep.
    void drainPendingEvents().catch((err) => {
      logger.error({ err, envelopeId: landed.envelopeId }, 'Drain after landing failed — the sweep will claim these events');
    });
  };

  const alertmanagerJson = createAlertmanagerJsonParser();
  router.post('/alertmanager', guard, alertmanagerJson, hmacGuard, asMachineIdentity, async (req: Request, res: Response) => {
    if (envelopes) {
      await answerFromLanding(envelopes, req, res);
      return;
    }
    await answerFromMemory(req, res);
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

  // The sweep. One ticker per receiver, claiming events no request drained — a delivery whose
  // in-process drain lost its connection, or events landed by another process. A tick that finds
  // a drain already running skips rather than stacking, so a slow batch cannot pile up behind
  // itself. Unref'd so it never holds the process open, and cleared on shutdown so a stopping
  // controller stops claiming rows it will not finish.
  if (envelopes) {
    let sweeping = false;
    const sweepTimer = setInterval(() => {
      if (sweeping) {
        return;
      }
      sweeping = true;
      // The sweep is background work with no request in scope, so it must declare a system
      // identity: with OSHAL_DB_GUC_STRICT=deny an unidentified connection is refused outright
      // and the sweep silently claims nothing, which turns "retried on the next tick" into
      // "never retried" while the timer keeps firing and the logs look busy.
      void runWithSystemIdentity(() => drainPendingEvents())
        .catch((err) => logger.error({ err }, 'Pending alert-event sweep failed'))
        .finally(() => { sweeping = false; });
    }, PENDING_SWEEP_INTERVAL_MS);
    sweepTimer.unref();
    registerShutdownHook('alert-landing-sweep', () => clearInterval(sweepTimer));
  }

  return router;
}
