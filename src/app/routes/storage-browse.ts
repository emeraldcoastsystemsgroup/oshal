/**
 * Storage Browse — one read-only file-system view across ALL of a user's storage backends.
 *
 * The "My Files" surface used to show a flat list of one backend (Dropbox root). This module
 * unifies the storage providers a user can connect (Dropbox, Google Drive, GitHub,
 * OSHAL-local) behind
 * a single tree model so the surface can drill down folders and preview a selected file from
 * any of them:
 *   - listRoots()  → the providers the caller can browse (oshal-local always; dropbox/github if connected)
 *   - browse()     → folders + files at a path within a provider (GitHub's first path segment is the repo)
 *   - readBytes()  → raw bytes of a file (download)
 *   - previewFile()→ inline-previewable form of a file (text / base64 image / none) under a size cap
 * All access uses the caller's OWN per-user connector token (getValidAccessToken) — same isolation
 * model as storage-target.ts. This is data-access only (no reasoning), so it lives in the route layer.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — cross-provider browse model (roots/browse/readBytes/previewFile) over Dropbox, GitHub repos+contents, and the OSHAL-local per-user dir, for the unified file browser with drill-down + preview.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add the 'career' root — the caller's OWN career-hunter store (generated résumé/cover packets under applications/, uploaded artifacts under uploads/, and the migrated lessons library under career-library/) so job-hunt artifacts are browsable/downloadable in Files ("artifacts in the user's folder system"). Read-only, sub-scoped, traversal-guarded; the store is on the api-output volume keyed by RAW sub (not the sha256 userfiles key).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Resolve Career stores through the installed app's exact-subject mapper and reject traversal or symlink escapes in both local file providers.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-139 Stage 2: uploadBytes gains the oshal-local branch (safeLocalPath-guarded write into the caller's always-present local store) — the "Save to OSHAL Storage" built-in's backend, and connector-free upload for the files surface.
 *
 * @module storage-browse
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { resolveSharedWorkspaceRoot } from '@/shared/workspace-root';
import { findCareerUserStoreLayout } from '@/shared/career-user-store-path';
import { getValidAccessToken } from './connectors-routes';

const logger = createChildLogger({ module: 'storage-browse' });

const DBX = 'https://api.dropboxapi.com/2';
const DBX_CONTENT = 'https://content.dropboxapi.com/2';
const GH = 'https://api.github.com';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
/** Per-user local store root (read lazily so the workspace env is honored at call time). */
function localFilesRoot(): string { return path.join(resolveSharedWorkspaceRoot(), 'userfiles'); }
/** Inline-preview cap — larger files return encoding 'none' (download instead of render). */
export const PREVIEW_MAX = 2 * 1024 * 1024;

/** A browsable storage backend. */
export type StorageProvider = 'dropbox' | 'google-drive' | 'github' | 'oshal-local' | 'career';
/** A top-level source the caller can open in the browser. */
export interface BrowseRoot { provider: StorageProvider; label: string; icon: string }
/** One entry (folder or file) inside a browsed folder. `path` is provider-relative (no leading slash). */
export interface BrowseEntry { name: string; type: 'folder' | 'file'; path: string; size?: number; modified?: string }
/** A file rendered for inline preview. */
export interface FilePreview { name: string; mime: string; size: number; encoding: 'text' | 'base64' | 'none'; content?: string; downloadUrl: string }

/** FS-safe per-user key (matches userKey() in storage-target.ts). */
function userKey(sub: string): string { return crypto.createHash('sha256').update(sub).digest('hex').slice(0, 32); }

/** The caller's OSHAL-local root directory. */
function localUserRoot(sub: string): string { return path.join(localFilesRoot(), userKey(sub)); }

/**
 * Resolve a relative path inside one caller-owned root, rejecting `.`/`..` segments and
 * asserting the result stays link-free within the root. Unlike sanitizeSubfolder this preserves spaces and
 * other valid filename characters so real artifact names (e.g. "Q3 deck.pptx") resolve.
 */
function safeOwnedPath(rootPath: string, p: string): string {
  const root = path.resolve(rootPath);
  const rawSegments = String(p || '').split(/[/\\]+/);
  if (rawSegments.some((segment) => segment === '.' || segment === '..')) throw new Error('invalid path');
  const full = path.resolve(root, ...rawSegments.filter(Boolean));
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('invalid path');
  assertLinkFreePath(root, full);
  return full;
}

/** Reject an existing root/descendant component that redirects through a symbolic link. */
function assertLinkFreePath(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  let current = root;
  for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('linked path is not browsable');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

function safeLocalPath(sub: string, p: string): string {
  return safeOwnedPath(localUserRoot(sub), p);
}

/** Only these top-level subtrees are surfaced (hides the per-user .db/.indexing internals). */
const CAREER_TOP = ['applications', 'uploads', 'career-library'];

/** Resolve a relative path inside the caller's career store, traversal-guarded. */
function safeCareerPath(sub: string, p: string): string {
  const layout = findCareerUserStoreLayout(sub);
  if (!layout) throw new Error('career store not found');
  return safeOwnedPath(layout.userDir, p);
}

/** List one owned directory without following symbolic-link entries. */
function browseOwnedDirectory(dir: string, base: string): BrowseEntry[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry) => {
      const stat = fs.statSync(path.join(dir, entry.name));
      return {
        name: entry.name,
        type: (entry.isDirectory() ? 'folder' : 'file') as BrowseEntry['type'],
        path: base ? `${base}/${entry.name}` : entry.name,
        size: entry.isDirectory() ? undefined : stat.size,
        modified: stat.mtime.toISOString(),
      };
    }).sort(sortEntries);
}

/** Browse the career store: at root, only the curated CAREER_TOP subtrees that exist; below, plain listing. */
function browseCareer(sub: string, p: string): BrowseEntry[] {
  const rel = p ? p.replace(/^[/\\]+|[/\\]+$/g, '') : '';
  if (!rel) {
    return CAREER_TOP
      .filter((d) => { try { return fs.statSync(safeCareerPath(sub, d)).isDirectory(); } catch { return false; } })
      .map((d) => ({ name: d, type: 'folder' as const, path: d }));
  }
  const dir = safeCareerPath(sub, rel);
  return browseOwnedDirectory(dir, rel);
}

/** Providers the caller currently has connected. */
async function connectedSet(pool: AppContext['pool'], sub: string): Promise<Set<string>> {
  const r = await pool.query("SELECT provider FROM oshal_connections WHERE user_sub = $1 AND status = 'connected'", [sub]);
  return new Set(r.rows.map((x: { provider: string }) => x.provider));
}

/** Google Drive reuses the user's Google connector token. */
async function driveToken(ctx: AppContext, sub: string): Promise<string> {
  const tok = await getValidAccessToken(ctx.pool, sub, 'google');
  if (!tok) throw new Error('Google Drive not connected - connect Google at /utilities, then reconnect if Drive scope was just added.');
  return tok;
}

function driveScopeError(status: number, body: string): Error {
  if (status === 401 || status === 403) {
    return new Error(`google drive ${status}: reconnect Google so the stored token includes Drive scope. ${body.slice(0, 120)}`);
  }
  return new Error(`google drive ${status}: ${body.slice(0, 160)}`);
}

function encodeDriveSegment(name: string, id: string): string {
  return `${encodeURIComponent(name)}~${encodeURIComponent(id)}`;
}

function decodeDriveSegment(seg: string): { name: string; id: string } {
  const i = seg.lastIndexOf('~');
  if (i < 0) return { name: seg, id: decodeURIComponent(seg) };
  return { name: decodeURIComponent(seg.slice(0, i)), id: decodeURIComponent(seg.slice(i + 1)) };
}

function driveLastSegment(p: string): { name: string; id: string } {
  const segs = String(p || '').split('/').filter(Boolean);
  return segs.length ? decodeDriveSegment(segs[segs.length - 1]) : { name: 'My Drive', id: 'root' };
}

function driveChildPath(parentPath: string, name: string, id: string): string {
  const base = String(parentPath || '').replace(/^\/+|\/+$/g, '');
  const child = encodeDriveSegment(name, id);
  return base ? `${base}/${child}` : child;
}

/**
 * @description The GitHub login that owns the caller's connection — resolved authoritatively from
 * the API. (The stored account_email is the user's *email* when public and only `@login` when
 * private, so it can't be used as the owner segment.) Exported so storage-target.ts reuses it.
 */
export async function resolveGithubOwner(ctx: AppContext, sub: string): Promise<string> {
  const tok = await getValidAccessToken(ctx.pool, sub, 'github');
  if (!tok) throw new Error('GitHub not connected.');
  const r = await fetch(`${GH}/user`, {
    headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json', 'User-Agent': 'OSHAL' },
  });
  if (!r.ok) throw new Error(`github user ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const j = (await r.json()) as { login?: string };
  if (!j.login) throw new Error('Could not resolve GitHub login — reconnect GitHub.');
  return j.login;
}

/** Names of repos the caller owns (drives the GitHub "root" folder listing). */
async function githubRepos(ctx: AppContext, sub: string): Promise<string[]> {
  const tok = await getValidAccessToken(ctx.pool, sub, 'github');
  if (!tok) return [];
  const r = await fetch(`${GH}/user/repos?per_page=100&sort=updated&affiliation=owner`, {
    headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json', 'User-Agent': 'OSHAL' },
  });
  if (!r.ok) { logger.warn({ status: r.status }, 'github repo list failed'); return []; }
  const j = (await r.json()) as Array<{ name: string }>;
  return (Array.isArray(j) ? j : []).map((x) => x.name);
}

/** Folders before files, then alphabetical — a file-system-feeling sort. */
function sortEntries(a: BrowseEntry, b: BrowseEntry): number {
  if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * @description List the storage sources the caller can browse. OSHAL-local is always present;
 * Dropbox and GitHub appear only when connected.
 */
export async function listRoots(ctx: AppContext, sub: string): Promise<BrowseRoot[]> {
  const roots: BrowseRoot[] = [{ provider: 'oshal-local', label: 'OSHAL Storage', icon: '🗄️' }];
  // Career store — surfaced only when the caller actually has one (résumés/uploads/lessons).
  try {
    if (CAREER_TOP.some((d) => { try { return fs.statSync(safeCareerPath(sub, d)).isDirectory(); } catch { return false; } })) {
      roots.push({ provider: 'career', label: 'Career', icon: '💼' });
    }
  } catch { /* no career store — omit */ }
  const connected = await connectedSet(ctx.pool, sub);
  if (connected.has('dropbox')) roots.push({ provider: 'dropbox', label: 'Dropbox', icon: '📦' });
  if (connected.has('google')) roots.push({ provider: 'google-drive', label: 'Google Drive', icon: '🟢' });
  if (connected.has('github')) roots.push({ provider: 'github', label: 'GitHub', icon: '🐙' });
  return roots;
}

/** Browse the OSHAL-local per-user directory at a relative path. */
function browseLocal(sub: string, p: string): BrowseEntry[] {
  const dir = safeLocalPath(sub, p);
  const base = p ? p.replace(/^[/\\]+|[/\\]+$/g, '') : '';
  return browseOwnedDirectory(dir, base);
}

/** Browse a folder in the caller's Dropbox (app-folder sandbox). */
async function browseDropbox(ctx: AppContext, sub: string, p: string): Promise<BrowseEntry[]> {
  const tok = await getValidAccessToken(ctx.pool, sub, 'dropbox');
  if (!tok) throw new Error('Dropbox not connected.');
  const dbxPath = p ? '/' + p.replace(/^\/+|\/+$/g, '') : '';
  const r = await fetch(`${DBX}/files/list_folder`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: dbxPath, recursive: false }),
  });
  if (r.status === 409) return []; // path/not_found — empty folder
  const j = (await r.json()) as { entries?: Array<Record<string, any>> };
  if (!r.ok) throw new Error(`dropbox list ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return (j.entries || []).map((e) => ({
    name: e.name, type: (e['.tag'] === 'folder' ? 'folder' : 'file') as BrowseEntry['type'],
    path: String(e.path_display || e.path_lower || '').replace(/^\/+/, ''),
    size: e.size ?? undefined, modified: e.client_modified ?? undefined,
  })).sort(sortEntries);
}

/** Browse a Google Drive folder. Path segments carry readable names plus Drive file IDs. */
async function browseGoogleDrive(ctx: AppContext, sub: string, p: string): Promise<BrowseEntry[]> {
  const tok = await driveToken(ctx, sub);
  const parent = driveLastSegment(p).id;
  const q = `'${parent.replace(/'/g, "\\'")}' in parents and trashed = false`;
  const params = new URLSearchParams({
    q,
    pageSize: '100',
    orderBy: 'folder,name',
    fields: 'files(id,name,mimeType,size,modifiedTime)',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  const r = await fetch(`${DRIVE}/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' },
  });
  const text = await r.text();
  if (!r.ok) throw driveScopeError(r.status, text);
  const j = text ? JSON.parse(text) as { files?: Array<{ id: string; name: string; mimeType: string; size?: string; modifiedTime?: string }> } : {};
  return (j.files || []).map((e) => {
    const isFolder = e.mimeType === 'application/vnd.google-apps.folder';
    return {
      name: e.name,
      type: (isFolder ? 'folder' : 'file') as BrowseEntry['type'],
      path: driveChildPath(p, e.name, e.id),
      size: e.size ? Number(e.size) : undefined,
      modified: e.modifiedTime,
    };
  }).sort(sortEntries);
}

/** Browse GitHub: empty path → the caller's repos as folders; otherwise a folder inside `repo/...`. */
async function browseGithub(ctx: AppContext, sub: string, p: string): Promise<BrowseEntry[]> {
  const segs = p ? p.split('/').filter(Boolean) : [];
  if (segs.length === 0) {
    return (await githubRepos(ctx, sub)).map((name) => ({ name, type: 'folder' as const, path: name })).sort(sortEntries);
  }
  const tok = await getValidAccessToken(ctx.pool, sub, 'github');
  if (!tok) throw new Error('GitHub not connected.');
  const owner = await resolveGithubOwner(ctx, sub);
  const repo = segs[0];
  const inner = segs.slice(1).join('/');
  const r = await fetch(`${GH}/repos/${owner}/${encodeURIComponent(repo)}/contents/${inner}`, {
    headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json', 'User-Agent': 'OSHAL' },
  });
  if (r.status === 404) return [];
  const gj = (await r.json()) as Array<{ type: string; name: string; path: string; size?: number }>;
  if (!r.ok) throw new Error(`github list ${r.status}: ${JSON.stringify(gj).slice(0, 160)}`);
  return (Array.isArray(gj) ? gj : []).map((e) => ({
    name: e.name, type: (e.type === 'dir' ? 'folder' : 'file') as BrowseEntry['type'],
    path: `${repo}/${e.path}`, size: e.type === 'dir' ? undefined : e.size,
  })).sort(sortEntries);
}

/**
 * @description List folders + files at a path within one provider. `path` is provider-relative
 * ('' = that provider's root). For GitHub the first path segment is the repo name.
 */
export async function browse(ctx: AppContext, sub: string, provider: StorageProvider, p: string): Promise<BrowseEntry[]> {
  if (provider === 'oshal-local') return browseLocal(sub, p);
  if (provider === 'career') return browseCareer(sub, p);
  if (provider === 'dropbox') return browseDropbox(ctx, sub, p);
  if (provider === 'google-drive') return browseGoogleDrive(ctx, sub, p);
  if (provider === 'github') return browseGithub(ctx, sub, p);
  throw new Error(`unknown provider: ${provider}`);
}

/**
 * @description Read the raw bytes of a file from a provider (used by download + preview).
 * @returns the file name + buffer.
 */
export async function readBytes(ctx: AppContext, sub: string, provider: StorageProvider, p: string): Promise<{ name: string; buf: Buffer }> {
  if (provider === 'oshal-local') {
    const full = safeLocalPath(sub, p);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error('file not found');
    return { name: path.basename(full), buf: fs.readFileSync(full) };
  }
  if (provider === 'career') {
    const full = safeCareerPath(sub, p);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error('file not found');
    return { name: path.basename(full), buf: fs.readFileSync(full) };
  }
  if (provider === 'dropbox') {
    const tok = await getValidAccessToken(ctx.pool, sub, 'dropbox');
    if (!tok) throw new Error('Dropbox not connected.');
    const dbxPath = '/' + p.replace(/^\/+/, '');
    const r = await fetch(`${DBX_CONTENT}/files/download`, {
      method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Dropbox-API-Arg': JSON.stringify({ path: dbxPath }) },
    });
    if (!r.ok) throw new Error(`dropbox download ${r.status}: ${(await r.text()).slice(0, 160)}`);
    return { name: path.basename(dbxPath), buf: Buffer.from(await r.arrayBuffer()) };
  }
  if (provider === 'google-drive') {
    const tok = await driveToken(ctx, sub);
    const item = driveLastSegment(p);
    const metaR = await fetch(`${DRIVE}/files/${encodeURIComponent(item.id)}?fields=id,name,mimeType&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' },
    });
    const metaText = await metaR.text();
    if (!metaR.ok) throw driveScopeError(metaR.status, metaText);
    const meta = JSON.parse(metaText) as { name?: string; mimeType?: string };
    const googleType = meta.mimeType || '';
    if (googleType.startsWith('application/vnd.google-apps.')) {
      const exportMime = googleType === 'application/vnd.google-apps.spreadsheet'
        ? 'text/csv'
        : googleType === 'application/vnd.google-apps.presentation'
          ? 'application/pdf'
          : 'text/plain';
      const er = await fetch(`${DRIVE}/files/${encodeURIComponent(item.id)}/export?mimeType=${encodeURIComponent(exportMime)}`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      const exportText = er.ok ? '' : await er.text();
      if (!er.ok) throw driveScopeError(er.status, exportText);
      return { name: meta.name || item.name, buf: Buffer.from(await er.arrayBuffer()) };
    }
    const r = await fetch(`${DRIVE}/files/${encodeURIComponent(item.id)}?alt=media&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    const errText = r.ok ? '' : await r.text();
    if (!r.ok) throw driveScopeError(r.status, errText);
    return { name: meta.name || item.name, buf: Buffer.from(await r.arrayBuffer()) };
  }
  // github — raw bytes of repo/<path-in-repo>
  const tok = await getValidAccessToken(ctx.pool, sub, 'github');
  if (!tok) throw new Error('GitHub not connected.');
  const owner = await resolveGithubOwner(ctx, sub);
  const segs = p.split('/').filter(Boolean);
  const repo = segs[0];
  const inner = segs.slice(1).join('/');
  const r = await fetch(`${GH}/repos/${owner}/${encodeURIComponent(repo)}/contents/${inner}`, {
    headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github.raw', 'User-Agent': 'OSHAL' },
  });
  if (!r.ok) throw new Error(`github download ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return { name: path.basename(inner), buf: Buffer.from(await r.arrayBuffer()) };
}

export async function uploadBytes(
  ctx: AppContext, sub: string, provider: StorageProvider, dir: string, name: string, buf: Buffer, mime = 'application/octet-stream',
): Promise<{ ok: true; name: string; path: string; size?: number }> {
  const safeName = name.replace(/[^\w.\- ]/g, '_').slice(0, 120);
  if (provider === 'oshal-local') {
    // The always-available per-user local store (the same root browseLocal/readBytes serve),
    // traversal-guarded by safeLocalPath. First consumer: the ADR-139 "Save to OSHAL Storage"
    // built-in; also makes the files surface's upload work with zero connectors.
    const cleanDir = String(dir || '').replace(/^[/\\]+|[/\\]+$/g, '');
    const rel = cleanDir ? `${cleanDir}/${safeName}` : safeName;
    const full = safeLocalPath(sub, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buf);
    return { ok: true, name: safeName, path: rel, size: buf.length };
  }
  if (provider === 'dropbox') {
    const tok = await getValidAccessToken(ctx.pool, sub, 'dropbox');
    if (!tok) throw new Error('Dropbox not connected.');
    const cleanDir = String(dir || '').replace(/^\/+|\/+$/g, '');
    const dest = '/' + (cleanDir ? `${cleanDir}/${safeName}` : safeName);
    const r = await fetch(`${DBX_CONTENT}/files/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tok}`, 'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path: dest, mode: 'overwrite', autorename: true, mute: true }),
      },
      body: new Uint8Array(buf),
    });
    const j = (await r.json()) as { name?: string; path_lower?: string; size?: number };
    if (!r.ok) throw new Error(`dropbox upload ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
    return { ok: true, name: j.name || safeName, path: String(j.path_lower || dest).replace(/^\/+/, ''), size: j.size };
  }
  if (provider === 'google-drive') {
    const tok = await driveToken(ctx, sub);
    const parentId = driveLastSegment(dir).id;
    const boundary = `oshal-${crypto.randomBytes(12).toString('hex')}`;
    const metadata = { name: safeName, parents: [parentId] };
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
      buf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const params = new URLSearchParams({ uploadType: 'multipart', fields: 'id,name,size,modifiedTime', supportsAllDrives: 'true' });
    const r = await fetch(`${DRIVE_UPLOAD}/files?${params.toString()}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: new Uint8Array(body),
    });
    const text = await r.text();
    const j = text ? JSON.parse(text) as { id?: string; name?: string; size?: string } : {};
    if (!r.ok || !j.id) throw driveScopeError(r.status, text);
    return { ok: true, name: j.name || safeName, path: driveChildPath(dir, j.name || safeName, j.id), size: j.size ? Number(j.size) : undefined };
  }
  throw new Error(`upload not supported for provider: ${provider}`);
}

export async function deleteEntry(ctx: AppContext, sub: string, provider: StorageProvider, p: string): Promise<void> {
  if (provider === 'dropbox') {
    const tok = await getValidAccessToken(ctx.pool, sub, 'dropbox');
    if (!tok) throw new Error('Dropbox not connected.');
    const dbxPath = '/' + p.replace(/^\/+/, '');
    const r = await fetch(`${DBX}/files/delete_v2`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dbxPath }),
    });
    if (!r.ok) throw new Error(`dropbox delete ${r.status}: ${(await r.text()).slice(0, 160)}`);
    return;
  }
  if (provider === 'google-drive') {
    const tok = await driveToken(ctx, sub);
    const id = driveLastSegment(p).id;
    const r = await fetch(`${DRIVE}/files/${encodeURIComponent(id)}?supportsAllDrives=true`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tok}` },
    });
    const text = r.ok ? '' : await r.text();
    if (!r.ok) throw driveScopeError(r.status, text);
    return;
  }
  throw new Error(`delete not supported for provider: ${provider}`);
}

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'csv', 'tsv', 'log', 'js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'cs', 'sh', 'bash', 'sql', 'html', 'css', 'scss', 'xml', 'svg', 'toml', 'ini', 'env', 'gitignore', 'dockerfile', 'conf']);
const IMG_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon' };

/** Best-effort MIME from a file extension. */
function mimeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (IMG_MIME[ext]) return IMG_MIME[ext];
  if (ext === 'pdf') return 'application/pdf';
  if (TEXT_EXT.has(ext)) return ext === 'svg' ? 'image/svg+xml' : 'text/plain';
  return 'application/octet-stream';
}

/**
 * @description Produce an inline-previewable form of a file: text content for text types, a base64
 * data payload for images, or 'none' (download-only) for binaries / files over the preview cap.
 * @param sizeHint - the size already known from the folder listing; skips the fetch for big files.
 */
export async function previewFile(
  ctx: AppContext, sub: string, provider: StorageProvider, p: string, sizeHint?: number,
): Promise<FilePreview> {
  const name = path.basename(p);
  const mime = mimeFor(name);
  const downloadUrl = `/api/files/download?provider=${provider}&path=${encodeURIComponent(p)}`;
  const isImg = mime.startsWith('image/') && mime !== 'image/svg+xml';
  const isText = mime.startsWith('text/') || mime === 'image/svg+xml';
  if (!isImg && !isText) return { name, mime, size: sizeHint ?? 0, encoding: 'none', downloadUrl };
  if (sizeHint != null && sizeHint > PREVIEW_MAX) return { name, mime, size: sizeHint, encoding: 'none', downloadUrl };

  const { buf } = await readBytes(ctx, sub, provider, p);
  if (buf.length > PREVIEW_MAX) return { name, mime, size: buf.length, encoding: 'none', downloadUrl };
  if (isImg) return { name, mime, size: buf.length, encoding: 'base64', content: buf.toString('base64'), downloadUrl };
  return { name, mime, size: buf.length, encoding: 'text', content: buf.toString('utf8'), downloadUrl };
}
