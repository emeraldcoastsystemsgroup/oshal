/**
 * Takeout Routes — the platform entry point for ingesting a Google Takeout archive and
 * routing its known slices to the owning apps (ADR-038 storage; the spine Kid Lens sits on).
 *
 * Two sources, one pipeline (extract → route):
 *  - POST /ingest-zip   — the browser uploads the whole Takeout .zip (raw body).
 *  - POST /dropbox/pickup — OSHAL downloads a Takeout .zip the user delivered to (or dropped
 *    into) its connected Dropbox app-folder, streamed to a temp file so a multi-GB archive is
 *    never held whole in memory. GET /dropbox/list surfaces the candidates.
 *
 * Extraction is selective (takeout-ingest); routing dispatches each slice by `kind` to its
 * app's ingest function. No slices are registered today — the v1 youtube-watch-history
 * handler left with the youtube-kids carve (ADR-085); the packaged app accepts
 * watch-history.json directly on its own surface. Package-contributed slice registration
 * is framework roadmap. Nothing is dropped silently — the response reports what was
 * ingested, what was skipped, and any HTML-format slices that need a JSON re-export.
 *
 * Every route is requiresAuth-gated at mount (auth is opt-in per route, CLAUDE.md).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — POST /ingest-zip (browser), GET /dropbox/list + POST /dropbox/pickup (Dropbox app-folder), extract+route Takeout slices; v1 routes YouTube watch history to Kid Lens. Reports ingested/skipped/HTML-format, no silent drops.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 1 carve #2: youtube-kids carved to the store — removed the youtube-watch-history dispatch (and the youtube-kids-routes import). The spine stays app-agnostic core infra with zero registered slices until package-contributed slice registration lands.
 *
 * @module takeout-routes
 */

import { Router, raw, type Request, type Response } from 'express';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Readable } from 'stream';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { getValidAccessToken } from './connectors-routes';
import { extractTakeoutSlicesFromBuffer, extractTakeoutSlicesFromFile, type TakeoutScan, type ExtractedSlice } from './takeout-ingest';

const logger = createChildLogger({ module: 'takeout-routes' });
const DBX = 'https://api.dropboxapi.com/2';
const DBX_CONTENT = 'https://content.dropboxapi.com/2';
/** Browser-upload cap. A YouTube-only Takeout is small; for a full-life archive use Dropbox pickup. */
const MAX_ZIP = 200 * 1024 * 1024;

/** Signed-in caller's OIDC sub. */
function callerSub(req: Request): string | null {
  const u = (req as { oidc?: { user?: { sub?: string } } }).oidc?.user;
  return u?.sub ? String(u.sub) : null;
}

/** One slice's routing outcome, surfaced to the user. */
interface RoutedSlice { kind: string; label: string; app: string; ok: boolean; summary?: string; error?: string; }

/** Dispatch one extracted slice to its owning app's ingest function. No handlers are
 *  registered today (the youtube-watch-history one left with the youtube-kids carve);
 *  every slice reports no_handler until package-contributed registration lands. */
async function routeSlice(_pool: AppContext['pool'], _sub: string, slice: ExtractedSlice): Promise<RoutedSlice> {
  return { kind: slice.kind, label: slice.label, app: slice.app, ok: false, error: 'no_handler' };
}

/** Route every slice in a scan and assemble the user-facing result body. */
async function routeScan(pool: AppContext['pool'], sub: string, scan: TakeoutScan): Promise<{ ingested: RoutedSlice[]; htmlHits: string[] }> {
  const ingested: RoutedSlice[] = [];
  for (const slice of scan.slices) ingested.push(await routeSlice(pool, sub, slice));
  logger.info({ sub, found: scan.slices.length, ok: ingested.filter((r) => r.ok).length, htmlHits: scan.htmlHits.length }, 'takeout scan routed');
  return { ingested, htmlHits: scan.htmlHits };
}

/** A valid Dropbox token for the caller, or null when Dropbox isn't connected. */
async function dropboxToken(ctx: AppContext, sub: string): Promise<string | null> {
  return getValidAccessToken(ctx.pool, sub, 'dropbox');
}

/** Download a Dropbox file (streamed) to a fresh temp path; returns the path. */
async function downloadDropboxToTemp(token: string, dropboxPath: string): Promise<string> {
  const r = await fetch(`${DBX_CONTENT}/files/download`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath }) },
  });
  if (!r.ok || !r.body) throw new Error(`dropbox download failed: ${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`);
  const tmp = path.join(os.tmpdir(), `oshal-takeout-${crypto.randomUUID()}.zip`);
  await new Promise<void>((resolve, reject) => {
    const ws = fs.createWriteStream(tmp);
    Readable.fromWeb(r.body as Parameters<typeof Readable.fromWeb>[0]).pipe(ws).on('finish', () => resolve()).on('error', reject);
  });
  return tmp;
}

/**
 * @description Builds the Takeout ingestion router (mount at /api/takeout behind requiresAuth).
 * @param ctx - App context (Postgres pool + Dropbox connector token).
 * @returns Express router.
 */
export function createTakeoutRoutes(ctx: AppContext): Router {
  const router = Router();

  /** POST /ingest-zip — browser uploads the whole Takeout .zip (raw body). */
  router.post('/ingest-zip', raw({ type: '*/*', limit: MAX_ZIP }), async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const body = req.body as Buffer;
    if (!body || !body.length) { res.status(400).json({ error: 'empty body' }); return; }
    try {
      const scan = await extractTakeoutSlicesFromBuffer(body);
      const result = await routeScan(ctx.pool, sub, scan);
      if (!scan.slices.length) { res.status(422).json({ error: 'no_known_slices', message: 'No recognized Takeout data found. This needs the YouTube watch-history.json (export YouTube history as JSON).', ...result }); return; }
      res.json({ ok: true, ...result });
    } catch (err) {
      logger.error({ err }, 'takeout ingest-zip failed');
      res.status(422).json({ error: 'bad_archive', message: 'That did not look like a valid Takeout .zip. Upload the .zip Google gave you (or the watch-history.json directly).' });
    }
  });

  /** GET /dropbox/list — Takeout .zip candidates in the caller's connected Dropbox app-folder. */
  router.get('/dropbox/list', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    try {
      const tok = await dropboxToken(ctx, sub);
      if (!tok) { res.status(409).json({ error: 'no_dropbox', message: 'Connect Dropbox at /utilities, then deliver your Takeout there.' }); return; }
      const r = await fetch(`${DBX}/files/list_folder`, {
        method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '', recursive: true, limit: 2000 }),
      });
      const j = await r.json() as { entries?: Array<{ '.tag': string; name: string; path_lower: string; size?: number; server_modified?: string }> };
      if (!r.ok) { res.status(502).json({ error: JSON.stringify(j).slice(0, 200) }); return; }
      const zips = (j.entries || [])
        .filter((e) => e['.tag'] === 'file' && /\.zip$/i.test(e.name))
        .map((e) => ({ name: e.name, path: e.path_lower, size: e.size, modified: e.server_modified, looksLikeTakeout: /takeout/i.test(e.name) }))
        .sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
      res.json({ candidates: zips });
    } catch (err) {
      logger.error({ err }, 'takeout dropbox list failed');
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** POST /dropbox/pickup {path} — download a Takeout .zip from Dropbox, extract + route it. */
  router.post('/dropbox/pickup', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const dropboxPath = String((req.body as { path?: string })?.path || '').trim();
    if (!dropboxPath) { res.status(400).json({ error: 'path required' }); return; }
    let tmp: string | null = null;
    try {
      const tok = await dropboxToken(ctx, sub);
      if (!tok) { res.status(409).json({ error: 'no_dropbox', message: 'Connect Dropbox at /utilities first.' }); return; }
      tmp = await downloadDropboxToTemp(tok, dropboxPath);
      const scan = await extractTakeoutSlicesFromFile(tmp);
      const result = await routeScan(ctx.pool, sub, scan);
      if (!scan.slices.length) { res.status(422).json({ error: 'no_known_slices', message: 'That archive had no recognized Takeout data (need the YouTube watch-history.json in JSON format).', ...result }); return; }
      res.json({ ok: true, ...result });
    } catch (err) {
      logger.error({ err }, 'takeout dropbox pickup failed');
      res.status(502).json({ error: (err as Error).message });
    } finally {
      if (tmp) fs.promises.unlink(tmp).catch(() => { /* best-effort temp cleanup */ });
    }
  });

  return router;
}
