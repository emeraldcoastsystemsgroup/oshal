/**
 * Content Routes — LinkedIn AI Content Assistant (ADR-038 + the content PRD).
 *
 * The conversational research→topics→draft engine. Replaces the dead Google
 * Search MCP with keyless feeds (Hacker News / Reddit / Lobsters / RSS) via
 * scripts/oshal-research.js. Split, same as email/social:
 *  - **Research** (public feeds) runs in the api (deterministic, cached).
 *  - **Reasoning** — cluster candidates into leading topic cards, and draft a
 *    post from the user's take — runs ON the comms bot (codex).
 * Personal-LinkedIn publishing is intentionally NOT wired here (owner: a bot on
 * the agenticfederal Page is the future posting path). This surface leads the
 * user: hot topics → "what's your take?" → draft.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial content assistant: GET /studio + /topics (research -> bot clusters -> cards, cached per user), /focus (get/set), POST /draft (topic + take -> bot), /drafts (save/list). Per-user tables, no posting.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Conversational refine loop: POST /refine revises an existing draft per a single instruction (punchier / more technical / add a CTA / shorter / end with a question) keeping the user's voice. Makes the studio iterative ("walk the user through options") instead of one-shot draft.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Intelligence fix: /draft now takes the article `url` + `source` and writes an actual ARTICLE SHARE — hook → the user's take → the article link (the bot MUST include the URL). Was producing link-less posts; the whole point of "share an article" is the link. Lead with the user's comment, not a summary.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Email-sourced social signals (opt-in): GET/POST /settings (email_social_scan), GET /signals scans the connected Gmail (getValidAccessToken) for social-network notifications (work anniversaries, new jobs, birthdays, connections, mentions), classifies + ranks them, and POST /note drafts a short warm engagement note. Surfaces proactive "congratulate X" prompts from the user's own inbox.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Fix the empty/slow feed: /topics no longer blocks on the 40s comms-bot clustering. It returns REAL articles immediately from the research engine (cardsFromResearch, deterministic ~2s), caches them, then enriches in the BACKGROUND (sharper angle/question) for the next load. Added a prewarm CRON (startTopicsPrewarm) that refreshes enriched hot topics for every user with a focus, 1 min after boot then every 30 min — so the screen loads instantly with data instead of triggering a cold bot call on every visit.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Persistent article store (oshal_content_articles, retained w/ timestamps + matched topics) + POST /dismiss (hide-but-retain) + GET /articles (history). Research-backed POST /draft-deep (bot proposes queries → news engine gathers real evidence → grounded, cited write, no fabrication). GET /related — connects an article to others in the retained store by shared topics + title overlap (the memory/similarity layer; deterministic, semantic embeddings a future upgrade since chroma query embeddings 422 here).
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Token broker: runOnBot takes the pg pool and resolves the caller's google+twitter access tokens via the controller (resolveBotCreds), threading them to the comms bot (creds) so it uses provided short-lived tokens instead of needing SESSION_SECRET to decrypt oshal_connections. Pool threaded through buildSignalCards/enrichTopicCards/deepQueries/deepDraft; the cron path passes its own pool.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Ran the scheduled topic-prewarm sweep under runWithSystemIdentity — a cross-owner background sweep; SYSTEM keeps it visible once OSHAL_DB_GUC_STRICT denies the identity-less case.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Wrapped the BOOT setTimeout prewarm in runWithSystemIdentity too — the 15:30 change wrapped only the interval tick, so the +60s boot prewarm still ran identity-less (surfaced by the hardened guc warn-audit).
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Security hardening: remove Google/Twitter credential forwarding from comms-bot reasoning requests; provider operations resolve credentials only inside audited server-side handlers.
 *
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Isolate the public-feed research child from controller/database/connector secrets with an explicit runtime environment.
 *
 * @module content-routes
 */

import { Router, type Request, type Response, type RequestHandler } from 'express';
import * as path from 'path';
import { spawn } from 'child_process';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import type { AppContext } from '@/app/composition/app-context';
import { BotNodeClient, createRegistryEndpointResolver } from '@/features/agent-management';
import { getValidAccessToken } from './connectors-routes';
import { executeBotOrInline } from './inline-bot-execution';

const logger = createChildLogger({ module: 'content-routes' });

const COMMS_BOT_AGENT_ID = 'b0000000-0000-0000-0000-000000000001';
const botClient = new BotNodeClient(createRegistryEndpointResolver());
const TOPICS_TTL_MS = 3 * 60 * 60 * 1000; // cache topic cards 3h
const RESEARCH_PROCESS_ENV_KEYS = [
  'PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
] as const;

/** Build the public-feed child environment without inheriting platform credentials. */
export function buildResearchProcessEnv(
  focus: string | null,
  limit: number,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of RESEARCH_PROCESS_ENV_KEYS) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  env.CONTENT_LIMIT = String(limit);
  if (focus) env.CONTENT_FOCUS = focus;
  return env;
}

function callerSub(req: Request): string | null {
  const u = (req as { oidc?: { user?: { sub?: string } } }).oidc?.user;
  return u?.sub ? String(u.sub) : null;
}
function servePage(apiDir: string, file: string): RequestHandler {
  return (_req, res) => {
    res.sendFile(path.join(apiDir, file), (err) => {
      if (err) { logger.error({ err, file }, 'serve failed'); res.status(404).send('Not found'); }
    });
  };
}

/** Run the research CLI (public feeds) and return parsed candidates. */
function runResearch(focus: string | null, limit = 25): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const script = path.resolve(process.cwd(), 'scripts/oshal-research.js');
    const child = spawn('node', [script], { env: buildResearchProcessEnv(focus, limit) });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`research exit ${code}: ${err.slice(0, 200)}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e as Error); }
    });
    setTimeout(() => { try { child.kill(); } catch { /* noop */ } reject(new Error('research timed out')); }, 60_000);
  });
}

/** Dispatch a reasoning prompt to the comms bot. The request carries exact owner identity,
 * never connector credentials; audited provider operations resolve their own secrets. */
async function runOnBot(kind: string, sub: string, prompt: string, ctx?: AppContext): Promise<string> {
  const request = {
    text: prompt, taskId: `content-${kind}-${sub}`, workspaceFolderId: `content-${sub}`,
    agentId: COMMS_BOT_AGENT_ID, agenticMode: true, direct: true, userSub: sub,
  };
  const result = ctx
    ? await executeBotOrInline(ctx, botClient, COMMS_BOT_AGENT_ID, request)
    : await botClient.execute(COMMS_BOT_AGENT_ID, request);
  return result.response;
}

/** Pull the first JSON array/object out of an LLM response. */
function extractJson(text: string): unknown {
  const s = String(text || '');
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  const o = s.indexOf('{'), c = s.lastIndexOf('}');
  const tryParse = (str: string) => { try { return JSON.parse(str); } catch { return null; } };
  if (a !== -1 && b > a) { const v = tryParse(s.slice(a, b + 1)); if (v) return v; }
  if (o !== -1 && c > o) { const v = tryParse(s.slice(o, c + 1)); if (v) return v; }
  return null;
}

export async function ensureContentSchema(pool: AppContext['pool']): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'content routes',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_content_topics (
        user_sub TEXT PRIMARY KEY, cards JSONB, focus TEXT, generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS oshal_content_drafts (
        id SERIAL PRIMARY KEY, user_sub TEXT NOT NULL, topic TEXT, take TEXT, draft TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS oshal_content_focus (
        user_sub TEXT PRIMARY KEY, focus TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS oshal_content_settings (
        user_sub TEXT PRIMARY KEY, email_social_scan BOOLEAN NOT NULL DEFAULT false, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS oshal_content_articles (
        user_sub TEXT NOT NULL, url TEXT NOT NULL, title TEXT, source TEXT,
        matched JSONB, score INT, published_at TIMESTAMPTZ,
        first_seen TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
        dismissed BOOLEAN NOT NULL DEFAULT false, dismissed_at TIMESTAMPTZ,
        PRIMARY KEY (user_sub, url)
      )`,
      'CREATE INDEX IF NOT EXISTS idx_content_articles_user_seen ON oshal_content_articles (user_sub, dismissed, last_seen DESC)',
    ],
    requirements: [
      { table: 'oshal_content_topics', columns: ['user_sub', 'cards', 'focus', 'generated_at'] },
      { table: 'oshal_content_drafts', columns: ['id', 'user_sub', 'topic', 'take', 'draft', 'created_at'] },
      { table: 'oshal_content_focus', columns: ['user_sub', 'focus', 'updated_at'] },
      { table: 'oshal_content_settings', columns: ['user_sub', 'email_social_scan', 'updated_at'] },
      {
        table: 'oshal_content_articles',
        columns: [
          'user_sub',
          'url',
          'title',
          'source',
          'matched',
          'score',
          'published_at',
          'first_seen',
          'last_seen',
          'dismissed',
          'dismissed_at',
        ],
      },
    ],
  });
}

async function getFocus(pool: AppContext['pool'], sub: string): Promise<string | null> {
  return (await pool.query('SELECT focus FROM oshal_content_focus WHERE user_sub = $1', [sub])).rows[0]?.focus || null;
}

async function getEmailScan(pool: AppContext['pool'], sub: string): Promise<boolean> {
  return !!(await pool.query('SELECT email_social_scan FROM oshal_content_settings WHERE user_sub = $1', [sub])).rows[0]?.email_social_scan;
}

/** Online-communication best practices every drafted post must follow — the
 *  brand rails: accurate, consistent, click-earning, not clickbait. */
const POST_BEST_PRACTICES = [
  'Follow these online-communication best practices:',
  '- HOOK: open with one scroll-stopping line — curiosity or a clear payoff. Earn the click; never bait-and-switch.',
  '- ACCURATE: state ONLY what the article/source supports. Never invent facts, metrics, quotes, features, or dates. If unsure, frame as a question or "reportedly".',
  '- CONSISTENT VOICE: steady, credible, first-person builder voice — confident, not hypey. No emoji spam (0–2 purposeful ones max).',
  '- CLICK-DRAWING: tease the insight, don\'t dump it; give a concrete reason to read the linked piece.',
  '- SCANNABLE: short lines and white space, not a wall of text. One link only.',
  '- CLOSE: end with a soft call-to-action or a genuine question that invites comments.',
  '- 2–4 relevant, specific hashtags at the very end (not generic #motivation filler).',
].join('\n');

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
/** Social-network notification senders we scan for engagement signals. */
const SOCIAL_SENDERS = 'from:linkedin.com OR from:facebookmail.com OR from:mail.instagram.com OR from:x.com OR from:twitter.com';

/** Obvious non-actionable noise we drop BEFORE spending bot tokens: security/login
 *  alerts, password/verification, and pure "you have N notifications" counters. */
const SIGNAL_NOISE = /\b(log ?in|logged in|sign-?in|signed in|new device|new login|security|verify|verification|password|confirm your|two-?factor|2fa|unusual activity|suspicious)\b|you have \d+ new notif|\d+ new notifications?$/i;

/** Fetch recent social-network notification emails (raw) for the connected account. */
async function fetchSocialEmails(token: string): Promise<Array<Record<string, string>>> {
  const q = `(${SOCIAL_SENDERS}) newer_than:21d`;
  const list = (await (await fetch(`${GMAIL}/messages?q=${encodeURIComponent(q)}&maxResults=25`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { messages?: Array<{ id: string }> };
  const out: Array<Record<string, string>> = [];
  for (const m of (list.messages || []).slice(0, 25)) {
    const msg = (await (await fetch(`${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { payload?: { headers?: Array<{ name: string; value: string }> }; snippet?: string };
    const headers = Object.fromEntries((msg.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
    const subject = headers.subject || '';
    if (!subject || SIGNAL_NOISE.test(subject)) continue; // drop security/notification-count noise
    out.push({ subject, from: headers.from || '', date: headers.date || '', snippet: msg.snippet || '' });
  }
  return out;
}

/** Turn raw social emails into ACTIONABLE engagement recommendations (bot reasoning).
 *  This is the "agent looking at the data": it decides what's worth acting on,
 *  names the person, and proposes a specific action — instead of dumping inbox noise. */
async function buildSignalCards(pool: AppContext['pool'], sub: string, emails: Array<Record<string, string>>): Promise<unknown[]> {
  if (!emails.length) return [];
  const prompt = [
    'Below is JSON of recent social-network notification emails (LinkedIn / Facebook / Instagram / X).',
    'Act as my social-engagement assistant. For EACH that is a genuine opportunity to engage, return an object:',
    '{ "type": one of anniversary|new-job|birthday|connection|follow|story|mention|engagement,',
    '  "person": the specific person/account name if identifiable (else ""),',
    '  "action": a short specific suggested action ("Follow back", "Congratulate", "React + comment", "Check their stories", "Follow"),',
    '  "summary": ONE specific sentence on what happened and why it may be worth my attention,',
    '  "priority": high|medium|low,',
    '  "network": linkedin|facebook|instagram|x }.',
    'DROP pure noise entirely (digests, "see what you missed", algorithmic filler with no specific person/action).',
    'Prefer real relationships: someone followed/mentioned/connected with me, a work anniversary or new job, a notable person in suggestions.',
    'Output ONLY a JSON array, most actionable first, max 8 objects. Nothing else.',
    '',
    JSON.stringify(emails).slice(0, 8000),
  ].join('\n');
  const cards = extractJson(await runOnBot('signals', sub, prompt));
  return Array.isArray(cards) ? cards : [];
}

/** Map research candidates → topic cards DETERMINISTICALLY (no LLM, ~instant).
 *  This is what the screen shows immediately — real articles, never an empty wait.
 *  Bot enrichment (sharper angle/question) layers on top in the background. */
function cardsFromResearch(research: unknown): Array<Record<string, unknown>> {
  const candidates = (research as { candidates?: Array<Record<string, unknown>> })?.candidates || [];
  return candidates.slice(0, 6).map((c) => {
    const matched = Array.isArray(c.matched) ? (c.matched as string[]) : [];
    return {
      title: c.title, source: c.source || 'web', url: c.url,
      date: c.createdAt || null,
      whyItMatters: matched.length ? `Trending now in ${matched.slice(0, 3).join(', ')}.` : 'Trending in your space right now.',
      angle: 'Share what this means for the work you do — your concrete, first-hand take.',
      question: "What's your read on this — does it match what you're seeing?",
      enriched: false,
    };
  });
}

/** Enrich the deterministic cards with the comms bot (sharper whyItMatters / angle /
 *  question). Returns null on any failure so callers fall back to the base cards. */
async function enrichTopicCards(pool: AppContext['pool'], sub: string, research: unknown, focus: string | null): Promise<Array<Record<string, unknown>> | null> {
  const audience = focus
    ? `someone focused on: ${focus} (prefer items relevant to that; otherwise pick the most discussion-worthy tech/AI items)`
    : 'someone who BUILDS AI agents, multi-agent swarms, OSHAL, and enterprise AI/automation';
  const prompt = [
    'Below is JSON of trending article candidates (title, source, url, points, matched topics).',
    `Pick the 6 most discussion-worthy for ${audience}. For each, return an object:`,
    '{ "title": punchy topic title, "source": source, "url": best link, "whyItMatters": one sentence,',
    '  "angle": a suggested LinkedIn post angle, "question": ONE question to draw out my own take }.',
    'Skip duplicates and off-topic/politics items. Output ONLY a JSON array of 6 objects, nothing else.',
    '',
    JSON.stringify((research as { candidates?: unknown })?.candidates ?? research).slice(0, 12000),
  ].join('\n');
  try {
    const cards = extractJson(await runOnBot('topics', sub, prompt));
    if (!Array.isArray(cards) || !cards.length) return null;
    return cards.map((c) => ({ ...(c as Record<string, unknown>), enriched: true }));
  } catch (err) {
    logger.warn({ err, sub }, 'topic enrichment failed; keeping deterministic cards');
    return null;
  }
}

/** Run research with the narrow-focus → broad fallback. Shared by /topics + the prewarm cron. */
async function researchForFocus(focus: string | null): Promise<unknown> {
  let research = (await runResearch(focus, 25)) as { count?: number };
  if (focus && (research?.count ?? 0) < 4) research = (await runResearch(null, 25)) as { count?: number };
  return research;
}

/** Parse a feed date into a Date or null (no throw). */
function parseDate(v: unknown): Date | null {
  const t = Date.parse(String(v || ''));
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Meaningful lowercased title tokens (≥4 chars) for overlap scoring. */
function titleTokens(s: unknown): Set<string> {
  return new Set(String(s || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []);
}

/** Find articles RELATED to a target — shared matched-topics (weighted) + title-token
 *  overlap over the retained store. Deterministic, no LLM/chroma. This is the memory
 *  layer: it connects a story to others the user has seen on the same threads. */
async function relatedArticles(pool: AppContext['pool'], sub: string, url: string, limit = 5): Promise<Array<Record<string, unknown>>> {
  const target = (await pool.query('SELECT title, matched FROM oshal_content_articles WHERE user_sub=$1 AND url=$2', [sub, url])).rows[0];
  if (!target) return [];
  const topics = new Set((Array.isArray(target.matched) ? target.matched : []).map((t: unknown) => String(t).toLowerCase()));
  const tTokens = titleTokens(target.title);
  const rows = (await pool.query(
    'SELECT url, title, source, matched, last_seen FROM oshal_content_articles WHERE user_sub=$1 AND url<>$2 ORDER BY last_seen DESC LIMIT 300', [sub, url])).rows;
  return rows
    .map((r) => {
      const rTopics = (Array.isArray(r.matched) ? r.matched : []).map((t: unknown) => String(t).toLowerCase());
      const sharedTopics = rTopics.filter((t: string) => topics.has(t)).length;
      let sharedTokens = 0;
      for (const t of titleTokens(r.title)) if (tTokens.has(t)) sharedTokens++;
      return { url: r.url, title: r.title, source: r.source, lastSeen: r.last_seen, score: sharedTopics * 3 + sharedTokens };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Upsert every research candidate into the persistent store (retain history + timestamps).
 *  Keeps first_seen + dismissed across re-pulls; refreshes title/source/score/last_seen. */
async function persistArticles(pool: AppContext['pool'], sub: string, research: unknown): Promise<void> {
  const candidates = ((research as { candidates?: Array<Record<string, unknown>> })?.candidates) || [];
  for (const c of candidates) {
    if (!c.url) continue;
    try {
      await pool.query(
        `INSERT INTO oshal_content_articles (user_sub, url, title, source, matched, score, published_at, first_seen, last_seen)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())
         ON CONFLICT (user_sub, url) DO UPDATE SET title=$3, source=$4, matched=$5, score=$6, last_seen=now()`,
        [sub, c.url, c.title || '', c.source || 'web', JSON.stringify(c.matched || []), Number(c.score) || 0, parseDate(c.createdAt)]);
    } catch (err) { logger.warn({ err, url: c.url }, 'persist article failed'); }
  }
}

/** Research → persist (retain) → return candidates with dismissed ones filtered OUT.
 *  Shared by /topics + the prewarm cron so dismissals stick across pulls. */
async function freshResearchFor(pool: AppContext['pool'], sub: string, focus: string | null): Promise<{ candidates: Array<Record<string, unknown>> }> {
  const research = await researchForFocus(focus);
  await persistArticles(pool, sub, research);
  const dismissed = new Set(
    (await pool.query('SELECT url FROM oshal_content_articles WHERE user_sub=$1 AND dismissed=true', [sub])).rows.map((r) => r.url as string),
  );
  const candidates = (((research as { candidates?: Array<Record<string, unknown>> })?.candidates) || []).filter((c) => c.url && !dismissed.has(c.url as string));
  return { candidates };
}

/** Persist topic cards for a user (the screen reads this cache; the cron keeps it warm). */
async function cacheTopics(pool: AppContext['pool'], sub: string, cards: unknown, focus: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO oshal_content_topics (user_sub, cards, focus, generated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (user_sub) DO UPDATE SET cards=$2, focus=$3, generated_at=now()`,
    [sub, JSON.stringify(cards), focus]);
}

/** Pre-warm enriched topic cards for every user who has set a focus, so the screen
 *  loads instantly with fresh hot topics instead of triggering a cold 40s bot call. */
async function prewarmAllTopics(pool: AppContext['pool']): Promise<void> {
  const users = (await pool.query('SELECT user_sub, focus FROM oshal_content_focus')).rows as Array<{ user_sub: string; focus: string | null }>;
  logger.info({ users: users.length }, 'content topics prewarm starting');
  for (const u of users) {
    try {
      const research = await freshResearchFor(pool, u.user_sub, u.focus);
      const enriched = await enrichTopicCards(pool, u.user_sub, research, u.focus);
      await cacheTopics(pool, u.user_sub, enriched || cardsFromResearch(research), u.focus);
    } catch (err) {
      logger.warn({ err, sub: u.user_sub }, 'prewarm failed for user');
    }
  }
}

/** Start the topics prewarm cron: once shortly after boot, then on an interval. */
function startTopicsPrewarm(pool: AppContext['pool']): void {
  const everyMs = Number(process.env.CONTENT_PREWARM_MS) || 30 * 60 * 1000;
  setTimeout(() => { runWithSystemIdentity(() => prewarmAllTopics(pool)).catch((err) => logger.warn({ err }, 'initial prewarm failed')); }, 60_000).unref();
  setInterval(() => { runWithSystemIdentity(() => prewarmAllTopics(pool)).catch((err) => logger.warn({ err }, 'scheduled prewarm failed')); }, everyMs).unref();
  logger.info({ everyMs }, 'content topics prewarm cron scheduled');
}

/** Step 1 of a deep analysis: have the bot propose targeted news-search queries
 *  that would surface the FACTS needed to ground the post (no writing yet). */
async function deepQueries(pool: AppContext['pool'], sub: string, topic: string, take: string, source?: string): Promise<string[]> {
  const prompt = [
    'I want a RESEARCH-BACKED analysis post. Given the article and my goal, list 3-4 specific',
    'news/web SEARCH QUERIES that would surface the FACTS I need (historical data points, prior',
    'events, comparable figures, year-over-year placements). Output ONLY a JSON array of query strings.',
    `Article: ${topic}${source ? ` (${source})` : ''}`,
    `My goal/take: ${take || '(general analysis)'}`,
  ].join('\n');
  const q = extractJson(await runOnBot('deep-queries', sub, prompt));
  const list = Array.isArray(q) ? q.filter((x) => typeof x === 'string' && x.trim()).slice(0, 4) : [];
  return list.length ? list : [topic];
}

/** Step 2: gather grounding evidence (real article snippets) for each query via the news engine. */
async function gatherEvidence(queries: string[]): Promise<Array<Record<string, unknown>>> {
  const evidence: Array<Record<string, unknown>> = [];
  for (const query of queries) {
    try {
      const research = (await runResearch(query, 8)) as { candidates?: Array<Record<string, unknown>> };
      for (const c of (research.candidates || []).slice(0, 5)) {
        if (c.url) evidence.push({ query, title: c.title, source: c.source, url: c.url, date: c.createdAt });
      }
    } catch (err) { logger.warn({ err, query }, 'deep evidence gather failed'); }
  }
  return evidence;
}

/** Step 3: write the post grounded ONLY in the gathered evidence — explicitly forbidden
 *  from inventing placements/metrics/quotes. This is what makes a trend post defensible. */
async function deepDraft(pool: AppContext['pool'], sub: string, topic: string, take: string, url: string | undefined, source: string | undefined, evidence: unknown, tone?: string): Promise<string> {
  const prompt = [
    `You are my personal-branding communications assistant. Write a ${tone || 'credible, analytical builder-voice'} LinkedIn post — a RESEARCH-BACKED analysis.`,
    `Article: ${topic}${source ? ` (${source})` : ''}`,
    url ? `Primary link — include this exact URL once: ${url}` : '',
    `My goal/take: ${take || '(analyze the trend)'}`,
    '',
    'GROUND TRUTH — you may state ONLY facts supported by the findings below. Do NOT invent',
    'placements, rankings, metrics, dates, or quotes. If a claim the post needs is NOT in the',
    'findings, explicitly say you could not confirm it rather than guessing. Reference source names inline.',
    JSON.stringify((evidence as { length?: number })?.length ? evidence : []).slice(0, 9000),
    '',
    POST_BEST_PRACTICES,
    'If the findings reveal a clear trend, state the direction and WHY. Output ONLY the post text.',
  ].filter(Boolean).join('\n');
  return runOnBot('deep-draft', sub, prompt);
}

/** Build the refine prompt — revise THIS draft per one instruction, keep the voice. */
function buildRefinePrompt(draft: string, instruction: string, topic?: string, take?: string): string {
  return [
    'Revise the LinkedIn post below. Apply this one change:',
    `>> ${instruction}`,
    '',
    'Keep my voice and the core point. Do NOT invent metrics, quotes, or stories.',
    'Output ONLY the revised post text — no preamble, no explanation, no "Here is".',
    topic ? `(Topic: ${topic})` : '',
    take ? `(My original take: ${take})` : '',
    '',
    'CURRENT POST:',
    draft,
  ].filter(Boolean).join('\n');
}

/**
 * @description Builds the content assistant router (mount at /api/content).
 */
export function createContentRoutes(ctx: AppContext, apiDir: string): Router {
  const router = Router();
  ensureContentSchema(ctx.pool).catch((err) => logger.error({ err }, 'content schema'));
  startTopicsPrewarm(ctx.pool);

  router.get('/studio', servePage(apiDir, 'content-studio.html'));

  /** GET /focus — current focus terms. */
  router.get('/focus', async (req, res) => {
    const sub = callerSub(req); if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    res.json({ focus: await getFocus(ctx.pool, sub) });
  });
  /** POST /focus — set focus terms (comma-separated). */
  router.post('/focus', async (req, res) => {
    const sub = callerSub(req); if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const focus = (req.body as { focus?: string })?.focus?.trim() || null;
    await ctx.pool.query(
      `INSERT INTO oshal_content_focus (user_sub, focus, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (user_sub) DO UPDATE SET focus=$2, updated_at=now()`, [sub, focus]);
    res.json({ ok: true, focus });
  });

  /** GET /settings — content assistant settings (email social-update scan opt-in). */
  router.get('/settings', async (req, res) => {
    const sub = callerSub(req); if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    res.json({ emailSocialScan: await getEmailScan(ctx.pool, sub) });
  });
  /** POST /settings — toggle the email social-update scan (opt-in). */
  router.post('/settings', async (req, res) => {
    const sub = callerSub(req); if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const on = (req.body as { emailSocialScan?: boolean })?.emailSocialScan === true;
    await ctx.pool.query(
      `INSERT INTO oshal_content_settings (user_sub, email_social_scan, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (user_sub) DO UPDATE SET email_social_scan=$2, updated_at=now()`, [sub, on]);
    res.json({ ok: true, emailSocialScan: on });
  });

  /** GET /signals — engagement signals (work anniversaries, new jobs, …) mined from connected email. Opt-in. */
  router.get('/signals', async (req, res) => {
    const sub = callerSub(req); if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    if (!(await getEmailScan(ctx.pool, sub))) { res.json({ enabled: false, signals: [] }); return; }
    const token = await getValidAccessToken(ctx.pool, sub, 'google');
    if (!token) { res.status(409).json({ error: 'no_google_connection', message: 'Connect Google at /utilities to scan email.' }); return; }
    try {
      const emails = await fetchSocialEmails(token);
      const signals = await buildSignalCards(ctx.pool, sub, emails);
      res.json({ enabled: true, signals, scanned: emails.length });
    } catch (err) {
      logger.error({ err }, 'signals scan failed');
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** POST /note — draft a short, warm engagement note for a social signal (congrats, welcome, …). */
  router.post('/note', async (req, res) => {
    const sub = callerSub(req); if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const b = req.body as { subject?: string; type?: string; from?: string };
    const subject = b?.subject?.trim();
    if (!subject) { res.status(400).json({ error: 'subject required' }); return; }
    try {
      const prompt = [
        'Write a short, warm, genuine note to send/post for this social signal — specific, NOT generic.',
        `Signal type: ${b.type || 'update'}`,
        `Notification: ${subject}`,
        b.from ? `From: ${b.from}` : '',
        '',
        '1-2 sentences, first-person, specific to the person and occasion. No hashtags, no preamble.',
        'Output ONLY the note text.',
      ].filter(Boolean).join('\n');
      res.json({ note: await runOnBot('note', sub, prompt, ctx) });
    } catch (err) {
      logger.error({ err }, 'note failed');
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** GET /topics — leading topic cards (cached; ?refresh=1 to re-pull). */
  router.get('/topics', async (req, res) => {
    const sub = callerSub(req); if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    try {
      const refresh = req.query.refresh === '1';
      const cached = (await ctx.pool.query('SELECT cards, generated_at FROM oshal_content_topics WHERE user_sub = $1', [sub])).rows[0];
      if (!refresh && cached && Date.now() - new Date(cached.generated_at).getTime() < TOPICS_TTL_MS) {
        res.json({ cards: cached.cards, generatedAt: cached.generated_at, cached: true });
        return;
      }
      const focus = await getFocus(ctx.pool, sub);
      // Persist all articles (retained history) + drop ones the user dismissed.
      const research = await freshResearchFor(ctx.pool, sub, focus);
      // Return REAL articles immediately (deterministic, ~instant) — the screen never
      // waits 40s on the bot. Cache them, then enrich in the background for next load.
      const baseCards = cardsFromResearch(research);
      await cacheTopics(ctx.pool, sub, baseCards, focus);
      res.json({ cards: baseCards, generatedAt: new Date().toISOString(), cached: false, enriched: false });
      enrichTopicCards(ctx.pool, sub, research, focus)
        .then((enriched) => { if (enriched) return cacheTopics(ctx.pool, sub, enriched, focus); })
        .catch((err) => logger.warn({ err, sub }, 'background topic enrichment failed'));
    } catch (err) {
      logger.error({ err }, 'topics failed');
      if (!res.headersSent) res.status(502).json({ error: (err as Error).message });
    }
  });

  /** POST /dismiss — hide an article from the feed. The row is RETAINED (dismissed=true)
   *  so the data is never lost; dismissing only means "I don't want to comment on it." */
  router.post('/dismiss', async (req, res) => {
    const sub = callerSub(req); if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const url = (req.body as { url?: string })?.url?.trim();
    if (!url) { res.status(400).json({ error: 'url required' }); return; }
    try {
      await ctx.pool.query(
        `INSERT INTO oshal_content_articles (user_sub, url, dismissed, dismissed_at) VALUES ($1,$2,true,now())
         ON CONFLICT (user_sub, url) DO UPDATE SET dismissed=true, dismissed_at=now()`, [sub, url]);
      // Drop it from the cached cards too, so it disappears immediately on the next load.
      const cached = (await ctx.pool.query('SELECT cards FROM oshal_content_topics WHERE user_sub=$1', [sub])).rows[0];
      if (cached?.cards) {
        const kept = (cached.cards as Array<Record<string, unknown>>).filter((c) => c.url !== url);
        await ctx.pool.query('UPDATE oshal_content_topics SET cards=$2 WHERE user_sub=$1', [sub, JSON.stringify(kept)]);
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'dismiss failed');
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** GET /articles — the retained article history (incl. dismissed), newest first.
   *  The raw material for cross-topic similarity/trend analysis later. */
  router.get('/articles', async (req, res) => {
    const sub = callerSub(req); if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    try {
      const rows = (await ctx.pool.query(
        `SELECT url, title, source, matched, score, published_at, first_seen, last_seen, dismissed, dismissed_at
         FROM oshal_content_articles WHERE user_sub=$1 ORDER BY last_seen DESC LIMIT $2`, [sub, limit])).rows;
      res.json({ count: rows.length, articles: rows });
    } catch (err) {
      logger.error({ err }, 'articles failed');
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** GET /related?url= — articles related to the given one (shared topics + title overlap)
   *  from the retained store. The "connect the dots" memory view. */
  router.get('/related', async (req, res) => {
    const sub = callerSub(req); if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const url = String(req.query.url || '').trim();
    if (!url) { res.status(400).json({ error: 'url required' }); return; }
    try {
      res.json({ related: await relatedArticles(ctx.pool, sub, url, 5) });
    } catch (err) {
      logger.error({ err }, 'related failed');
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** POST /draft — draft a post that SHARES + LINKS the picked article, led by the user's take. */
  router.post('/draft', async (req, res) => {
    const sub = callerSub(req); if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const body = req.body as { topic?: string; angle?: string; take?: string; tone?: string; url?: string; source?: string };
    const topic = body?.topic?.trim();
    const url = body?.url?.trim();
    if (!topic) { res.status(400).json({ error: 'topic required' }); return; }
    try {
      const prompt = [
        `You are my personal-branding communications assistant. Write a ${body.tone || 'professional, credible builder-voice'} LinkedIn post that shares this article to build MY professional brand and get my name in front of the right audience.`,
        `Article: ${topic}${body.source ? ` (${body.source})` : ''}`,
        url ? `Article link — you MUST include this exact URL once in the post: ${url}` : '',
        body.angle ? `Suggested angle: ${body.angle}` : '',
        body.take ? `MY take (LEAD with this — the post is my perspective, NOT a summary):\n${body.take}` :
          'I have no deep take — write a confident, scroll-stopping SHARE: a curiosity/value hook (e.g. "Here\'s what just landed for Q4 👇") that makes people want to click, then one credible line on why it matters. Light-touch is fine.',
        '',
        POST_BEST_PRACTICES,
        url ? 'Place the link where it earns the click — after the hook or near the end.' : '',
        'Output ONLY the post text — no preamble, no surrounding quotes, no "Here is".',
      ].filter(Boolean).join('\n');
      res.json({ draft: await runOnBot('draft', sub, prompt, ctx) });
    } catch (err) {
      logger.error({ err }, 'draft failed');
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** POST /draft-deep — RESEARCH-BACKED analysis draft. Bot proposes search queries →
   *  the news engine gathers real evidence → bot writes grounded ONLY in that evidence
   *  (no fabricated placements/metrics) and cites it. Slower (multi-step) by design. */
  router.post('/draft-deep', async (req, res) => {
    const sub = callerSub(req); if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const b = req.body as { topic?: string; take?: string; tone?: string; url?: string; source?: string };
    const topic = b?.topic?.trim();
    if (!topic) { res.status(400).json({ error: 'topic required' }); return; }
    try {
      const queries = await deepQueries(ctx.pool, sub, topic, b.take || '', b.source);
      const evidence = await gatherEvidence(queries);
      const draft = await deepDraft(ctx.pool, sub, topic, b.take || '', b.url?.trim(), b.source, evidence, b.tone);
      res.json({
        draft, queries,
        sources: evidence.map((e) => ({ title: e.title, source: e.source, url: e.url, date: e.date })),
      });
    } catch (err) {
      logger.error({ err }, 'draft-deep failed');
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** POST /refine — iteratively revise an existing draft with one instruction. */
  router.post('/refine', async (req, res) => {
    const sub = callerSub(req); if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const b = req.body as { draft?: string; instruction?: string; topic?: string; take?: string };
    const draft = b?.draft?.trim();
    const instruction = b?.instruction?.trim();
    if (!draft || !instruction) { res.status(400).json({ error: 'draft and instruction required' }); return; }
    try {
      const prompt = buildRefinePrompt(draft, instruction, b.topic, b.take);
      res.json({ draft: await runOnBot('refine', sub, prompt, ctx) });
    } catch (err) {
      logger.error({ err }, 'refine failed');
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** POST /drafts — save a draft. GET /drafts — list saved drafts. */
  router.post('/drafts', async (req, res) => {
    const sub = callerSub(req); if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const b = req.body as { topic?: string; take?: string; draft?: string };
    if (!b?.draft?.trim()) { res.status(400).json({ error: 'draft required' }); return; }
    await ctx.pool.query('INSERT INTO oshal_content_drafts (user_sub, topic, take, draft) VALUES ($1,$2,$3,$4)',
      [sub, b.topic || null, b.take || null, b.draft]);
    res.json({ ok: true });
  });
  router.get('/drafts', async (req, res) => {
    const sub = callerSub(req); if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const rows = (await ctx.pool.query(
      'SELECT id, topic, take, draft, created_at FROM oshal_content_drafts WHERE user_sub=$1 ORDER BY created_at DESC LIMIT 50', [sub])).rows;
    res.json({ drafts: rows });
  });

  return router;
}
