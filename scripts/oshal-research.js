#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Content swarm research tool (ADR-038 / LinkedIn content assistant). Replaces the dead Google Search MCP: pulls live tech/AI feeds from keyless JSON APIs (Hacker News via Algolia, Reddit, Lobsters) + a few RSS feeds (lightweight parse), filters + scores by focus topics, dedupes, and emits ranked candidates as JSON. No API keys, no new deps.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add Google News RSS search keyed by the user's OWN focus terms (keyless). The previous sources (HN/Lobsters/AI blogs) only ever carried tech/AI content, so a focus like "ERP"/"fintech" returned nothing — we were filtering an AI firehose for a word that never appears, instead of actually searching news. On-topic news search hits get a relevance bonus so they aren't buried under high-engagement generic AI items.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Broaden the source stream from 3 AI blogs to 10 liveness-checked publisher feeds (Yahoo Finance, Fox News, CNBC Tech, WSJ Tech, TechCrunch, VentureBeat AI, Ars Technica, Verge AI, Simon Willison, HN). Real news volume, not just a hacker-news mirror. Twitter/X hashtag streaming intentionally NOT added — X's free API is gone and Nitter mirrors are unreliable; revisit via the connected account's own timeline if needed.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Replace Google News search with Bing News RSS. Google News links point at news.google.com (opaque token + client-side redirect) which the browser blocks from loading in a frame (ERR_BLOCKED_BY_RESPONSE) — articles wouldn't open. Bing's RSS link is an apiclick redirect carrying the REAL publisher URL in its url= param, so we resolve to the actual article (forbes.com, bleepingcomputer.com, …). Drop any item we can't resolve to a real publisher URL.
 *
 *   node scripts/oshal-research.js                          # default focus
 *   CONTENT_FOCUS="AI agents,RAG,MCP" node scripts/...      # custom focus terms
 *   CONTENT_LIMIT=15 node scripts/...                       # cap candidates
 */
'use strict';

const FOCUS = (process.env.CONTENT_FOCUS ||
  'AI,agents,agentic,LLM,language model,automation,OpenAI,Anthropic,Claude,GPT,multi-agent,' +
  'coding agent,developer tools,devtools,enterprise AI,RAG,fine-tuning,inference,MCP,' +
  'model context protocol,prompt,vector,embeddings,AI security,AI safety,open source AI,swarm')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const UA = 'OSHAL-research/1.0 (+https://oshal.example.com)';

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.text();
}

function ageHours(iso) { const t = Date.parse(iso); return t ? (Date.now() - t) / 3.6e6 : 9999; }
/** Match focus terms. Short terms (<=4 chars like ai/llm/rag/mcp/gpt) need a word
 *  boundary so "Pichai"/"again"/"detail" don't false-match "ai". */
function matched(text) {
  const t = String(text || '').toLowerCase();
  return FOCUS.filter((f) => {
    if (f.length <= 4) return new RegExp(`\\b${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t);
    return t.includes(f);
  });
}

/** Hacker News front-page-ish recent stories (Algolia API). */
async function hackerNews() {
  const out = [];
  try {
    const d = await getJson('https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=points%3E15&hitsPerPage=50');
    for (const h of d.hits || []) {
      const m = matched(`${h.title || ''} ${h.story_text || ''}`);
      if (!m.length) continue;
      out.push({
        source: 'Hacker News', title: h.title,
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        points: h.points || 0, comments: h.num_comments || 0, createdAt: h.created_at,
        matched: m, discussion: `https://news.ycombinator.com/item?id=${h.objectID}`,
      });
    }
  } catch { /* skip source */ }
  return out;
}

/** Reddit hot posts in tech/AI subreddits. */
async function reddit() {
  const subs = ['MachineLearning', 'artificial', 'LocalLLaMA', 'OpenAI', 'singularity', 'programming', 'technology'];
  const out = [];
  for (const s of subs) {
    try {
      const d = await getJson(`https://www.reddit.com/r/${s}/hot.json?limit=15`);
      for (const c of d.data?.children || []) {
        const p = c.data; if (!p || p.stickied) continue;
        const m = matched(`${p.title || ''} ${p.selftext || ''}`);
        if (!m.length) continue;
        out.push({
          source: `r/${s}`, title: p.title, url: p.url,
          points: p.score || 0, comments: p.num_comments || 0,
          createdAt: new Date((p.created_utc || 0) * 1000).toISOString(),
          matched: m, discussion: `https://www.reddit.com${p.permalink}`,
        });
      }
    } catch { /* skip sub */ }
  }
  return out;
}

/** Decode the few XML/HTML entities that appear in feed titles/links. */
function unescapeXml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Real news search via Bing News RSS (keyless). Queries the user's OWN focus
 *  terms — what makes "ERP"/"fintech" actually return articles. Bing's RSS
 *  link is an apiclick redirect with the REAL publisher URL in its `url=` param,
 *  so we resolve to the actual article (forbes.com, …) — unlike Google News,
 *  whose links point at news.google.com and are blocked from loading in a frame. */
async function bingNews() {
  const terms = FOCUS.filter((f) => f.length >= 2 && f !== 'news' && f !== 'latest').slice(0, 6);
  const out = [];
  for (const term of terms) {
    try {
      const xml = await getText(`https://www.bing.com/news/search?q=${encodeURIComponent(term)}&format=RSS&setlang=en-US`);
      for (const b of xml.split(/<item\b/).slice(1, 11)) {
        const pick = (re) => { const m = b.match(re); return m ? (m[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim() : ''; };
        const title = unescapeXml(pick(/<title[^>]*>([\s\S]*?)<\/title>/i));
        if (!title) continue;
        let link = unescapeXml(pick(/<link[^>]*>([\s\S]*?)<\/link>/i));
        const m = link.match(/[?&]url=([^&]+)/i);
        if (m) { try { link = decodeURIComponent(m[1]); } catch { /* keep raw */ } }
        // Drop anything we couldn't resolve to a real publisher URL (never link to bing/google).
        if (!/^https?:\/\//.test(link) || /(^|\.)(bing|google)\.com\//.test(link)) continue;
        let source = 'news';
        try { source = new URL(link).hostname.replace(/^www\./, ''); } catch { /* keep */ }
        const date = pick(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
        out.push({
          source, title, url: link,
          points: 0, comments: 0, createdAt: date || new Date().toISOString(),
          matched: [term], discussion: link, fromSearch: true,
        });
      }
    } catch { /* skip term */ }
  }
  return out;
}

/** Lobste.rs tagged stories. */
async function lobsters() {
  const out = [];
  for (const tag of ['ai', 'ml', 'programming']) {
    try {
      const d = await getJson(`https://lobste.rs/t/${tag}.json`);
      for (const p of (Array.isArray(d) ? d : []).slice(0, 15)) {
        const m = matched(p.title);
        if (!m.length) continue;
        out.push({
          source: 'Lobsters', title: p.title, url: p.url,
          points: p.score || 0, comments: p.comment_count || 0, createdAt: p.created_at,
          matched: m, discussion: p.comments_url,
        });
      }
    } catch { /* skip tag */ }
  }
  return out;
}

/** Curated publisher RSS/Atom feeds — a real, broad news stream (all liveness-checked).
 *  These are general feeds filtered by the user's focus terms, so a fintech focus
 *  pulls any finance/tech item mentioning their topics. Override with CONTENT_RSS.
 *  Node's fetch follows the publishers' redirects automatically. */
const RSS = (process.env.CONTENT_RSS || [
  'https://finance.yahoo.com/news/rssindex',                 // Yahoo Finance
  'https://moxie.foxnews.com/google-publisher/latest.xml',   // Fox News latest
  'https://www.cnbc.com/id/100003114/device/rss/rss.html',   // CNBC Technology
  'https://feeds.a.dj.com/rss/RSSWSJD.xml',                  // WSJ Tech
  'https://techcrunch.com/feed/',                            // TechCrunch
  'https://venturebeat.com/category/ai/feed/',               // VentureBeat AI
  'http://feeds.arstechnica.com/arstechnica/index',          // Ars Technica
  'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', // The Verge AI
  'https://simonwillison.net/atom/everything/',              // Simon Willison (AI/dev)
  'https://hnrss.org/newest?q=AI+agents&points=30',          // HN AI-agents firehose
].join(',')).split(',').map((s) => s.trim()).filter(Boolean);

function parseRss(xml, source) {
  const items = [];
  for (const b of xml.split(/<(?:item|entry)\b/).slice(1, 25)) {
    const pick = (re) => { const m = b.match(re); return m ? (m[1] || m[2] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim() : ''; };
    const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const link = pick(/<link[^>]*href=["']([^"']+)["']/i) || pick(/<link[^>]*>([\s\S]*?)<\/link>/i);
    const date = pick(/<(?:pubDate|updated|published)[^>]*>([\s\S]*?)<\/(?:pubDate|updated|published)>/i);
    if (!title) continue;
    const m = matched(title);
    if (!m.length) continue;
    items.push({ source, title, url: link, points: 0, comments: 0, createdAt: date || new Date().toISOString(), matched: m, discussion: link });
  }
  return items;
}
async function rssFeeds() {
  const out = [];
  for (const url of RSS) {
    try { out.push(...parseRss(await getText(url), new URL(url).hostname.replace(/^www\./, ''))); } catch { /* skip feed */ }
  }
  return out;
}

/** Score 0-100: recency (decays over a week) + engagement + focus match.
 *  A direct news search hit for the user's own focus term gets a relevance
 *  bonus so on-topic news isn't buried under high-engagement generic AI items. */
function score(item) {
  const recency = Math.max(0, 1 - ageHours(item.createdAt) / 168);
  const engagement = Math.min(1, (item.points + item.comments * 2) / 300);
  const focus = Math.min(1, item.matched.length / 3);
  const searchBonus = item.fromSearch ? 0.3 : 0;
  return Math.round(Math.min(1, recency * 0.4 + engagement * 0.35 + focus * 0.25 + searchBonus) * 100);
}

(async () => {
  const all = (await Promise.all([bingNews(), hackerNews(), reddit(), lobsters(), rssFeeds()])).flat();
  const seen = new Set();
  const deduped = [];
  for (const it of all) {
    const k = String(it.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    it.score = score(it);
    it.ageHours = Math.round(ageHours(it.createdAt));
    deduped.push(it);
  }
  deduped.sort((a, b) => b.score - a.score);
  const top = deduped.slice(0, Number(process.env.CONTENT_LIMIT) || 25);
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), focusCount: FOCUS.length, count: top.length, candidates: top }, null, 2));
})().catch((e) => { console.error('oshal-research failed: ' + (e && e.message || e)); process.exit(1); });
