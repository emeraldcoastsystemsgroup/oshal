/**
 * Jarvis tool catalog — the auto tool-feed (what Jarvis can actually DO) + the image-deliverable
 * contract appended to image-shaped hand-offs.
 *
 * Extracted from jarvis-routes.ts (2026-07-18, ADR-050 route decomposition). Behaviour unchanged.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from jarvis-routes.ts: TOOL_CATALOG + buildToolsBlock (ADR-087 access-role-scoped auto tool-feed) + withImageDeliverableContract (route decomposition, no behaviour change).
 *
 * @module jarvis-tool-catalog
 */

import { roleCanAccess, type SwarmAccessRole } from '@/shared/types';
import type { HandoffDirective } from './jarvis-directives';

/** One tool-catalog entry: rich usage text + optional ADR-087 access-role scoping. */
interface ToolCatalogEntry {
  usage: string;
  /** Caller roles allowed to see/route to this CLI. Omit = every caller (the default).
   *  Declare without 'jarvis' to take a script out of the assistant's tool feed even
   *  though it exists on disk (the auto-feed otherwise surfaces every oshal-*.js). */
  accessRoles?: SwarmAccessRole[];
}

/** Internal/pipeline scoping shorthand: operator + swarm machinery only, never Jarvis. */
const INTERNAL: SwarmAccessRole[] = ['operator', 'swarm'];

/** Rich purpose+usage for the known CLIs (single source of truth). Anything in /app/scripts not listed
 *  here still gets auto-surfaced by name so a newly-added CLI is never invisible to Jarvis — list a
 *  script here with accessRoles that exclude 'jarvis' to deliberately hide it (ADR-087). */
const TOOL_CATALOG: Record<string, ToolCatalogEntry> = {
  'oshal-uber-rides.js': { usage: 'Uber RIDES — request/estimate a ride. `estimate "<pickup>" "<dropoff>"` · `ride "<pickup>" "<dropoff>" [type]`' },
  'oshal-uber.js': { usage: 'Uber EATS — restaurants & food delivery. `search "<food>"` · `menu "<storeId>"` · `order "<storeId>"`' },
  'oshal-walmart.js': { usage: 'Walmart shopping. `search "<item>"` · `deals` · `cart "<ITEMID_QTY,...>"`' },
  'oshal-weather.js': { usage: 'NWS severe-alert trading feed only (NOT a local forecast). Local forecasts belong to weather-bot / format-weather.' },
  'oshal-spotify.js': { usage: 'Spotify music. `search "<q>"` · `now-playing` · `playlists`' },
  'oshal-tmdb.js': { usage: 'Movies & TV. `search "<q>"` · `trending` · `where-to-watch <movie|tv> <id>`' },
  'oshal-smartthings.js': { usage: 'Smart home devices & scenes (run with no args for a digest).' },
  'oshal-gmail.js': { usage: 'Gmail — read/triage/draft email.' },
  'oshal-outlook.js': { usage: 'Outlook email.' },
  'oshal-plaid.js': { usage: 'Finance — banks/brokerages, balances/spend (read-only).' },
  'oshal-research.js': { usage: 'Web research. `"<topic>"`' },
  'oshal-gcp.js': { usage: 'Google Cloud inventory & ops.' },
  'oshal-x.js': { usage: 'Post to X (Twitter).' },
  'oshal-x-read.js': { usage: 'Read X (Twitter) — mentions/timeline.' },
  'oshal-linkedin.js': { usage: 'LinkedIn content.' },
  'oshal-duffel.js': { usage: 'Flights / travel search & booking links.' },
  'oshal-feeds.js': { usage: 'News feeds / world data.' },
  'oshal-trading.js': { usage: 'Trading / portfolio (paper).' },

  // ── ADR-087: internal machinery the auto-feed used to advertise to Jarvis by name.
  // These run under scheduled host tasks / owning bots, not the assistant; several actuate
  // for real (job applications, raw email send, alerts, live-trading ops, render pipeline).
  'oshal-apply.js': { usage: 'Job-application submitter (remote apply pipeline) — ACTUATES.', accessRoles: INTERNAL },
  'oshal-gmail-send.js': { usage: 'Raw Gmail sender (recap pipeline) — Jarvis drafts via oshal-gmail.js instead.', accessRoles: INTERNAL },
  'oshal-send-alert.js': { usage: 'Watchdog alert sender.', accessRoles: INTERNAL },
  'oshal-vault.js': { usage: 'DevOps Vault CLI (ADR-040 preview) — operator-gated.', accessRoles: INTERNAL },
  'oshal-vids.js': { usage: 'Creative Studio render-node pipeline (ADR-080).', accessRoles: INTERNAL },
  'oshal-tools-mcp.js': { usage: 'MCP tool bridge (internal plumbing).', accessRoles: INTERNAL },
  'oshal-trade-ops.js': { usage: 'Live trading ops (autopilot rails).', accessRoles: INTERNAL },
  'oshal-trade-recap.js': { usage: 'Daily trade recap pipeline stage.', accessRoles: INTERNAL },
  'oshal-trade-data.js': { usage: 'Daily trade recap data stage.', accessRoles: INTERNAL },
  'oshal-deck-data.js': { usage: 'Recap deck data (deck-data.json = truth).', accessRoles: INTERNAL },
  'oshal-recap-pipeline.js': { usage: 'Recap pipeline driver (5PM CT host task).', accessRoles: INTERNAL },
  'oshal-recap-email.js': { usage: 'Recap email stage.', accessRoles: INTERNAL },
  'oshal-recap-render-remote.js': { usage: 'Recap remote render stage.', accessRoles: INTERNAL },
  'oshal-recap-agent-remote.js': { usage: 'Recap remote agent stage.', accessRoles: INTERNAL },
  'oshal-backtest.js': { usage: 'Trading research — backtest engine.', accessRoles: INTERNAL },
  'oshal-backtest-live.js': { usage: 'Trading research — live-window backtest.', accessRoles: INTERNAL },
  'oshal-gravity.js': { usage: 'Trading research — gravity model.', accessRoles: INTERNAL },
  'oshal-bars.js': { usage: 'Trading research — bar data.', accessRoles: INTERNAL },
  'oshal-equity-bars.js': { usage: 'Trading research — equity bar data.', accessRoles: INTERNAL },
  'oshal-intraday.js': { usage: 'Trading research — intraday data.', accessRoles: INTERNAL },
  'oshal-algos.js': { usage: 'Trading research — algo library.', accessRoles: INTERNAL },
  'oshal-pick.js': { usage: 'Trading research — symbol picker.', accessRoles: INTERNAL },
  'oshal-monitor.js': { usage: 'Trading autopilot watchdog.', accessRoles: INTERNAL },
  'oshal-optimize.js': { usage: 'Trading research — optimizer.', accessRoles: INTERNAL },
  'oshal-signal-mine.js': { usage: 'Trading research — signal mining.', accessRoles: INTERNAL },
  'oshal-signal-label.js': { usage: 'Trading research — signal labeling.', accessRoles: INTERNAL },
};

/**
 * @description The AUTO TOOL-FEED: enumerates the mounted OSHAL CLIs (/app/scripts/oshal-*.js) every
 * turn and injects them so Jarvis knows what he can actually do. New CLIs auto-appear (listed by name
 * with a `--help` hint); known ones get rich usage from TOOL_CATALOG. This is why he must shell out to
 * the right tool instead of "searching" for something a tool already covers. ADR-087: catalog entries
 * whose accessRoles exclude 'jarvis' are dropped even when the script exists on disk — the assistant
 * neither sees them nor is told they are runnable.
 */
export function buildToolsBlock(): string {
  let files: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    files = require('fs').readdirSync('/app/scripts').filter((f: string) => /^oshal-.*\.js$/.test(f)).sort();
  } catch { /* fall back to the catalog */ }
  const names = (files.length ? files : Object.keys(TOOL_CATALOG))
    .filter((f) => roleCanAccess(TOOL_CATALOG[f]?.accessRoles, 'jarvis'));
  const lines = names.map((f) => TOOL_CATALOG[f]
    ? `- ${TOOL_CATALOG[f].usage}  → node /app/scripts/${f}`
    : `- ${f.replace(/^oshal-|\.js$/g, '')}: node /app/scripts/${f} --help`);
  return [
    'YOUR TOOLS — shell out to these (auto-scoped to the signed-in user via OSHAL_USER_SUB). For a',
    'request, RUN the matching tool (e.g. an Uber ride → oshal-uber-rides.js). Run a tool with no args',
    'or --help to learn its usage. NEVER "search the web" for something a tool here already covers.',
    'These are your ONLY tools — a script not listed here is off-limits even if you can see it.',
    ...lines,
  ].join('\n');
}

/** Detects handoffs whose deliverable is imagery the user expects to SEE, not just read about. */
const IMAGE_DELIVERABLE_REQUEST = /\b(?:images?|photos?|pictures?|screenshots?|galler(?:y|ies))\b/i;

/**
 * @description Appends the image-deliverable contract to an image-shaped handoff description.
 * Jarvis's trusted gallery pipeline receives only local, workspace-confined files — it never
 * fetches worker/model-authored remote URLs (security design). Workers that hot-link images
 * therefore silently produce no visual (Fort Smith 2026-07-15), and toolless bots that win the
 * call-out bid cannot download at all (they self-score against this description, ADR-083), so
 * the contract states both the required artifact shape and the required capability. Provider-bound
 * handoffs are excluded: their visuals are derived server-side from provider records, and their
 * workers must NOT download images (e.g. Walmart returns product-image references only).
 * @param h - The handoff directive about to become a queue ticket.
 * @returns The ticket description, with the contract appended only for image-shaped, non-provider handoffs.
 */
export function withImageDeliverableContract(h: HandoffDirective): string {
  if (h.providerIntent) return h.description;
  if (!IMAGE_DELIVERABLE_REQUEST.test(`${h.title}\n${h.description}`)) return h.description;
  return [
    h.description,
    '',
    'IMAGE DELIVERABLE CONTRACT — this task must produce image FILES the user will see:',
    '- Download the actual images into the ticket workspace `deliverables/assets/` directory (curl/wget).',
    '- Reference them by RELATIVE path (e.g. `![caption](assets/photo.jpg)`) from a Markdown file in `deliverables/`.',
    '- Link that Markdown file from your completion summary.',
    '- Remote/hot-linked image URLs are never displayed to the user and will be silently skipped.',
    '- This work requires shell access and outbound network to download files; a bot without those tools cannot complete it and should score itself low.',
  ].join('\n');
}
