/**
 * Files Routes — per-user file space, backed by the user's OWN Dropbox.
 *
 * Per ADR-038's storage principle, OSHAL prefers connecting to storage the user already
 * owns over hoarding files. This surface lists / uploads / downloads / deletes files in the
 * caller's connected Dropbox (an app-folder sandbox), using the per-user connector token via
 * getValidAccessToken('dropbox') — so quota is the user's own Dropbox plan, not an OSHAL
 * burden, and isolation is the same per-user model as the connector tokens.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — GET /files (surface), GET /files/list, POST /files/upload (raw body, ?name=), GET /files/download (?path=), DELETE /files (?path=). Dropbox-backed via the per-user connector token; 409 when Dropbox isn't connected.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Unified file browser — GET /roots, GET /browse (drill-down folders/files), GET /preview (inline text/image), provider-aware GET /download across Dropbox/GitHub/OSHAL-local (via storage-browse). Upload now takes an optional ?dir= so it lands in the open Dropbox folder.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-139 Stage 2: POST /upload also accepts provider=oshal-local (uploadBytes grew the branch) — the always-present local store no longer needs a connector to receive a file.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-139 fix: callerSub resolves the trusted service-rail identity first (getTrustedServiceUserSub) — the artifact-handle relay redeems files-browser sources by re-fetching /download as the minting caller over that rail, and the session-only resolution 401'd it (found live; the mount widened to serviceSecretOr in the same change).
 *
 * @module files-routes
 */
import { Router, raw, type Request, type Response } from 'express';
import * as path from 'path';
import { createChildLogger } from '@/shared/logger';
import { getTrustedServiceUserSub } from '@/shared/middleware/authz';
import type { AppContext } from '@/app/composition/app-context';
import { getValidAccessToken } from './connectors-routes';
import { listRoots, browse, readBytes, previewFile, uploadBytes, deleteEntry, type StorageProvider } from './storage-browse';

/** Providers the browser endpoints accept. */
const PROVIDERS = new Set<StorageProvider>(['dropbox', 'google-drive', 'github', 'oshal-local', 'career']);

const logger = createChildLogger({ module: 'files-routes' });
const DBX = 'https://api.dropboxapi.com/2';
const DBX_CONTENT = 'https://content.dropboxapi.com/2';
const MAX_UPLOAD = 25 * 1024 * 1024; // 25 MB/file (MVP; chunked upload is future work)

/** Signed-in caller's OIDC sub, or the trusted sub from an internal service-secret call —
 *  the same precedence every app surface uses. The ADR-139 handle relay redeems files-browser
 *  artifacts over the internal rail, so the trusted identity must resolve here. */
function callerSub(req: Request): string | null {
  const trusted = getTrustedServiceUserSub(req);
  if (trusted) return trusted;
  const u = (req as { oidc?: { user?: { sub?: string } } }).oidc?.user;
  return u?.sub ? String(u.sub) : null;
}

/** A valid Dropbox access token for the caller (refreshed as needed), or null if not connected. */
async function dropboxToken(ctx: AppContext, sub: string): Promise<string | null> {
  return getValidAccessToken(ctx.pool, sub, 'dropbox');
}

/** 409 helper when Dropbox isn't linked. */
function needDropbox(res: Response): void {
  res.status(409).json({ error: 'no_dropbox', message: 'Connect Dropbox at /utilities to use your file space.' });
}

/**
 * @description Builds the per-user file-space router (mount at /api/files, requiresAuth).
 * @param ctx - app context (db pool for the connector token).
 * @param apiDir - directory holding the HTML surface.
 * @returns Express router.
 */
export function createFilesRoutes(ctx: AppContext, apiDir: string): Router {
  const router = Router();

  /** GET / — the file-browser surface. */
  router.get('/', (_req: Request, res: Response) => {
    res.sendFile(path.join(apiDir, 'files.html'), (err) => {
      if (err) { logger.error({ err }, 'serve files surface failed'); res.status(404).send('Page not found'); }
    });
  });

  /** GET /list — list the caller's files (Dropbox app-folder root). */
  router.get('/list', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    try {
      const tok = await dropboxToken(ctx, sub);
      if (!tok) { needDropbox(res); return; }
      const r = await fetch(`${DBX}/files/list_folder`, {
        method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '', recursive: false }),
      });
      const j = (await r.json()) as { entries?: Array<Record<string, any>> };
      if (!r.ok) { res.status(502).json({ error: JSON.stringify(j).slice(0, 300) }); return; }
      res.json({ files: (j.entries || []).map((e) => ({
        name: e.name, path: e.path_lower, type: e['.tag'], size: e.size ?? null, modified: e.client_modified ?? null,
      })) });
    } catch (err) {
      logger.error({ err }, 'files list failed');
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** GET /roots — the storage sources the caller can browse (oshal-local always; dropbox/github if connected). */
  router.get('/roots', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    try {
      res.json({ roots: await listRoots(ctx, sub) });
    } catch (err) {
      logger.error({ err }, 'files roots failed');
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** GET /browse?provider=<p>&path=<rel> — list folders + files at a path in one provider (drill-down). */
  router.get('/browse', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const provider = String(req.query.provider || '') as StorageProvider;
    if (!PROVIDERS.has(provider)) { res.status(400).json({ error: 'provider query param required (dropbox|google-drive|github|oshal-local)' }); return; }
    try {
      res.json({ provider, path: String(req.query.path || ''), entries: await browse(ctx, sub, provider, String(req.query.path || '')) });
    } catch (err) {
      logger.error({ err, provider }, 'files browse failed');
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** GET /preview?provider=<p>&path=<rel>&size=<n> — inline-previewable form of a file (text / image / none). */
  router.get('/preview', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const provider = String(req.query.provider || '') as StorageProvider;
    const pth = String(req.query.path || '');
    if (!PROVIDERS.has(provider) || !pth) { res.status(400).json({ error: 'provider and path query params required' }); return; }
    const sizeHint = req.query.size ? Number(req.query.size) : undefined;
    try {
      res.json(await previewFile(ctx, sub, provider, pth, Number.isFinite(sizeHint as number) ? sizeHint : undefined));
    } catch (err) {
      logger.error({ err, provider }, 'files preview failed');
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** POST /upload?name=<file>&dir=<folder>&provider=<dropbox|google-drive> — upload a file (raw body). */
  router.post('/upload', raw({ type: '*/*', limit: MAX_UPLOAD }), async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const name = String(req.query.name || '').replace(/[^\w.\- ]/g, '_').slice(0, 120);
    if (!name) { res.status(400).json({ error: 'name query param required' }); return; }
    const provider = String(req.query.provider || 'dropbox') as StorageProvider;
    if (provider !== 'dropbox' && provider !== 'google-drive' && provider !== 'oshal-local') { res.status(400).json({ error: 'upload supports oshal-local, dropbox, or google-drive' }); return; }
    const dir = String(req.query.dir || '').replace(/^\/+|\/+$/g, '');
    const body = req.body as Buffer;
    if (!body || !body.length) { res.status(400).json({ error: 'empty body' }); return; }
    try {
      const saved = await uploadBytes(ctx, sub, provider, dir, name, body, String(req.headers['content-type'] || 'application/octet-stream'));
      res.json(saved);
    } catch (err) {
      logger.error({ err, provider }, 'files upload failed');
      const msg = (err as Error).message;
      res.status(msg.includes('not connected') ? 409 : 502).json({ error: msg });
    }
  });

  /**
   * GET /download?provider=<p>&path=<path> — stream a file from any storage provider.
   * `provider` defaults to dropbox so existing saveContent() download links keep working.
   */
  router.get('/download', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const pth = String(req.query.path || '');
    if (!pth) { res.status(400).json({ error: 'path query param required' }); return; }
    const provider = (String(req.query.provider || 'dropbox')) as StorageProvider;
    if (!PROVIDERS.has(provider)) { res.status(400).json({ error: 'invalid provider' }); return; }
    try {
      const { name, buf } = await readBytes(ctx, sub, provider, pth);
      res.setHeader('Content-Disposition', `attachment; filename="${name || path.basename(pth)}"`);
      res.send(buf);
    } catch (err) {
      logger.error({ err, provider }, 'files download failed');
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** DELETE /?provider=<dropbox|google-drive>&path=<path> — delete a file from a writable provider. */
  router.delete('/', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const pth = String(req.query.path || '');
    if (!pth) { res.status(400).json({ error: 'path query param required' }); return; }
    const provider = String(req.query.provider || 'dropbox') as StorageProvider;
    if (provider !== 'dropbox' && provider !== 'google-drive') { res.status(400).json({ error: 'delete supports dropbox or google-drive' }); return; }
    try {
      await deleteEntry(ctx, sub, provider, pth);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err, provider }, 'files delete failed');
      const msg = (err as Error).message;
      res.status(msg.includes('not connected') ? 409 : 502).json({ error: msg });
    }
  });

  return router;
}
