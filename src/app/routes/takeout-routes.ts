/**
 * Generic Google Takeout entry point. Browser uploads and Dropbox pickup share one selective
 * archive scanner, then dispatch each matched slice through the active package registry.
 *
 * The kernel owns authentication, Dropbox transport, archive safety, and aggregate reporting.
 * It contains no application names, archive paths, or package ingest imports. Active manifests
 * supply those details, and lifecycle teardown retracts them without a process restart.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | Add browser and Dropbox Takeout ingestion with aggregate outcomes.
 * 2   | maintainer@emeraldcoastsystemsgroup.com     | Remove the carved youtube-kids handler and literals from the kernel.
 * 3   | maintainer@emeraldcoastsystemsgroup.com     | Dispatch active manifest-contributed slices and return typed archive-size failures.
 *
 * @module takeout-routes
 */

import { Router, raw, type Request, type Response } from 'express';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import type { TakeoutSliceRuntime } from '../takeout-slice-registry';
import { getValidAccessToken } from './connectors-routes';
import {
  extractTakeoutSlicesFromBuffer,
  extractTakeoutSlicesFromFile,
  DuplicateTakeoutSliceError,
  TakeoutSliceTooLargeError,
  type TakeoutScan,
  type ExtractedSlice,
} from './takeout-ingest';

const logger = createChildLogger({ module: 'takeout-routes' });
const DBX = 'https://api.dropboxapi.com/2';
const DBX_CONTENT = 'https://content.dropboxapi.com/2';
/** Browser-upload cap. Large full-life archives should use the streamed Dropbox path. */
const MAX_ZIP = 200 * 1024 * 1024;
const DEFAULT_DROPBOX_ZIP_MAX = 10 * 1024 * 1024 * 1024;
const ABSOLUTE_DROPBOX_ZIP_MAX = 100 * 1024 * 1024 * 1024;

/** Typed compressed-archive cap for the disk-streamed Dropbox path. */
class TakeoutArchiveTooLargeError extends Error {
  readonly code = 'takeout_archive_too_large';

  constructor(readonly maxBytes: number) {
    super(`Takeout archive exceeds the configured ${maxBytes}-byte compressed limit`);
    this.name = 'TakeoutArchiveTooLargeError';
  }
}

/** Operator-owned disk budget, fail-safe on invalid values and bounded to 100 GiB. */
function dropboxArchiveLimit(): number {
  const configured = Number(process.env.OSHAL_TAKEOUT_DROPBOX_MAX_BYTES ?? DEFAULT_DROPBOX_ZIP_MAX);
  if (!Number.isSafeInteger(configured) || configured < 1) return DEFAULT_DROPBOX_ZIP_MAX;
  return Math.min(configured, ABSOLUTE_DROPBOX_ZIP_MAX);
}

/** Signed-in caller's OIDC sub. The router is also mounted behind requiresAuth. */
function callerSub(req: Request): string | null {
  const user = (req as { oidc?: { user?: { sub?: string } } }).oidc?.user;
  return user?.sub ? String(user.sub) : null;
}

/** One package handler's bounded public outcome. */
interface RoutedSlice {
  kind: string;
  label: string;
  app: string;
  ok: boolean;
  summary?: string;
  error?: string;
}

/** Dispatch one extracted slice without allowing one package failure to hide other outcomes. */
async function routeSlice(
  runtime: TakeoutSliceRuntime,
  sub: string,
  slice: ExtractedSlice,
): Promise<RoutedSlice> {
  try {
    const result = await runtime.ingest(sub, slice);
    return { kind: slice.kind, label: slice.label, app: slice.app, ok: true, ...result };
  } catch (err) {
    logger.error({ err, app: slice.app, kind: slice.kind, sub }, 'Package Takeout handler failed');
    const code = (err as Error & { code?: unknown }).code;
    return {
      kind: slice.kind,
      label: slice.label,
      app: slice.app,
      ok: false,
      error: typeof code === 'string' ? code : 'ingest_failed',
    };
  }
}

/** Route every extracted slice and preserve per-slice success/failure reporting. */
async function routeScan(
  runtime: TakeoutSliceRuntime,
  sub: string,
  scan: TakeoutScan,
): Promise<{ ingested: RoutedSlice[]; htmlHits: string[] }> {
  const ingested: RoutedSlice[] = [];
  for (const slice of scan.slices) ingested.push(await routeSlice(runtime, sub, slice));
  logger.info(
    { sub, found: scan.slices.length, ok: ingested.filter((result) => result.ok).length, htmlHits: scan.htmlHits.length },
    'Takeout scan routed',
  );
  return { ingested, htmlHits: scan.htmlHits };
}

/** A valid caller-owned Dropbox token, or null when Dropbox is not connected. */
async function dropboxToken(ctx: AppContext, sub: string): Promise<string | null> {
  return getValidAccessToken(ctx.pool, sub, 'dropbox');
}

/** Download a Dropbox file to a fresh temp path without buffering the whole archive. */
async function downloadDropboxToTemp(token: string, dropboxPath: string): Promise<string> {
  const response = await fetch(`${DBX_CONTENT}/files/download`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath }),
    },
  });
  if (!response.ok || !response.body) {
    throw new Error(
      `Dropbox download failed: ${response.status} ${(await response.text().catch(() => '')).slice(0, 160)}`,
    );
  }
  const maxBytes = dropboxArchiveLimit();
  const advertisedBytes = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertisedBytes) && advertisedBytes > maxBytes) {
    throw new TakeoutArchiveTooLargeError(maxBytes);
  }
  const tempPath = path.join(os.tmpdir(), `oshal-takeout-${crypto.randomUUID()}.zip`);
  let receivedBytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      receivedBytes += chunk.length;
      callback(receivedBytes > maxBytes ? new TakeoutArchiveTooLargeError(maxBytes) : null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      limiter,
      fs.createWriteStream(tempPath),
    );
    return tempPath;
  } catch (err) {
    await fs.promises.unlink(tempPath).catch(() => { /* best-effort partial-download cleanup */ });
    throw err;
  }
}

/** Common response for an archive with no slice owned by an active application. */
function sendNoKnownSlices(res: Response, result: { ingested: RoutedSlice[]; htmlHits: string[] }): void {
  res.status(422).json({
    error: 'no_known_slices',
    message: 'No active application recognized data in this archive. If an HTML match is listed, re-export that service in JSON format.',
    ...result,
  });
}

/**
 * @description Build the Takeout router. Mount it at `/api/takeout` behind `requiresAuth`.
 * Specs are read for each request so activation/deactivation takes effect without restart.
 */
export function createTakeoutRoutes(ctx: AppContext, runtime: TakeoutSliceRuntime): Router {
  const router = Router();

  /** Browser uploads the complete zip as a bounded raw request body. */
  router.post('/ingest-zip', raw({ type: '*/*', limit: MAX_ZIP }), async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) {
      res.status(401).json({ error: 'not_authenticated' });
      return;
    }
    const body = req.body as Buffer;
    if (!body?.length) {
      res.status(400).json({ error: 'empty_body' });
      return;
    }
    try {
      const specs = runtime.specs();
      if (specs.length === 0) {
        sendNoKnownSlices(res, { ingested: [], htmlHits: [] });
        return;
      }
      const scan = await extractTakeoutSlicesFromBuffer(body, specs);
      const result = await routeScan(runtime, sub, scan);
      if (scan.slices.length === 0) {
        sendNoKnownSlices(res, result);
        return;
      }
      res.json({ ok: true, ...result });
    } catch (err) {
      // Invalid/hostile caller archives are expected boundary refusals, not platform outages.
      logger.warn({ err }, 'Takeout browser archive refused');
      if (err instanceof TakeoutSliceTooLargeError || err instanceof TakeoutArchiveTooLargeError) {
        res.status(413).json({ error: err.code, message: err.message });
        return;
      }
      res.status(422).json({
        error: 'bad_archive',
        message: 'That archive is invalid, ambiguous, or could not be read safely.',
      });
    }
  });

  /** List zip candidates from the caller's connected Dropbox app-folder. */
  router.get('/dropbox/list', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) {
      res.status(401).json({ error: 'not_authenticated' });
      return;
    }
    try {
      const token = await dropboxToken(ctx, sub);
      if (!token) {
        res.status(409).json({ error: 'no_dropbox', message: 'Connect Dropbox at /utilities, then deliver your Takeout there.' });
        return;
      }
      const response = await fetch(`${DBX}/files/list_folder`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '', recursive: true, limit: 2000 }),
      });
      const payload = await response.json() as {
        entries?: Array<{
          '.tag': string;
          name: string;
          path_lower: string;
          size?: number;
          server_modified?: string;
        }>;
      };
      if (!response.ok) {
        res.status(502).json({ error: JSON.stringify(payload).slice(0, 200) });
        return;
      }
      const candidates = (payload.entries ?? [])
        .filter((entry) => entry['.tag'] === 'file' && /\.zip$/i.test(entry.name))
        .map((entry) => ({
          name: entry.name,
          path: entry.path_lower,
          size: entry.size,
          modified: entry.server_modified,
          looksLikeTakeout: /takeout/i.test(entry.name),
        }))
        .sort((left, right) => String(right.modified).localeCompare(String(left.modified)));
      res.json({ candidates });
    } catch (err) {
      logger.error({ err }, 'Takeout Dropbox list failed');
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** Download one caller-selected Dropbox zip to disk, then extract and route it. */
  router.post('/dropbox/pickup', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) {
      res.status(401).json({ error: 'not_authenticated' });
      return;
    }
    const dropboxPath = String((req.body as { path?: string })?.path ?? '').trim();
    if (!dropboxPath) {
      res.status(400).json({ error: 'path_required' });
      return;
    }
    let tempPath: string | null = null;
    try {
      const specs = runtime.specs();
      if (specs.length === 0) {
        sendNoKnownSlices(res, { ingested: [], htmlHits: [] });
        return;
      }
      const token = await dropboxToken(ctx, sub);
      if (!token) {
        res.status(409).json({ error: 'no_dropbox', message: 'Connect Dropbox at /utilities first.' });
        return;
      }
      tempPath = await downloadDropboxToTemp(token, dropboxPath);
      const scan = await extractTakeoutSlicesFromFile(tempPath, specs);
      const result = await routeScan(runtime, sub, scan);
      if (scan.slices.length === 0) {
        sendNoKnownSlices(res, result);
        return;
      }
      res.json({ ok: true, ...result });
    } catch (err) {
      const archiveFailure = tempPath !== null
        || err instanceof TakeoutSliceTooLargeError
        || err instanceof TakeoutArchiveTooLargeError
        || err instanceof DuplicateTakeoutSliceError;
      if (archiveFailure) {
        logger.warn({ err }, 'Takeout Dropbox archive refused');
      } else {
        logger.error({ err }, 'Takeout Dropbox pickup failed');
      }
      if (err instanceof TakeoutSliceTooLargeError || err instanceof TakeoutArchiveTooLargeError) {
        res.status(413).json({ error: err.code, message: err.message });
        return;
      }
      if (archiveFailure) {
        res.status(422).json({
          error: 'bad_archive',
          message: 'That archive is invalid, ambiguous, or could not be read safely.',
        });
        return;
      }
      res.status(502).json({ error: (err as Error).message });
    } finally {
      if (tempPath) fs.promises.unlink(tempPath).catch(() => { /* best-effort temp cleanup */ });
    }
  });

  return router;
}
