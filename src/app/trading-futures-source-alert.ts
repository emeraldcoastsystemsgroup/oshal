/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Claim one owner-routed source notification per opted-in failed run and retain honest delivery receipts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Describe incomplete captured sessions as a distinct refused research source.
 */
import type { AppContext } from './composition-root';
import type { NotificationRouter, NotifyOutcome } from '@/features/notifications';
import { createChildLogger } from '@/shared/logger';
import type { FuturesSourceIssue } from './trading-futures-source-error';

const logger = createChildLogger({ module: 'trading-futures-source-alert' });
export const FUTURES_SOURCE_ALERT_TOPIC = 'futures-source';

/** @description The durable claim is not a delivery receipt. Uncertain sends are never retried automatically. */
export interface FuturesSourceAlert {
  issue: FuturesSourceIssue;
  status: 'disabled' | 'ready' | 'claimed' | 'delivered' | 'skipped' | 'failed' | 'unknown';
  claimedAt?: string;
  completedAt?: string;
  channel?: NotifyOutcome['channel'];
  fallbackFrom?: NotifyOutcome['fallbackFrom'];
  reason?: string;
}

/** @description Lazy owner router and bounded wait, injectable without contacting a real notification provider in tests. */
export interface FuturesSourceAlertDeps {
  router: () => Promise<Pick<NotificationRouter, 'notify'>>;
  timeoutMs: number;
}

function sourceMessage(runId: string, issue: FuturesSourceIssue): { subject: string; body: string; shortText: string } {
  const subject = `Futures ${issue.root}: ${issue.code} source blocked research`;
  const detail = issue.code === 'stale'
    ? `Chart date ${issue.chartDate}, higher-timeframe date ${issue.ltfDate}; study end ${issue.freshness.referenceDate}. Bar-date lags ${issue.freshness.chartLagDays}/${issue.freshness.ltfLagDays} days exceed the configured ${issue.freshness.maxSourceLagDays}-day maximum.`
    : issue.code === 'empty' ? 'The chart or higher-timeframe series is empty.'
      : issue.code === 'incomplete' ? 'The captured source has missing or invalid session bars; research was refused.'
        : 'The configured source is unavailable.';
  return { subject, shortText: subject, body: `${subject}.\n${detail}\nRun ${runId}. Open Trading > Strategies > Tuning to inspect the source and settings. Optimization did not run for this market. No study success or trading approval is implied.` };
}

async function deliver(ownerSub: string, runId: string, issue: FuturesSourceIssue, deps: FuturesSourceAlertDeps): Promise<Partial<FuturesSourceAlert>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    const result = await Promise.race([
      deps.router().then(router => expired ? null : router.notify(ownerSub, FUTURES_SOURCE_ALERT_TOPIC, sourceMessage(runId, issue))),
      new Promise<null>(resolve => { timer = setTimeout(() => { expired = true; resolve(null); }, deps.timeoutMs); }),
    ]);
    if (!result) return { status: 'unknown', reason: 'delivery-deadline' };
    const reasons = ['disabled', 'channel-none', 'quiet-hours', 'no-sender-registered', 'channel-unavailable', 'send-failed'];
    return { status: result.delivered ? 'delivered' : result.skipped ? 'skipped' : result.reason === 'send-failed' ? 'failed' : 'unknown', channel: result.channel,
      ...(result.fallbackFrom ? { fallbackFrom: result.fallbackFrom } : {}),
      ...(result.delivered ? {} : { reason: reasons.includes(result.reason ?? '') ? result.reason : 'delivery-unconfirmed' }) };
  } catch {
    // An exception can occur after a transport accepted the send. Never retry or expose raw provider errors.
    return { status: 'unknown', reason: 'delivery-exception' };
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * @description Claim before any outward hop; exact owner/run SQL and the persisted opt-in are authoritative.
 * @param ctx - Owner-aware application context. @param ownerSub - Run owner. @param runId - Failed run.
 * @param deps - Existing per-user router, built only after winning the claim. @returns No result; inspect the run receipt.
 */
export async function notifyFuturesSourceFailure(ctx: AppContext, ownerSub: string, runId: string,
  deps: FuturesSourceAlertDeps = { router: async () => (await import('./routes/notify-routes.js')).buildNotificationRouter(ctx), timeoutMs: 20_000 },
): Promise<void> {
  try {
    const claimed = (await ctx.pool.query(`UPDATE oshal_trading_futures_research_runs
      SET source_alert=source_alert || jsonb_build_object('status','claimed','claimedAt',now())
      WHERE owner_sub=$1 AND run_id=$2 AND status='failed' AND config->'sourceAlerts'='true'::jsonb
        AND source_alert->>'status'='ready' RETURNING source_alert`, [ownerSub, runId])).rows[0];
    if (!claimed) return;
    const receipt = claimed.source_alert as FuturesSourceAlert;
    const outcome = await deliver(ownerSub, runId, receipt.issue, deps);
    await ctx.pool.query(`UPDATE oshal_trading_futures_research_runs SET source_alert=source_alert || $3::jsonb || jsonb_build_object('completedAt',now())
      WHERE owner_sub=$1 AND run_id=$2 AND source_alert->>'status'='claimed'`,
    [ownerSub, runId, JSON.stringify(outcome)]);
  } catch (error) {
    // A failed receipt write leaves the durable claim visible as uncertain; never repeat the outward send.
    logger.error({ err: error, runId }, 'Futures source alert receipt failed; no automatic delivery retry');
  }
}
