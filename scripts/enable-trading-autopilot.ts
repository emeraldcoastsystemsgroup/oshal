/* Enable (or replace) the every-5-minutes multi-timeframe paper autopilot for a user, by writing
 * the trading-autopilot:<sub> schedule straight into the shared Redis scheduler store. The api's
 * scheduler runner then fires it; the trading-autopilot dispatch branch runs the loop (paper-only,
 * self-skips when the market is closed). Run with REDIS_URL pointed at the host-mapped Redis.
 *
 *   REDIS_URL=redis://localhost:16379 ts-node -r tsconfig-paths/register --transpile-only \
 *     scripts/enable-trading-autopilot.ts <user_sub>
 */
import { RedisScheduleStore, ScheduleService } from '@/features/scheduling';
import { DEFAULT_UNIVERSE } from '@/features/trading';

const SUB = process.argv[2] || 'example-user-sub';
const CRON = process.argv[3] || '*/5 * * * *';

/** The three advisor legs: technical autopilot, news+fundamentals research, fast breaking-news. */
const LEGS: Array<{ taskType: string; cron: string; label: string }> = [
  { taskType: `trading-autopilot:${SUB}`, cron: CRON, label: `Multi-timeframe paper autopilot (${DEFAULT_UNIVERSE.length} symbols)` },
  { taskType: `trading-research:${SUB}`, cron: '*/15 * * * *', label: 'News + fundamentals research brain (paper)' },
  // Offset off the */5 world-intelligence pulse boundary (:02,:07,:12…) so the bounded LLM fast leg
  // never shares a minute with the world pulse — the scheduler is single-flight, so a same-minute
  // collision would delay the pulse. 5-min cadence (was */2) also trims LLM load ~2.5×.
  { taskType: `trading-fast:${SUB}`, cron: '2-59/5 * * * *', label: 'Fast breaking-news brain (paper)' },
  { taskType: `trading-assess:${SUB}`, cron: '0 */2 * * *', label: 'Next-session assessment / predictions (paper, market-independent)' },
  { taskType: `trading-review:${SUB}`, cron: '30 6 * * *', label: 'Overnight signal review — learn per-signal mass + proximity' },
  // Daily TREND sleeve (the validated edge): Donchian breakout/exit on commodity/trend ETFs, held
  // across days. Runs ~10 min after the US open (13:40 UTC ≈ 09:40 ET, Mon–Fri) so the breakout is read
  // off completed daily closes and the market order fills in regular hours.
  { taskType: `trading-swing:${SUB}`, cron: '40 13 * * 1-5', label: 'Daily Donchian trend sleeve (commodity/trend ETFs, paper)' },
];

async function main(): Promise<void> {
  const store = new RedisScheduleStore();
  // No scheduling-enablement guard here — this is an operator-run enable, same as the route's bypass.
  const svc = new ScheduleService(store, async () => ({ success: true, scheduleId: 'noop' }));
  for (const leg of LEGS) {
    const rec = await svc.createSchedule({
      taskType: leg.taskType,
      schedule: leg.cron,
      taskData: { prompt: leg.label, userSub: SUB, mode: 'paper', universe: DEFAULT_UNIVERSE },
      ownerSub: SUB,
      queue: 'intelligent-trades',
    });
    console.log('enabled:', { id: rec.id, cron: rec.cron, nextRunAt: rec.nextRunAt });
  }
  console.log('advisor enabled for', SUB, '(technical + research + fast), universe', DEFAULT_UNIVERSE.length);
  await svc.shutdown().catch(() => { /* best-effort */ });
}
main().then(() => process.exit(0)).catch((e) => { console.error('enable failed:', e); process.exit(1); });
