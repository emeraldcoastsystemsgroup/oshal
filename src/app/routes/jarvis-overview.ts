/**
 * Jarvis Command Center overview — the glanceable home above the chat.
 *
 * Extracted from jarvis-routes.ts (2026-07-18, ADR-050 route decomposition). Each panel reads an
 * existing OSHAL source and is independently guarded — a missing source degrades to an empty state,
 * never a fabricated one (no-mock rule). All reads are user-scoped; the activity panel uses `tickets`
 * (which has owner_sub), NOT chat_tasks (no owner column → would leak across users; see the
 * public-launch isolation audit). Behaviour unchanged.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from jarvis-routes.ts: buildBots / buildComms / buildActivity / buildCalendar overview panels + the email-digest envelope decrypt helper (route decomposition, no behaviour change).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | buildBots online now uses resolveDisplayOnline(heartbeat, container): inline/api-hosted bots (dnd/spaces/security-analyst/…) never heartbeat, so the Command Center swarm map painted them permanently offline even while they ran real work (dnd active-but-offline was the tell). Roster is getActiveRegistry() (dynamic-inclusive) so each bot's container is available for the inline check.
 *
 * @module jarvis-overview
 */

import * as crypto from 'crypto';
import type { AppContext } from '@/app/composition/app-context';
import { SwarmBotRegistry } from '@/app/extensions/swarm/swarm-bot-registry';
import { resolveDisplayOnline } from '@/features/agent-management';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'jarvis-overview' });

/** AES-256-GCM key = SHA256(SESSION_SECRET) — the project-wide envelope scheme. */
function aesKey(): Buffer {
  return crypto.createHash('sha256').update(process.env.SESSION_SECRET || 'oshal-dev-secret').digest();
}
/** Decrypt an `iv:tag:enc` base64 envelope (e.g. the email digest) back to UTF-8. */
function decryptEnvelope(blob: string): string {
  const [iv, tag, enc] = String(blob).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', aesKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

/** Ticket states that are no longer "active work". */
const CLOSED_TICKET_STATES = new Set(['complete', 'cancelled']);

/** The swarm map: every registered bot + its live online status (heartbeats) + whether it was
 *  ACTUALLY CALLED to process in the last 2 min. "Active" comes from chat_tasks executions (cost
 *  capture writes a row per real run) — health checks never touch chat_tasks, so this lights a node
 *  only when it did real work, and the 2-min window re-evaluates each poll (so it holds ~2 min). */
export async function buildBots(ctx: AppContext): Promise<Array<Record<string, unknown>>> {
  const roster = SwarmBotRegistry.listDefinitions().filter((b) => b.agentId);
  let online = new Set<string>();
  try {
    const ids = (await ctx.swarm?.runtimeRegistryService?.listOnlineAgentIds?.()) ?? [];
    online = new Set(ids);
  } catch (err) { logger.warn({ err }, 'overview: online agent ids unavailable'); }
  let active = new Set<string>();
  try {
    const rows = (await ctx.pool.query(
      `SELECT DISTINCT agent_id FROM chat_tasks WHERE agent_id IS NOT NULL AND updated_at > NOW() - interval '2 minutes'`,
    )).rows as Array<{ agent_id: string }>;
    active = new Set(rows.map((r) => String(r.agent_id)));
  } catch (err) { logger.warn({ err }, 'overview: recent bot activity unavailable'); }
  let disabled = new Set<string>();
  try {
    const rows = (await ctx.pool.query(
      `SELECT agent_id FROM agents WHERE status IN ('inactive','disabled','paused')`,
    )).rows as Array<{ agent_id: string }>;
    disabled = new Set(rows.map((r) => String(r.agent_id)));
  } catch (err) { logger.warn({ err }, 'overview: disabled agent set unavailable'); }
  return roster.map((b) => ({
    agentId: b.agentId, name: b.name, role: b.role,
    capabilities: b.capabilities.slice(0, 4),
    // Inline/api-hosted bots never heartbeat; online when the api is up UNLESS operator-disabled.
    online: resolveDisplayOnline(online.has(b.agentId as string), b.container, !disabled.has(b.agentId as string)),
    active: active.has(b.agentId as string),   // called to process in the last ~2 min (not a health check)
  }));
}

/** Comms highlights: the latest email digest + recent social signals (user-scoped). */
export async function buildComms(ctx: AppContext, sub: string): Promise<Record<string, unknown>> {
  let digest: { summary: string; updatedAt: string } | null = null;
  let signals: Array<Record<string, unknown>> = [];
  try {
    const row = (await ctx.pool.query('SELECT summary, updated_at FROM oshal_email_digests WHERE user_sub = $1', [sub])).rows[0];
    if (row?.summary) { try { digest = { summary: decryptEnvelope(row.summary), updatedAt: row.updated_at }; } catch { /* key/format mismatch — skip */ } }
  } catch (err) { logger.warn({ err }, 'overview: email digest unavailable'); }
  try {
    signals = (await ctx.pool.query(
      `SELECT from_addr, subject, snippet, received_at FROM oshal_inbox_messages
        WHERE user_sub = $1 AND category = 'social' AND received_at > NOW() - interval '7 days'
        ORDER BY received_at DESC LIMIT 8`, [sub])).rows
      .map((r) => ({ from: r.from_addr, subject: r.subject, snippet: r.snippet, at: r.received_at }));
  } catch (err) { logger.warn({ err }, 'overview: social signals unavailable'); }
  return { digest, signals };
}

/** Key-queue activity: the caller's active tickets (owner-scoped — never global). */
export async function buildActivity(ctx: AppContext, sub: string): Promise<Record<string, unknown>> {
  try {
    const all = await ctx.ticketService.listTickets({ ownerSub: sub, limit: 100 });
    const active = all.filter((t) => !CLOSED_TICKET_STATES.has(String(t.status)));
    const tickets = active
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, 8)
      .map((t) => ({ id: t.ticketId, title: t.title, type: t.ticketType, status: t.status, updatedAt: t.updatedAt }));
    return { tickets, openCount: active.length };
  } catch (err) {
    logger.warn({ err }, 'overview: ticket activity unavailable');
    return { tickets: [], openCount: 0 };
  }
}

/** Combined calendar: upcoming events. The education source left with the Little Monsters
 *  carve-out (ADR-085 — its lm_calendar_events table now belongs to the installed package);
 *  email/home sources are roadmap. Returns empty until a generic app-contributed calendar
 *  feed exists (an installed app should CONTRIBUTE events, not be hard-queried here). */
export async function buildCalendar(_ctx: AppContext, _sub: string): Promise<Record<string, unknown>> {
  return { events: [] };
}
