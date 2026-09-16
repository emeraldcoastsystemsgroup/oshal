/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-145 D5: an app that declares no `summary:` still gets a card, composed from THIS user's own recent jarvis_tasks rows for that app (the existing `<App>: …` title-prefix convention). This is the ONLY data the kernel reads on an app's behalf and it is kernel-owned — jarvis_tasks is a core table with a core schema, never an app's store (D6.1). The composition is pure and separately testable; the read is one bounded, user-scoped query. A composed line NEVER escalates tone: a failed task warns, everything else is neutral, and nothing here can assert 'good' on an app's behalf.
 *
 * @module app-status-task-fallback
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { SwarmAppSummaryTone } from '../types';

const logger = createChildLogger({ module: 'app-status-task-fallback' });

/** ADR-145 D5 — the most recent three of an app's tasks, per app. */
export const APP_STATUS_FALLBACK_ITEMS = 3;
/**
 * Rows the single fallback query may read. The page calls this on every load, so the read is
 * bounded rather than scanning a user's task history: enough to fill the per-app cap for a
 * group's members several times over, small enough to stay on the (user_sub, created_at) index.
 */
export const APP_STATUS_FALLBACK_ROWS = 60;
/** ADR-145 D2's item bound, applied to the line this composes. */
export const APP_STATUS_FALLBACK_TEXT_CHARS = 120;

/** The cockpit Home view matches `^([^:]{1,40}):\s+` — an app whose name is longer than that
 *  cannot be matched by a title prefix there, so it is not matched here either. One convention. */
export const APP_STATUS_FALLBACK_PREFIX_CHARS = 40;

/** Task statuses that mean the work stopped without an answer — the only ones that warn. */
const FAILED_STATUSES: ReadonlySet<string> = new Set(['error', 'failed', 'cancelled', 'canceled', 'escalated']);
/** Task statuses that are still running, said the way the open-work block already says them. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['queued', 'pending', 'summarizing', 'running']);

/** An app the fallback composes items for. */
export interface AppStatusFallbackApp {
  name: string;
  displayName: string;
}

/** One `jarvis_tasks` row, narrowed to the columns this read needs. */
export interface AppStatusTaskRow {
  title: string;
  status: string;
  created_at?: string | Date | null;
}

/** One composed line, in the same shape a declared `items[]` entry renders as. */
export interface AppStatusFallbackItem {
  app: string;
  text: string;
  tone: SwarmAppSummaryTone;
}

/**
 * @description The title prefixes that mark a task as belonging to an app — its display name or
 * its manifest name followed by a colon (the core #305 `<App>: …` convention). Lower-cased,
 * de-duplicated, so matching is case-insensitive on both sides.
 * @param app - The app to match.
 * @returns One or two lower-cased prefixes, longest first.
 */
export function appTaskTitlePrefixes(app: AppStatusFallbackApp): string[] {
  const prefixes = [app.displayName, app.name]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
    .filter((value) => value.length <= APP_STATUS_FALLBACK_PREFIX_CHARS && !value.includes(':'))
    .map((value) => `${value.toLowerCase()}:`);
  return [...new Set(prefixes)].sort((a, b) => b.length - a.length);
}

/**
 * @description Escape a LIKE pattern's wildcards so an app whose name contains `%` or `_` cannot
 * widen its own match. Backslash is PostgreSQL's default LIKE escape character.
 * @param value - The literal prefix to match.
 * @returns The prefix as a LIKE pattern matching exactly that prefix, then anything.
 */
function likePrefix(value: string): string {
  return `${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * @description The age suffix a line carries. Age is part of the record: without it a month-old
 * row reads exactly like this morning's, which is the mistake the open-work block already paid
 * for once.
 * @param createdAt - The row's created_at, when it has one.
 * @returns " (today)" / " (1 day ago)" / " (N days ago)", or "" when the age is unknown.
 */
function ageSuffix(createdAt: AppStatusTaskRow['created_at']): string {
  if (!createdAt) return '';
  const at = new Date(createdAt).getTime();
  if (!Number.isFinite(at)) return '';
  const days = Math.floor((Date.now() - at) / 86400000);
  if (days <= 0) return ' (today)';
  return days === 1 ? ' (1 day ago)' : ` (${days} days ago)`;
}

/**
 * @description The tone a task status earns. Only a stopped task warns; everything else is
 * neutral. The kernel never asserts 'good' here — a green state is a claim only the app itself
 * may make, over its own declared route (ADR-145 D6.4).
 * @param status - The row's status column.
 * @returns A tone from the closed enum, never escalating.
 */
function toneForStatus(status: string): SwarmAppSummaryTone {
  return FAILED_STATUSES.has(status.toLowerCase()) ? 'warn' : 'neutral';
}

/**
 * @description The human state a line reports, matching how the open-work block already reads a
 * status out loud.
 * @param status - The row's status column.
 * @returns "done" | "failed" | "in progress" | the raw status.
 */
function stateForStatus(status: string): string {
  const value = status.toLowerCase();
  if (LIVE_STATUSES.has(value)) return 'in progress';
  if (FAILED_STATUSES.has(value)) return 'failed';
  return value;
}

/**
 * @description Compose the D5 fallback items from raw rows: assign each row to the app whose
 * title prefix it carries (longest prefix wins, so "Kalshi Trends: …" is not stolen by "Kalshi"),
 * keep the most recent {@link APP_STATUS_FALLBACK_ITEMS} per app, and render each as a bounded
 * line with its age. Rows arrive newest-first; a row matching no app is dropped.
 * @param rows - Rows from the fallback query, newest first.
 * @param apps - The apps in the plan that declared no `summary:`.
 * @returns Items in the apps' own order, each app's newest first.
 */
export function composeAppTaskItems(
  rows: readonly AppStatusTaskRow[],
  apps: readonly AppStatusFallbackApp[],
): AppStatusFallbackItem[] {
  const matchers = apps.map((app) => ({ app, prefixes: appTaskTitlePrefixes(app) }));
  const perApp = new Map<string, AppStatusFallbackItem[]>(apps.map((app) => [app.name, []]));
  for (const row of rows) {
    if (typeof row?.title !== 'string') continue;
    const title = row.title.trim();
    const lower = title.toLowerCase();
    let best: { app: AppStatusFallbackApp; length: number } | null = null;
    for (const matcher of matchers) {
      for (const prefix of matcher.prefixes) {
        // Colon AND whitespace, exactly as the cockpit Home view's `^([^:]{1,40}):\s+` reads it:
        // the two renderers must never disagree about which app a task belongs to.
        if (!lower.startsWith(prefix) || !/^\s/.test(lower.slice(prefix.length))) continue;
        if (!best || prefix.length > best.length) best = { app: matcher.app, length: prefix.length };
      }
    }
    if (!best) continue;
    const bucket = perApp.get(best.app.name) as AppStatusFallbackItem[];
    if (bucket.length >= APP_STATUS_FALLBACK_ITEMS) continue;
    const status = typeof row.status === 'string' ? row.status : '';
    const text = `${title.slice(best.length).trim() || title} — ${stateForStatus(status)}${ageSuffix(row.created_at)}`;
    bucket.push({
      app: best.app.name,
      text: text.length <= APP_STATUS_FALLBACK_TEXT_CHARS
        ? text
        : `${text.slice(0, APP_STATUS_FALLBACK_TEXT_CHARS - 1)}…`,
      tone: toneForStatus(status),
    });
  }
  return apps.flatMap((app) => perApp.get(app.name) as AppStatusFallbackItem[]);
}

/**
 * @description Read this user's own recent `jarvis_tasks` rows for the given apps and compose the
 * ADR-145 D5 fallback items. One bounded query, scoped to the caller's subject — the kernel reads
 * its own table on the app's behalf and never the app's. A failed read logs at ERROR and answers
 * an empty list, so a card degrades to "nothing to report" rather than failing the page.
 * @param pool - The core PostgreSQL pool.
 * @param sub - The signed-in user's OIDC subject.
 * @param apps - The apps in the plan that declared no `summary:`.
 * @returns Composed items, or an empty list when there is nothing (or the read failed).
 */
export async function readAppTaskFallback(
  pool: Pool,
  sub: string,
  apps: readonly AppStatusFallbackApp[],
): Promise<AppStatusFallbackItem[]> {
  if (!sub || apps.length === 0) return [];
  const patterns = apps.flatMap((app) => appTaskTitlePrefixes(app)).map(likePrefix);
  if (patterns.length === 0) return [];
  try {
    const result = await pool.query(
      `SELECT title, status, created_at FROM jarvis_tasks
        WHERE user_sub = $1 AND lower(title) LIKE ANY($2::text[])
        ORDER BY created_at DESC LIMIT $3`,
      [sub, patterns, APP_STATUS_FALLBACK_ROWS],
    );
    return composeAppTaskItems(result.rows as AppStatusTaskRow[], apps);
  } catch (err) {
    logger.error(
      { err, apps: apps.map((app) => app.name) },
      'ADR-145 D5 jarvis_tasks fallback read failed; the card reports nothing rather than a fact',
    );
    return [];
  }
}
