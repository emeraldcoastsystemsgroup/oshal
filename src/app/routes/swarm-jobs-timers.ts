/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B (step B5-9): the registry of the core's built-in in-process timers for the Swarm Admin jobs screen. Each entry names the timer, its cadence and the environment flag that gates it, with the gate and interval read at request time exactly as the module that starts the timer reads them (schedule-runtime, inbox-ingest, social-signal-subscriptions, feeds-indexing, gov-contracting-cron, update-check-cron, travel-farewatch, series-pump, jarvis-brief-cron, haven-proactivity-cron). Only booleans and intervals leave this module: no other environment value is ever echoed.
 */

/** One built-in timer as the jobs screen shows it. */
export interface BuiltInTimer {
  id: string;
  name: string;
  /** Plain words: how often it fires, with any per-user opt-in on top. */
  cadence: string;
  /** True when the gate the timer's module reads is on for this process. */
  enabled: boolean;
  /** The environment flag that gates or paces it. */
  flag: string;
  description: string;
}

/** The same truthiness the gated crons use: 1, true or yes, case-insensitive. */
const truthy = (value: string | undefined): boolean => ['1', 'true', 'yes'].includes(String(value ?? '').toLowerCase());

/** @description An integer minutes setting with the module's own default and floor. */
function minutes(raw: string | undefined, fallback: number, floor: number): number {
  const parsed = parseInt(raw || String(fallback), 10);
  return Math.max(Number.isFinite(parsed) ? parsed : fallback, floor);
}

/** @description A positive integer setting, or the fallback (how schedule-runtime reads the poll interval). */
function positiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * @description The platform schedule runner's gate and poll interval, as schedule-runtime reads them:
 * the runner starts only when ENABLE_AGENT_SCHEDULER is exactly 'true', and polls every
 * SCHEDULER_POLL_INTERVAL_MS (default 15000).
 * @param env - The process environment.
 * @returns Whether the runner starts, and its poll interval.
 */
export function readSchedulerGate(env: NodeJS.ProcessEnv): { enabled: boolean; pollIntervalMs: number } {
  return { enabled: env.ENABLE_AGENT_SCHEDULER === 'true', pollIntervalMs: positiveInteger(env.SCHEDULER_POLL_INTERVAL_MS, 15000) };
}

/**
 * @description Every built-in in-process timer with its gate read from the environment now. The
 * order is the boot order in server.ts, the runner first because it drives the scheduled jobs.
 * @param env - The process environment.
 * @returns The timers.
 */
export function readBuiltInTimers(env: NodeJS.ProcessEnv): BuiltInTimer[] {
  const runner = readSchedulerGate(env);
  const videoPumpMs = Number(env.VIDEO_PUMP_INTERVAL_MS || 20 * 60_000);
  const updateHours = Math.max(1, Number.parseFloat(env.UPDATE_CHECK_INTERVAL_HOURS || '24') || 24);
  return [
    { id: 'schedule-runner', name: 'Schedule runner', cadence: `polls every ${runner.pollIntervalMs} ms`, enabled: runner.enabled, flag: 'ENABLE_AGENT_SCHEDULER', description: 'Fires every scheduled job in the listing: trading legs, world refresh, digests, workflows and package service routes.' },
    { id: 'inbox-ingest', name: 'Inbox ingest', cadence: `every ${minutes(env.INBOX_INGEST_INTERVAL_MIN, 15, 2)} min`, enabled: true, flag: 'INBOX_INGEST_INTERVAL_MIN', description: "Captures new mail into each connected person's store. Always on; the flag sets the pace." },
    { id: 'social-signals', name: 'Social signal subscriptions', cadence: `every ${minutes(env.SOCIAL_SIGNAL_POLL_INTERVAL_MIN, 15, 2)} min`, enabled: true, flag: 'SOCIAL_SIGNAL_POLL_INTERVAL_MIN', description: 'Delivers caller-owned social watches from the inbox sensor. Always on; the flag sets the pace.' },
    { id: 'feeds-indexing', name: 'Feeds indexing', cadence: `every ${minutes(env.SLACK_INDEX_INTERVAL_MIN, 30, 5)} min`, enabled: true, flag: 'SLACK_INDEX_INTERVAL_MIN', description: "Indexes each connected person's Slack messages into their feed. Always on; the flag sets the pace." },
    { id: 'gov-contracting', name: 'SAM capture scan', cadence: 'daily at 06:00 (server clock)', enabled: truthy(env.GOVCON_CRON), flag: 'GOVCON_CRON', description: 'The daily SAM.gov capture scan and draft enqueue for the gov-contracting package.' },
    { id: 'update-check', name: 'Update check', cadence: `every ${updateHours} h`, enabled: !['0', 'false', 'no'].includes(String(env.UPDATE_CHECK_ENABLED ?? '').toLowerCase()), flag: 'UPDATE_CHECK_ENABLED', description: 'Two anonymous GitHub reads a day to tell whether core or the store has a newer release. On unless the flag is 0, false or no; UPDATE_CHECK_INTERVAL_HOURS sets the pace.' },
    { id: 'travel-farewatch', name: 'Travel fare watch', cadence: `every ${minutes(env.TRAVEL_FAREWATCH_INTERVAL_MIN, 360, 30)} min`, enabled: true, flag: 'TRAVEL_FAREWATCH_INTERVAL_MIN', description: 'Re-prices active fare watches and grows the shared price database. Always on; the flag sets the pace.' },
    { id: 'video-pump', name: 'Series video pump', cadence: `every ${Math.round(videoPumpMs / 60_000)} min`, enabled: String(env.VIDEO_PUMP_ENABLED ?? '').toLowerCase() === 'true', flag: 'VIDEO_PUMP_ENABLED', description: 'Renders the next scene of each authorized series on its video node. VIDEO_PUMP_INTERVAL_MS sets the pace.' },
    { id: 'jarvis-brief', name: 'Jarvis morning brief', cadence: 'daily 07:00–07:09 America/Chicago (checked every 5 min); each person opts in', enabled: truthy(env.JARVIS_BRIEF_CRON), flag: 'JARVIS_BRIEF_CRON', description: 'Delivers the morning brief to the people who turned it on in their notification preferences.' },
    { id: 'haven-push', name: 'Haven push proactivity', cadence: 'every 30 min; each person opts in', enabled: truthy(env.HAVEN_PUSH_CRON), flag: 'HAVEN_PUSH_CRON', description: 'Proactive Haven messages for the people who opted in, within their daily cap.' },
  ];
}
