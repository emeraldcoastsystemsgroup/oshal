/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Single source of truth for classifying a ticket into its queue (application). Maps the legacy ticketType into the owning app's queue so tickets stop dumping into "Default"; chat tickets carry queue=chat keyed by target bot. Pure (no deps) so the backfill script reuses it.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 1 carve #2: dropped 'youtube-kids-brief' — the youtube-kids app carved to the store; an installed app's ticketType maps to its own queue via the loaded manifest (LM precedent).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 3 carve: dropped 'feeds' — the Feeds surface carved to the app store; the installed manifest maps the ticketType to its own queue. The feeds-indexing engine + feeds-curator node stay framework-resident (ADR-093).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 3 carve: dropped 'cloud-op' — the cloud app carved to the store; the installed manifest maps the ticketType to its own queue. The cloud-ops-bot node, GCP CLIs/toolkit, and gcp connector stay framework-resident (ADR-093).
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 3 carve: dropped 'identity-review' — the Identity Hub carved to the store; the installed manifest maps the ticketType to its own queue. The identity-advisor inline node + the connector hub stay framework-resident (ADR-093).
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 3 carve: dropped 'federal-capture' — the Federal Capture app carved to the store; the installed manifest maps the ticketType to its own queue. The capture-specialist inline node, the gov-contracting SAM-scan cron (which still creates federal-capture tickets), and the capture-corpus RAG collection stay framework-resident (ADR-093).
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 3 carve: dropped 'email-summarizer' — the Email Summarizer surface carved to the store; the installed manifest maps the ticketType to its own queue. The communications-bot node + the kernel email-send machinery stay framework-resident (ADR-093).
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 3 trading carve: the 'trading-decision' row STAYS (contrast every dropped row above) — the kernel's 8 autopilot dispatch/reconcile loops are framework-resident and still create trading-decision tickets whether or not the package is installed, so the kernel queue must keep classifying them. Comment added at the row; no mapping change.
 */

import {
  DEFAULT_QUEUE_ID,
  DEFAULT_QUEUE_NAME,
  resolveCanonicalTicketQueue,
  type CanonicalTicketQueue,
} from './project-metadata';

/**
 * @description The chat queue id. Ad-hoc conversations with a bot live here,
 * categorized inside the queue by their target bot (see {@link DerivedTicketQueue.targetBot}).
 */
export const CHAT_QUEUE_ID = 'chat';

/**
 * @description The shared "Default" queue id — the catch-all a ticket lands in
 * only when no real queue can be derived. Reclassification empties this bucket.
 */
export const DEFAULT_DERIVED_QUEUE_ID = DEFAULT_QUEUE_ID;

/**
 * @description Canonical map of a legacy `ticketType` to the queue (application id)
 * that owns it. Mirrors the `ticketType:` declared by each swarm-app manifest in
 * swarm-apps/*.yaml — KEEP IN SYNC when an app's ticketType or id changes.
 *
 * Verified against the manifests on 2026-06-19 (note: `security` app id is
 * `security-center`, `trading` app id is `intelligent-trades`, `purchasing`
 * declares ticketType `shopping`).
 */
export const TICKET_TYPE_TO_QUEUE_ID: Readonly<Record<string, string>> = Object.freeze({
  // ('career-application' → 'career-hunter' removed: the app carved to the store,
  //  ADR-085 Wave 3 #1 — an installed app's ticketType maps via its loaded manifest.)
  // ('cloud-op' → 'cloud' removed: cloud carved to the app store 2026-07-19, ADR-085
  //  Wave 3 — an installed app's ticketType maps via its loaded manifest. The
  //  cloud-ops-bot node + GCP tool chain stay framework-resident, ADR-093.)
  eats: 'eats',
  // ('feeds' → 'feeds' removed: the Feeds surface carved to the app store 2026-07-19,
  //  ADR-085 Wave 3 — an installed app's ticketType maps via its loaded manifest. The
  //  feeds-indexing engine + feeds-curator node stay framework-resident, ADR-093.)
  // ('email-summarizer' → 'email-summarizer' removed: the Email Summarizer surface carved
  //  to the app store 2026-07-19, ADR-085 Wave 3 — an installed app's ticketType maps via
  //  its loaded manifest. The communications-bot node + the kernel email-send machinery
  //  (sendGmail/sendOutlookMail) stay framework-resident, ADR-093.)
  // ('federal-capture' → 'federal-capture' removed: the Federal Capture app carved to the
  //  app store 2026-07-19, ADR-085 Wave 3 — an installed app's ticketType maps via its
  //  loaded manifest. The capture-specialist inline node + the gov-contracting SAM-scan
  //  cron that creates these tickets stay framework-resident, ADR-093.)
  // ('finance-brief' → 'finance' removed: finance carved to the app store 2026-07-17,
  //  ADR-085 — an installed app's ticketType maps via its loaded manifest, LM precedent.)
  // ('home-control' → 'home' removed: home carved to the app store 2026-07-19, ADR-085
  //  Wave 2 — an installed app's ticketType maps via its loaded manifest, LM precedent.)
  // ('identity-review' → 'identity' removed: the Identity Hub carved to the app store
  //  2026-07-19, ADR-085 Wave 3 — an installed app's ticketType maps via its loaded
  //  manifest. The identity-advisor inline node stays framework-resident, ADR-093.)
  incident: 'intelligent-operations',
  'intelligent-processing': 'intelligent-processing',
  // ('education' → 'little-monsters' removed: LM carved out to the app store, ADR-085.
  //  Same for 'youtube-kids-brief' → 'youtube-kids', carved 2026-07-17.
  //  An installed app's ticketType maps to its own queue via the loaded manifest.)
  // 'build' is the engineering swarm workflow — its queue is the engineering app.
  build: 'oshal-engineering',
  shopping: 'purchasing',
  rides: 'rides',
  'security-finding': 'security-center',
  // 'trading-decision' STAYS although the trading SURFACE carved to the app store (ADR-085
  // Wave 3): the KERNEL still creates these tickets — the 8 autopilot dispatch/reconcile loops
  // (trading-{schedule,swing,research,assess,review,optimize}-dispatch etc.) run
  // framework-resident and emit ticketType 'trading-decision' whether or not the package is
  // installed, so the queue classification must keep routing them to the Intelligent Trades
  // queue (verified by grep 2026-07-19: dispatch-manifest-worker + the loops consume the row).
  'trading-decision': 'intelligent-trades',
  task: 'jarvis',
});

/**
 * @description Inputs used to classify a ticket into its queue.
 */
export interface QueueClassificationContext {
  /** The legacy ticketType (selects the workflow); maps to the owning app queue. */
  ticketType?: string | null;
  /** Existing ticket/creation metadata — an explicit queueId here always wins. */
  metadata?: Record<string, unknown> | null;
  /** Target bot friendly name — present for chat-queue tickets. */
  targetBot?: string | null;
  /** Explicit signal that this ticket is an ad-hoc bot conversation. */
  isChat?: boolean;
}

/**
 * @description The queue a ticket was classified into.
 */
export interface DerivedTicketQueue {
  queueId: string;
  queueName: string;
  /** Set only for chat-queue tickets: the target bot friendly name. */
  targetBot?: string;
}

function humanizeQueueId(queueId: string): string {
  const words = queueId.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (words.length === 0) return DEFAULT_QUEUE_NAME;
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function readMetadataString(metadata: Record<string, unknown> | null | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

/**
 * @description Classifies a ticket into its proper queue (application).
 *
 * Order of precedence:
 *   1. An explicit, non-default `queueId` already on the metadata wins (e.g. the
 *      chat rows the chat thread writes are respected as-is).
 *   2. A chat ticket (isChat, or a target bot with no app ticketType) -> the `chat`
 *      queue, carrying the target bot as the in-queue category.
 *   3. A known ticketType -> the owning app queue (TICKET_TYPE_TO_QUEUE_ID).
 *   4. An unknown but present ticketType -> a queue named after it (forward-compatible
 *      with app ticketTypes not yet in the map).
 *   5. Nothing usable -> the Default queue.
 *
 * @param ctx - Classification inputs.
 * @returns The derived queue.
 */
export function deriveTicketQueue(ctx: QueueClassificationContext): DerivedTicketQueue {
  // 1. Respect an explicit queue already stamped on the metadata (dual-read).
  const existingQueueId = readMetadataString(ctx.metadata, 'queueId') || readMetadataString(ctx.metadata, 'projectId');
  if (existingQueueId && existingQueueId !== DEFAULT_QUEUE_ID) {
    const existingName = readMetadataString(ctx.metadata, 'queueName')
      || readMetadataString(ctx.metadata, 'projectName')
      || humanizeQueueId(existingQueueId);
    const targetBot = readMetadataString(ctx.metadata, 'targetBot') || (ctx.targetBot ?? '');
    return targetBot
      ? { queueId: existingQueueId, queueName: existingName, targetBot }
      : { queueId: existingQueueId, queueName: existingName };
  }

  const ticketType = (ctx.ticketType ?? '').trim();
  const targetBot = (ctx.targetBot ?? readMetadataString(ctx.metadata, 'targetBot')).trim();

  // 2. Chat queue: an ad-hoc bot conversation, keyed by target bot.
  if (ctx.isChat || (targetBot && !ticketType)) {
    return { queueId: CHAT_QUEUE_ID, queueName: 'Chat', targetBot: targetBot || undefined };
  }

  // 3 / 4. Map a known ticketType to its app queue; fall back to the ticketType itself.
  if (ticketType) {
    const mapped = TICKET_TYPE_TO_QUEUE_ID[ticketType];
    const queueId = mapped || ticketType;
    return { queueId, queueName: humanizeQueueId(queueId) };
  }

  // 5. Nothing usable.
  return { queueId: DEFAULT_QUEUE_ID, queueName: DEFAULT_QUEUE_NAME };
}

/**
 * @description Derives the queue id for a schedule from its `taskType`. Schedules
 * often carry a scoped taskType (e.g. `home-control-<uuid>`), so this matches the
 * taskType exactly or by its leading ticketType prefix before falling back to the
 * raw value. Used to tag/filter schedules by their owning app queue.
 * @param taskType - The schedule taskType.
 * @returns The owning queue id.
 */
export function deriveQueueIdFromTaskType(taskType: string | null | undefined): string {
  const t = (taskType ?? '').trim();
  if (!t) return DEFAULT_QUEUE_ID;
  if (TICKET_TYPE_TO_QUEUE_ID[t]) return TICKET_TYPE_TO_QUEUE_ID[t];
  for (const key of Object.keys(TICKET_TYPE_TO_QUEUE_ID)) {
    if (t === key || t.startsWith(`${key}-`)) return TICKET_TYPE_TO_QUEUE_ID[key];
  }
  return t;
}

/**
 * @description Classifies a ticket and folds the result into its metadata as the
 * canonical `queue*` keys (plus `targetBot` for chat tickets), preserving all other
 * metadata. This is the one call creation paths and the backfill script use.
 * @param metadata - Existing metadata (preserved).
 * @param ctx - Classification inputs.
 * @returns Metadata with canonical queue fields applied.
 */
export function applyDerivedQueueMetadata(
  metadata: Record<string, unknown> | null | undefined,
  ctx: QueueClassificationContext,
): Record<string, unknown> {
  const derived = deriveTicketQueue({ ...ctx, metadata: { ...(metadata ?? {}), ...(ctx.metadata ?? {}) } });
  const canonical: CanonicalTicketQueue = resolveCanonicalTicketQueue({
    queueId: derived.queueId,
    queueName: derived.queueName,
  });
  const next: Record<string, unknown> = {
    ...(metadata && typeof metadata === 'object' ? metadata : {}),
    queue: canonical.queue,
    queueName: canonical.queueName,
    queueId: canonical.queueId,
    queueIdentifier: canonical.queueIdentifier,
    workspaceSlug: canonical.workspaceSlug,
  };
  if (derived.targetBot) {
    next.targetBot = derived.targetBot;
  }
  return next;
}
