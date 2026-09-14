/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-139 source discovery and connected-storage adapter for the shared picker. Listings retain caller identity; app endpoints are read by the browser's session.
 */
import { Router, type Request } from 'express';
import * as path from 'node:path';
import type { AppContext } from '@/app/composition/app-context';
import { getCaller } from '@/shared/middleware/authz';
import { registeredArtifactActionApps, isValidArtifactTypeGlob, matchesArtifactType } from '@/shared/artifact-exchange';
import { listRoots, browse, mimeFor, type StorageProvider } from './storage-browse';

/** @description Resolve only active apps visible and readable by this request's caller. */
export type PickerVisibleApps = (req: Request) => Promise<Map<string, string>>;

/** @description Encode provider navigation without exposing filesystem paths or credentials. */
function cursorFor(provider: string, folder: string, offset = 0): string {
  return Buffer.from(JSON.stringify({ provider, folder, offset })).toString('base64url');
}

/** @description Whether two valid MIME globs overlap. */
function overlaps(left: string, right: string): boolean {
  return matchesArtifactType(left, right) || matchesArtifactType(right, left);
}

/** @description Add source discovery and the owner-scoped storage listing adapter. */
export function createArtifactPickerRoutes(ctx: AppContext, visibleApps?: PickerVisibleApps): Router {
  const router = Router();
  router.get('/sources', async (req, res) => {
    const { sub } = getCaller(req);
    if (!sub) { res.status(401).json({ error: 'Sign in to choose a file.' }); return; }
    const type = String(req.query.type || '*/*');
    if (!isValidArtifactTypeGlob(type)) { res.status(400).json({ error: 'Invalid file type.' }); return; }
    try {
      const visible = visibleApps ? await visibleApps(req) : new Map<string, string>();
      visible.set('kernel-storage', 'Connected files');
      const sources: Array<{ id: string; app: string; label: string; types: string[]; list: string }> = [];
      for (const [app, declarations] of registeredArtifactActionApps()) {
        if (!visible.has(app)) continue;
        declarations.provides.forEach((source, index) => {
          if (source.list && source.types.some(glob => overlaps(glob, type))) {
            sources.push({ id: `${app}:${index}`, app, label: source.label || visible.get(app) || app, types: source.types, list: source.list });
          }
        });
      }
      sources.sort((a, b) => a.app === 'kernel-storage' ? -1 : b.app === 'kernel-storage' ? 1 : a.label.localeCompare(b.label));
      res.set('Cache-Control', 'private, no-store').json({ sources });
    } catch {
      res.status(503).json({ error: 'File sources are temporarily unavailable. Try again.' });
    }
  });

  router.get('/storage', async (req, res) => {
    const { sub } = getCaller(req);
    if (!sub) { res.status(401).json({ error: 'Sign in to choose a file.' }); return; }
    const raw = String(req.query.cursor || '');
    let navigation: { provider: string; folder: string; offset: number } | undefined;
    if (raw) {
      try {
        if (raw.length > 4096 || !/^[\w-]+$/.test(raw)) throw new Error('cursor');
        navigation = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
        if (!navigation || typeof navigation.provider !== 'string' || typeof navigation.folder !== 'string'
          || navigation.folder.length > 1500 || !Number.isSafeInteger(navigation.offset) || navigation.offset < 0) throw new Error('cursor');
      } catch { res.status(400).json({ error: 'Invalid folder selection.' }); return; }
    }
    try {
      const roots = await listRoots(ctx, sub);
      res.set('Cache-Control', 'private, no-store');
      if (!navigation) {
        res.json({ items: [], folders: roots.map(root => ({ name: root.label, cursor: cursorFor(root.provider, '') })) });
        return;
      }
      if (!roots.some(root => root.provider === navigation.provider)) { res.status(404).json({ error: 'Storage is not connected.' }); return; }
      const { provider, folder, offset } = navigation;
      const entries = await browse(ctx, sub, provider as StorageProvider, folder);
      const page = entries.slice(offset, offset + 100);
      res.json({
        folders: page.filter(entry => entry.type === 'folder').map(entry => ({ name: entry.name, cursor: cursorFor(provider, entry.path) })),
        items: page.filter(entry => entry.type === 'file').map(entry => ({
          name: entry.name, type: mimeFor(entry.name), size: entry.size,
          source: `/api/files/download?provider=${encodeURIComponent(provider)}&path=${encodeURIComponent(entry.path)}`,
        })),
        nextCursor: offset + 100 < entries.length ? cursorFor(provider, folder, offset + 100) : null,
        emptyMessage: provider === 'google-drive' ? 'No files visible here. Google Drive may only expose files shared with this application.' : 'No files in this folder.',
      });
    } catch {
      res.status(502).json({ error: 'Could not read these files. Check the connection and try again.' });
    }
  });

  for (const file of ['picker.js', 'picker.css']) {
    router.get(`/${file}`, (_req, res) => {
      res.sendFile(path.resolve(process.cwd(), 'src/pages/cockpit/js/components/artifact-' + file), err => {
        if (err && !res.headersSent) res.status(404).end();
      });
    });
  }
  return router;
}
