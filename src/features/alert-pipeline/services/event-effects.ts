/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BUG-20: the side effects of working one landed alert event are recorded per event in oshal_alert_event_effect (migration 141), each in the same statement or transaction as the write it records, so a claim that rolls back after the handler wrote and then re-drains the event changes nothing twice. The event row lock the claim holds serializes handling of any one event, which is what makes "read what is applied, then apply the rest" safe; the primary key is the backstop.
 */
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'alert-event-effects' });

/**
 * @description The side effects of working one landed alert event. Each is applied at most once
 * per event: `intake` (the triage decision and any ticket it opened or bubbled), `consolidate` (the
 * incident arm and its occurrence count), `member` (the member's occurrence count) and
 * `dispatch:<channel>` (the dispatch ledger row).
 */
export type EventEffect = 'intake' | 'consolidate' | 'member' | `dispatch:${string}`;

/** What each already-applied effect recorded, for one event. */
export type AppliedEffects = ReadonlyMap<EventEffect, Record<string, unknown>>;

/** The minimal query surface both a pool and a transaction client provide. */
interface EffectQueryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Records one effect. A plain INSERT on purpose: a second record for the same event and effect is a
 * primary-key violation that rolls back the write it travels with, never a silent second count.
 */
export const RECORD_EFFECT_SQL = `
INSERT INTO oshal_alert_event_effect (event_id, effect, owner_sub, detail)
VALUES ($1::uuid, $2, $3, $4::jsonb)`;

/** No effects applied: what an event without a durable identity, or a first drain, starts from. */
export const NO_APPLIED_EFFECTS: AppliedEffects = new Map();

/**
 * @description Read what has already been applied for one landed event. Called once at the start
 * of working the event, while the claim holds the event's row lock, so no other drain can be
 * applying effects for the same event at the same time.
 * @param db - Pool or client to read on.
 * @param eventId - The landed event.
 * @returns Applied effects and what each recorded.
 */
export async function readAppliedEffects(db: EffectQueryable, eventId: string): Promise<AppliedEffects> {
  try {
    const { rows } = await db.query('SELECT effect, detail FROM oshal_alert_event_effect WHERE event_id = $1::uuid', [eventId]);
    return new Map(rows.map((row) => [row.effect as EventEffect, (row.detail ?? {}) as Record<string, unknown>]));
  } catch (err) {
    logger.error({ err, eventId }, 'Reading applied event effects failed');
    throw err;
  }
}

/**
 * @description Record one effect on its own. Use it inside the transaction that performs the write,
 * or right after a write that cannot share a statement with it; the CTE forms in the stores record
 * in the same statement as the write instead.
 * @param db - The connection performing the write (a transaction client when there is one).
 * @param eventId - The landed event.
 * @param effect - Which effect was applied.
 * @param ownerSub - Row owner, the same machine owner the pipeline's other rows carry.
 * @param detail - What a replay needs to reproduce the result without re-applying it.
 * @returns Nothing; throws on a duplicate or a failed write.
 */
export async function recordEffect(
  db: EffectQueryable, eventId: string, effect: EventEffect, ownerSub: string, detail: Record<string, unknown>,
): Promise<void> {
  try {
    await db.query(RECORD_EFFECT_SQL, [eventId, effect, ownerSub, JSON.stringify(detail)]);
  } catch (err) {
    logger.error({ err, eventId, effect }, 'Recording an applied event effect failed');
    throw err;
  }
}
