/**
 * Storage Target — per-user "where does generated content go" preferences + resolver + save.
 *
 * Two buckets (ADR-041): generated CODE (wants version control → GitHub) and generated FILES
 * (artifacts: PowerPoints, drafts, exports → a document store). Each bucket targets one of:
 *   - dropbox      (a folder in the user's Dropbox)
 *   - oshal-local  (a quota'd per-user local dir — the always-available limited fallback)
 *   - github       (a repo + folder)
 *   - google-drive (a folder in the user's Google Drive — rides the `google` connector token)
 *   - onedrive     (a folder in the user's OneDrive via Microsoft Graph — DORMANT until a
 *                   Microsoft connection exists; never offered as a smart default without one)
 * Generators call resolveStorageTarget()/saveContent() instead of hardcoding a backend. The
 * Storage settings page is a view over these prefs; a future data-management bot edits them.
 * ADR-108: these targets are the DELIVERY ADAPTERS for AI Office — vendor-generic on purpose;
 * the artifact is standard OOXML either way, the adapter only decides whose office world it
 * lands in.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — oshal_storage_prefs (per-user Code/Files targets), smart defaults from connected providers, resolveStorageTarget(), and saveContent() that writes to Dropbox / OSHAL-local (250MB quota) / GitHub.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-043 — saveContent() takes an optional bot-scoped `subfolder` (oshal/{bot-id}/) so each generator app owns a browsable home; new listFolder() scans that subfolder on the resolved backend so a surface can reflect what's actually in the store.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Fix GitHub owner resolution in saveContent()/listFolder() — was reading the stored account_email (which holds the real email when public, only @login when private) → 404 on every GitHub call for public-email accounts. Now uses resolveGithubOwner() (GET /user .login) shared with storage-browse.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-108 — google-drive + onedrive delivery adapters. Drive is path-blind (folders are ids, names not unique), so ensureDrivePath() walks/creates the folder chain by (name, parent); OneDrive is path-addressable (PUT /me/drive/root:/path:/content) and stays dormant until a microsoft/outlook connection exists. Vendor-generic on purpose: AI Office artifacts land in whichever office world the user actually lives in.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | deleteStoredFile() — the delete leg of the adapter set (the "My files" 🗑). Recycle/trash semantics everywhere the backend offers them (Dropbox delete_v2, Drive trashed:true PATCH — never the hard DELETE, OneDrive path DELETE → recycle bin, local unlink); an already-gone file is a success, and a GitHub target reports keeps-history instead of synthesizing a deletion commit.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | deleteStoredFile() takes an optional target override (mirrors saveContent) — live QA showed a row recorded on one provider orphans its store copy when the caller switched Files targets after generating; callers that know where the file lives can now say so.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 storage carve decouple: oshal-local downloadUrls now point at the KERNEL /api/files/download (provider=oshal-local) instead of the packaged app's /api/storage/local/download — a kernel skill must not emit URLs into a store package's mount. ensureStoragePrefsSchema appends buildOwnerRlsPolicyStatements (A1.2 chokepoint — fresh-DB parity with migration 060; live DBs already enforce).
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | pushTree() — the large-tree multi-file git push leg (ADR-041 remaining / BACKLOG storage): batch many files into ONE commit against a github Code target via the Git Data API (blobs -> a tree on the current base_tree -> a commit -> a fast-forward ref update), NOT the one-file Contents API. Honest surfacing: an oversize file or an over-cap total REJECTS the whole push before anything is sent (atomic); a blob that fails mid-flight is reported in `failed[]` while the files that did land still commit; a push where every blob failed throws (no empty commit).
 *
 * @module storage-target
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createChildLogger } from '@/shared/logger';
import { buildOwnerRlsPolicyStatements, runRuntimeSchemaBootstrap } from '@/shared/services/database';
import type { AppContext } from '@/app/composition/app-context';
import { getValidAccessToken } from './connectors-routes';
import { resolveGithubOwner } from './storage-browse';

const logger = createChildLogger({ module: 'storage-target' });

/** Where one bucket's content goes. repo/folder used by github; folder used by dropbox. */
export interface StorageTarget { provider: 'dropbox' | 'oshal-local' | 'github' | 'google-drive' | 'onedrive'; folder?: string; repo?: string }
/** A user's full storage preference (one target per bucket). */
export interface StoragePrefs { code: StorageTarget; files: StorageTarget }

/** Local scratch root + quota (the "OSHAL (limited)" option). */
const LOCAL_ROOT = path.join(process.env.CLINE_WORKSPACE_ROOT || '/app/workspace-shared', 'userfiles');
const LOCAL_QUOTA_BYTES = 250 * 1024 * 1024; // ~250 MB/user

/** FS-safe per-user key (matches userKey() elsewhere). */
function userKey(sub: string): string { return crypto.createHash('sha256').update(sub).digest('hex').slice(0, 32); }

/**
 * Normalize a caller-supplied subfolder into a safe relative path: strip leading/trailing
 * slashes, drop any `..`/empty segments (no traversal out of the user's store), keep only
 * word/dot/dash chars per segment. Returns '' for anything that sanitizes to nothing.
 */
export function sanitizeSubfolder(sub?: string): string {
  if (!sub) return '';
  return String(sub)
    .split(/[/\\]+/)
    .map((seg) => seg.replace(/[^\w.\-]/g, '').trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

/** A file living in the store (what listFolder returns — drives "My decks"-style views). */
export interface StoredFile { name: string; size?: number; downloadUrl?: string; url?: string }

/** Create the prefs table if absent. Call at boot. */
export async function ensureStoragePrefsSchema(pool: AppContext['pool']): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'storage routes',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_storage_prefs (
        user_sub TEXT PRIMARY KEY,
        code_provider TEXT, code_repo TEXT, code_folder TEXT,
        files_provider TEXT, files_folder TEXT, files_repo TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      ...buildOwnerRlsPolicyStatements('oshal_storage_prefs', 'user_sub'),
    ],
    requirements: [
      {
        table: 'oshal_storage_prefs',
        columns: ['user_sub', 'code_provider', 'code_repo', 'code_folder', 'files_provider', 'files_folder', 'files_repo', 'updated_at'],
      },
    ],
  });
}

/** Which providers the caller has connected (drives smart defaults). */
async function connectedProviders(pool: AppContext['pool'], sub: string): Promise<Set<string>> {
  const r = await pool.query("SELECT provider FROM oshal_connections WHERE user_sub = $1 AND status = 'connected'", [sub]);
  return new Set(r.rows.map((x: { provider: string }) => x.provider));
}

/**
 * @description Resolve a user's storage prefs, falling back to smart defaults based on what they
 * have connected (Code → GitHub if connected else local; Files → Dropbox if connected else local).
 */
export async function getStoragePrefs(ctx: AppContext, sub: string): Promise<StoragePrefs> {
  const row = (await ctx.pool.query('SELECT * FROM oshal_storage_prefs WHERE user_sub = $1', [sub])).rows[0] as Record<string, string> | undefined;
  const connected = await connectedProviders(ctx.pool, sub);
  const codeDefault: StorageTarget = connected.has('github') ? { provider: 'github', folder: '' } : { provider: 'oshal-local' };
  // Files default prefers the document stores the user has actually connected — Dropbox keeps
  // its historical first slot; Google Drive slots in ahead of the quota'd local fallback.
  const filesDefault: StorageTarget = connected.has('dropbox') ? { provider: 'dropbox', folder: '/' }
    : connected.has('google') ? { provider: 'google-drive' }
    : { provider: 'oshal-local' };
  if (!row) return { code: codeDefault, files: filesDefault };
  return {
    code: row.code_provider ? { provider: row.code_provider as StorageTarget['provider'], repo: row.code_repo || undefined, folder: row.code_folder || undefined } : codeDefault,
    files: row.files_provider ? { provider: row.files_provider as StorageTarget['provider'], folder: row.files_folder || undefined, repo: row.files_repo || undefined } : filesDefault,
  };
}

/** Persist a user's storage prefs (full replace). */
export async function setStoragePrefs(ctx: AppContext, sub: string, prefs: StoragePrefs): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO oshal_storage_prefs (user_sub, code_provider, code_repo, code_folder, files_provider, files_folder, files_repo, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (user_sub) DO UPDATE SET code_provider=$2, code_repo=$3, code_folder=$4, files_provider=$5, files_folder=$6, files_repo=$7, updated_at=NOW()`,
    [sub, prefs.code.provider, prefs.code.repo || null, prefs.code.folder || null, prefs.files.provider, prefs.files.folder || null, prefs.files.repo || null],
  );
}

/** Resolve the target for a content kind (the configured default; callers may override per-save). */
export async function resolveStorageTarget(ctx: AppContext, sub: string, kind: 'code' | 'files'): Promise<StorageTarget> {
  return (await getStoragePrefs(ctx, sub))[kind];
}

/** Recursively sum a directory's file sizes (quota check). */
function dirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

/**
 * @description Save generated content to the resolved target for its bucket (or an explicit
 * override). Returns where it landed + a download URL when applicable.
 * @param ctx - app context
 * @param sub - caller sub
 * @param kind - 'code' | 'files' (selects the default target)
 * @param name - file name
 * @param buf - file bytes
 * @param override - optional explicit target (the per-save "Save to…" choice)
 * @param subfolder - optional bot-scoped path (e.g. `oshal/{bot-id}`) under the target (ADR-043)
 */
export async function saveContent(
  ctx: AppContext, sub: string, kind: 'code' | 'files', name: string, buf: Buffer, override?: StorageTarget, subfolder?: string,
): Promise<{ provider: string; location: string; downloadUrl?: string; url?: string }> {
  const target = override || (await resolveStorageTarget(ctx, sub, kind));
  const safeName = name.replace(/[^\w.\- ]/g, '_').slice(0, 120);
  const sub2 = sanitizeSubfolder(subfolder);

  if (target.provider === 'oshal-local') {
    const userRoot = path.join(LOCAL_ROOT, userKey(sub));
    const dir = sub2 ? path.join(userRoot, sub2) : userRoot;
    fs.mkdirSync(dir, { recursive: true });
    if (dirSize(userRoot) + buf.length > LOCAL_QUOTA_BYTES) {
      throw new Error('OSHAL local storage quota (250 MB) exceeded — connect Dropbox/GitHub or free space.');
    }
    fs.writeFileSync(path.join(dir, safeName), buf);
    const rel = sub2 ? `${sub2}/${safeName}` : safeName;
    return { provider: 'oshal-local', location: rel, downloadUrl: `/api/files/download?provider=oshal-local&path=${encodeURIComponent(rel)}` };
  }

  if (target.provider === 'dropbox') {
    const tok = await getValidAccessToken(ctx.pool, sub, 'dropbox');
    if (!tok) throw new Error('Dropbox not connected (your Files target is Dropbox) — connect it or change your storage target.');
    const base = (target.folder && target.folder !== '/') ? '/' + target.folder.replace(/^\/+|\/+$/g, '') : '';
    const folder = sub2 ? `${base}/${sub2}` : base;
    const dbxPath = `${folder}/${safeName}`;
    const r = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ path: dbxPath, mode: 'overwrite', autorename: true, mute: true }) },
      body: new Uint8Array(buf),
    });
    if (!r.ok) throw new Error(`dropbox upload ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const j = (await r.json()) as { path_lower?: string };
    return { provider: 'dropbox', location: j.path_lower || dbxPath, downloadUrl: `/api/files/download?path=${encodeURIComponent(j.path_lower || dbxPath)}` };
  }

  if (target.provider === 'google-drive') return saveGoogleDrive(ctx, sub, target, safeName, buf, sub2);
  if (target.provider === 'onedrive') return saveOneDrive(ctx, sub, target, safeName, buf, sub2);

  // github — commit the file to repo/folder (default branch). Needs target.repo.
  const tok = await getValidAccessToken(ctx.pool, sub, 'github');
  if (!tok) throw new Error('GitHub not connected — connect it or change your storage target.');
  if (!target.repo) throw new Error('No GitHub repo set for this target — pick one in Storage settings.');
  const owner = await resolveGithubOwner(ctx, sub);
  const base = (target.folder || '').replace(/^\/+|\/+$/g, '');
  const folder = [base, sub2].filter(Boolean).join('/');
  const ghPath = folder ? `${folder}/${safeName}` : safeName;
  const r = await fetch(`https://api.github.com/repos/${owner}/${encodeURIComponent(target.repo)}/contents/${ghPath}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json', 'User-Agent': 'OSHAL', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Add ${safeName} (OSHAL)`, content: buf.toString('base64') }),
  });
  const gj = (await r.json()) as { content?: { html_url?: string } };
  if (!r.ok) throw new Error(`github commit ${r.status}: ${JSON.stringify(gj).slice(0, 160)}`);
  logger.info({ sub, owner, repo: target.repo, path: ghPath }, 'saved content to GitHub');
  return { provider: 'github', location: `${owner}/${target.repo}/${ghPath}`, url: gj.content?.html_url };
}

/**
 * @description List the files a generator app actually has in its bot-scoped subfolder on the
 * caller's resolved target (ADR-043). The store is authoritative — a surface calls this so its
 * list reflects what's really there (added/removed), not just a metadata cache. A missing folder
 * (nothing saved yet) returns []; backend errors throw for the caller to handle.
 * @param ctx - app context
 * @param sub - caller sub
 * @param kind - 'code' | 'files' (selects the default target)
 * @param subfolder - bot-scoped path (e.g. `oshal/{bot-id}`) under the target
 * @returns the files present, with a download/view URL where the backend offers one
 */
export async function listFolder(
  ctx: AppContext, sub: string, kind: 'code' | 'files', subfolder?: string,
): Promise<{ provider: string; files: StoredFile[] }> {
  const target = await resolveStorageTarget(ctx, sub, kind);
  const sub2 = sanitizeSubfolder(subfolder);

  if (target.provider === 'oshal-local') {
    const dir = sub2 ? path.join(LOCAL_ROOT, userKey(sub), sub2) : path.join(LOCAL_ROOT, userKey(sub));
    if (!fs.existsSync(dir)) return { provider: 'oshal-local', files: [] };
    const files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => ({
      name: e.name, size: fs.statSync(path.join(dir, e.name)).size,
      downloadUrl: `/api/files/download?provider=oshal-local&path=${encodeURIComponent(sub2 ? `${sub2}/${e.name}` : e.name)}`,
    }));
    return { provider: 'oshal-local', files };
  }

  if (target.provider === 'dropbox') {
    const tok = await getValidAccessToken(ctx.pool, sub, 'dropbox');
    if (!tok) throw new Error('Dropbox not connected — connect it or change your storage target.');
    const base = (target.folder && target.folder !== '/') ? '/' + target.folder.replace(/^\/+|\/+$/g, '') : '';
    const folder = sub2 ? `${base}/${sub2}` : base;
    const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folder, recursive: false }),
    });
    if (r.status === 409) return { provider: 'dropbox', files: [] }; // path/not_found — nothing saved yet
    const j = (await r.json()) as { entries?: Array<{ '.tag': string; name: string; path_lower: string; size?: number }> };
    if (!r.ok) throw new Error(`dropbox list ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
    const files = (j.entries || []).filter((e) => e['.tag'] === 'file').map((e) => ({
      name: e.name, size: e.size, downloadUrl: `/api/files/download?path=${encodeURIComponent(e.path_lower)}`,
    }));
    return { provider: 'dropbox', files };
  }

  if (target.provider === 'google-drive') return listGoogleDrive(ctx, sub, target, sub2);
  if (target.provider === 'onedrive') return listOneDrive(ctx, sub, target, sub2);

  // github — list the repo folder's contents.
  const tok = await getValidAccessToken(ctx.pool, sub, 'github');
  if (!tok) throw new Error('GitHub not connected — connect it or change your storage target.');
  if (!target.repo) throw new Error('No GitHub repo set for this target — pick one in Storage settings.');
  const owner = await resolveGithubOwner(ctx, sub);
  const base = (target.folder || '').replace(/^\/+|\/+$/g, '');
  const folder = [base, sub2].filter(Boolean).join('/');
  const r = await fetch(`https://api.github.com/repos/${owner}/${encodeURIComponent(target.repo)}/contents/${folder}`, {
    headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json', 'User-Agent': 'OSHAL' },
  });
  if (r.status === 404) return { provider: 'github', files: [] }; // folder doesn't exist yet
  const gj = (await r.json()) as Array<{ type: string; name: string; size?: number; html_url?: string }>;
  if (!r.ok) throw new Error(`github list ${r.status}: ${JSON.stringify(gj).slice(0, 160)}`);
  const files = (Array.isArray(gj) ? gj : []).filter((e) => e.type === 'file').map((e) => ({
    name: e.name, size: e.size, url: e.html_url,
  }));
  return { provider: 'github', files };
}

/** Escape a value for a Drive `q` query (single-quoted strings). */
function driveEscape(v: string): string { return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

/** The Google Drive OAuth token — rides the `google` connector (needs a drive scope). */
async function driveToken(ctx: AppContext, sub: string): Promise<string> {
  const tok = await getValidAccessToken(ctx.pool, sub, 'google');
  if (!tok) throw new Error('Google not connected — connect Google (with Drive access) or change your storage target.');
  return tok;
}

/** Path segments for a target: configured base folder + the bot-scoped subfolder. */
function targetSegments(target: StorageTarget, sub2: string): string[] {
  const base = (target.folder || '').split('/').map((x) => x.trim()).filter(Boolean);
  return [...base, ...sub2.split('/').filter(Boolean)];
}

/**
 * @description Resolve a folder PATH to a Drive folder id, creating missing segments. Drive has
 * no path addressing — folders are ids and names are not unique — so this walks the chain by
 * (name, parent) and takes the first match, which is stable for folders we ourselves created.
 * @param tok - Drive access token
 * @param segments - path segments under My Drive (e.g. ['oshal','a0000000-…'])
 * @returns the deepest folder's id ('root' for an empty path)
 */
async function ensureDrivePath(tok: string, segments: string[]): Promise<string> {
  let parent = 'root';
  for (const seg of segments.filter(Boolean)) {
    const q = `name='${driveEscape(seg)}' and '${parent}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const list = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    const lj = (await list.json()) as { files?: Array<{ id: string }> };
    if (!list.ok) throw new Error(`gdrive folder lookup ${list.status}: ${JSON.stringify(lj).slice(0, 160)}`);
    if (lj.files?.[0]?.id) { parent = lj.files[0].id; continue; }
    const make = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: seg, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }),
    });
    const mj = (await make.json()) as { id?: string };
    if (!make.ok || !mj.id) throw new Error(`gdrive folder create ${make.status}: ${JSON.stringify(mj).slice(0, 160)}`);
    parent = mj.id;
  }
  return parent;
}

/** Save one file into the user's Google Drive (multipart upload into the resolved folder). */
async function saveGoogleDrive(
  ctx: AppContext, sub: string, target: StorageTarget, safeName: string, buf: Buffer, sub2: string,
): Promise<{ provider: string; location: string; url?: string }> {
  const tok = await driveToken(ctx, sub);
  const folderId = await ensureDrivePath(tok, targetSegments(target, sub2));
  const boundary = 'oshal' + crypto.randomBytes(8).toString('hex');
  const meta = JSON.stringify({ name: safeName, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
    method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: new Uint8Array(body),
  });
  const j = (await r.json()) as { id?: string; webViewLink?: string };
  if (!r.ok || !j.id) throw new Error(`gdrive upload ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  logger.info({ sub, id: j.id, name: safeName }, 'saved content to Google Drive');
  return { provider: 'google-drive', location: [...targetSegments(target, sub2), safeName].join('/'), url: j.webViewLink };
}

/** List the bot-scoped folder in the user's Google Drive. */
async function listGoogleDrive(
  ctx: AppContext, sub: string, target: StorageTarget, sub2: string,
): Promise<{ provider: string; files: StoredFile[] }> {
  const tok = await driveToken(ctx, sub);
  const folderId = await ensureDrivePath(tok, targetSegments(target, sub2));
  const q = `'${folderId}' in parents and mimeType!='application/vnd.google-apps.folder' and trashed=false`;
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,size,webViewLink)&pageSize=100`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  const j = (await r.json()) as { files?: Array<{ name: string; size?: string; webViewLink?: string }> };
  if (!r.ok) throw new Error(`gdrive list ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return { provider: 'google-drive', files: (j.files || []).map((f) => ({ name: f.name, size: f.size ? Number(f.size) : undefined, url: f.webViewLink })) };
}

/** The Microsoft Graph token — a `microsoft` connection, or `outlook` when its grant carries a
 *  Files scope. DORMANT until one exists: without a connection this throws a clear error, and
 *  smart defaults never select onedrive. */
async function graphToken(ctx: AppContext, sub: string): Promise<string> {
  const tok = (await getValidAccessToken(ctx.pool, sub, 'microsoft')) || (await getValidAccessToken(ctx.pool, sub, 'outlook'));
  if (!tok) throw new Error('Microsoft not connected — connect Microsoft 365 (with Files access) or change your storage target.');
  return tok;
}

/** Save one file into the user's OneDrive (Graph is path-addressable — no folder-id walk). */
async function saveOneDrive(
  ctx: AppContext, sub: string, target: StorageTarget, safeName: string, buf: Buffer, sub2: string,
): Promise<{ provider: string; location: string; url?: string }> {
  const tok = await graphToken(ctx, sub);
  const segs = targetSegments(target, sub2);
  const drivePath = [...segs, safeName].map(encodeURIComponent).join('/');
  const r = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${drivePath}:/content`, {
    method: 'PUT', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(buf),
  });
  const j = (await r.json()) as { id?: string; webUrl?: string };
  if (!r.ok || !j.id) throw new Error(`onedrive upload ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  logger.info({ sub, id: j.id, name: safeName }, 'saved content to OneDrive');
  return { provider: 'onedrive', location: [...segs, safeName].join('/'), url: j.webUrl };
}

/** Outcome of a store delete — removed=false with a reason is a RESULT (e.g. github), not an error. */
export interface DeleteOutcome { provider: string; removed: boolean; reason?: string }

/**
 * @description Delete one file from a generator app's bot-scoped subfolder on the caller's
 * resolved target — the delete leg of the ADR-043/108 adapter set. Semantics per backend:
 * recycle/trash wherever the provider offers it (Dropbox delete_v2 → Dropbox trash, Drive →
 * `trashed: true` PATCH, OneDrive path DELETE → recycle bin, local → unlink), an already-gone
 * file resolves as removed, and a GitHub target refuses with `github-keeps-history` — a repo is
 * version control, so removing a committed file is a git operation the user should own.
 * @param ctx - app context
 * @param sub - caller sub (the store path is the CALLER's target — a user can only reach their own store)
 * @param kind - 'code' | 'files' (selects the default target)
 * @param name - file basename to remove (path segments are stripped; no traversal)
 * @param subfolder - bot-scoped path (e.g. `oshal/{bot-id}`) under the target
 * @param override - optional explicit target — for deleting a file recorded on a provider other
 *   than the current default (a caller who changed their Files target since generating)
 * @returns where the delete ran and whether the store copy is gone
 */
export async function deleteStoredFile(
  ctx: AppContext, sub: string, kind: 'code' | 'files', name: string, subfolder?: string, override?: StorageTarget,
): Promise<DeleteOutcome> {
  const target = override || (await resolveStorageTarget(ctx, sub, kind));
  const sub2 = sanitizeSubfolder(subfolder);
  const safeName = path.basename(String(name || '').trim());
  if (!safeName || safeName === '.' || safeName === '..') throw new Error('a file name is required');

  if (target.provider === 'oshal-local') {
    const dir = sub2 ? path.join(LOCAL_ROOT, userKey(sub), sub2) : path.join(LOCAL_ROOT, userKey(sub));
    const p = path.join(dir, safeName);
    if (!fs.existsSync(p)) return { provider: 'oshal-local', removed: true, reason: 'already-gone' };
    fs.unlinkSync(p);
    logger.info({ sub, name: safeName }, 'deleted local store file');
    return { provider: 'oshal-local', removed: true };
  }

  if (target.provider === 'dropbox') {
    const tok = await getValidAccessToken(ctx.pool, sub, 'dropbox');
    if (!tok) throw new Error('Dropbox not connected — connect it or change your storage target.');
    const base = (target.folder && target.folder !== '/') ? '/' + target.folder.replace(/^\/+|\/+$/g, '') : '';
    const folder = sub2 ? `${base}/${sub2}` : base;
    const r = await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
      method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: `${folder}/${safeName}` }),
    });
    if (r.status === 409) return { provider: 'dropbox', removed: true, reason: 'already-gone' }; // path_lookup/not_found
    if (!r.ok) throw new Error(`dropbox delete ${r.status}: ${(await r.text()).slice(0, 160)}`);
    logger.info({ sub, name: safeName }, 'deleted Dropbox store file (to Dropbox trash)');
    return { provider: 'dropbox', removed: true };
  }

  if (target.provider === 'google-drive') {
    const tok = await driveToken(ctx, sub);
    const folderId = await ensureDrivePath(tok, targetSegments(target, sub2));
    const q = `name='${driveEscape(safeName)}' and '${folderId}' in parents and trashed=false`;
    const list = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    const lj = (await list.json()) as { files?: Array<{ id: string }> };
    if (!list.ok) throw new Error(`gdrive lookup ${list.status}: ${JSON.stringify(lj).slice(0, 160)}`);
    const id = lj.files?.[0]?.id;
    if (!id) return { provider: 'google-drive', removed: true, reason: 'already-gone' };
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
    if (!r.ok) throw new Error(`gdrive trash ${r.status}: ${(await r.text()).slice(0, 160)}`);
    logger.info({ sub, id, name: safeName }, 'trashed Google Drive store file');
    return { provider: 'google-drive', removed: true };
  }

  if (target.provider === 'onedrive') {
    const tok = await graphToken(ctx, sub);
    const drivePath = [...targetSegments(target, sub2), safeName].map(encodeURIComponent).join('/');
    const r = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${drivePath}:`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${tok}` },
    });
    if (r.status === 404) return { provider: 'onedrive', removed: true, reason: 'already-gone' };
    if (!r.ok) throw new Error(`onedrive delete ${r.status}: ${(await r.text()).slice(0, 160)}`);
    logger.info({ sub, name: safeName }, 'deleted OneDrive store file (to recycle bin)');
    return { provider: 'onedrive', removed: true };
  }

  return { provider: 'github', removed: false, reason: 'github-keeps-history' };
}

/** GitHub REST/Git-Data API base (shared with saveContent/listFolder). */
const GITHUB_API = 'https://api.github.com';
/** Default per-file blob ceiling for a tree push (GitHub's blob API tops out ~40MB; 25MB is safe). */
const TREE_PUSH_MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Default aggregate ceiling for one tree push. */
const TREE_PUSH_MAX_TREE_BYTES = 100 * 1024 * 1024;

/** One file in a multi-file tree push (path is repo-relative; folder segments allowed). */
export interface TreePushFile { path: string; content: Buffer | string }
/** Knobs for a tree push (an explicit target overrides the caller's Code default; caps default to the module ceilings). */
export interface TreePushOptions { target?: StorageTarget; branch?: string; message?: string; maxFileBytes?: number; maxTreeBytes?: number }
/** Result of a multi-file tree push. `failed` lists blobs that couldn't be created — the rest still committed. */
export interface TreePushOutcome {
  provider: 'github'; owner: string; repo: string; branch: string;
  commitSha: string; commitUrl?: string; pushed: string[]; failed: Array<{ path: string; reason: string }>;
}

/** Normalize a caller path into a safe repo-relative path: strip leading slash + drop `..`/empty segments. */
function sanitizeTreePath(p: string): string {
  return String(p || '').split(/[/\\]+/).map((seg) => seg.trim()).filter((seg) => seg && seg !== '.' && seg !== '..').join('/');
}

/** Auth header set for the Git Data API (json=true adds Content-Type for write calls). */
function githubHeaders(tok: string, json = false): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json', 'User-Agent': 'OSHAL' };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

/**
 * Normalize paths + prefix the target base folder + enforce size caps. Throws (an ATOMIC reject —
 * nothing has been sent yet) on an empty set, any oversize file, or an over-cap total.
 */
function gateTreeFiles(files: TreePushFile[], baseFolder: string, maxFile: number, maxTree: number): Array<{ path: string; buf: Buffer; rel: string }> {
  const base = (baseFolder || '').replace(/^\/+|\/+$/g, '');
  const norm = files.map((f) => {
    const rel = sanitizeTreePath(f.path);
    const buf = Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content ?? ''), 'utf8');
    return { path: [base, rel].filter(Boolean).join('/'), buf, rel };
  }).filter((f) => f.rel);
  if (!norm.length) throw new Error('no files to push (every path sanitized to empty)');
  const oversize = norm.filter((f) => f.buf.length > maxFile).map((f) => f.rel);
  if (oversize.length) throw new Error(`tree push rejected — ${oversize.length} file(s) over the ${maxFile} byte per-file cap: ${oversize.slice(0, 5).join(', ')}`);
  const total = norm.reduce((n, f) => n + f.buf.length, 0);
  if (total > maxTree) throw new Error(`tree push rejected — ${total} bytes total over the ${maxTree} byte cap`);
  return norm;
}

/** Resolve a repo's push ref: the branch (or the repo default), its head commit sha + base tree sha. */
async function resolveGithubHead(owner: string, repo: string, tok: string, branch?: string): Promise<{ branch: string; headSha: string; treeSha: string }> {
  let br = branch;
  if (!br) {
    const rr = await fetch(`${GITHUB_API}/repos/${owner}/${encodeURIComponent(repo)}`, { headers: githubHeaders(tok) });
    const rj = (await rr.json()) as { default_branch?: string; message?: string };
    if (!rr.ok || !rj.default_branch) throw new Error(`github repo lookup ${rr.status}: ${rj.message || ''}`.trim());
    br = rj.default_branch;
  }
  const ref = await fetch(`${GITHUB_API}/repos/${owner}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(br)}`, { headers: githubHeaders(tok) });
  const refj = (await ref.json()) as { object?: { sha?: string }; message?: string };
  if (!ref.ok || !refj.object?.sha) throw new Error(`github ref heads/${br} ${ref.status}: ${refj.message || ''}`.trim());
  const headSha = refj.object.sha;
  const cr = await fetch(`${GITHUB_API}/repos/${owner}/${encodeURIComponent(repo)}/git/commits/${headSha}`, { headers: githubHeaders(tok) });
  const cj = (await cr.json()) as { tree?: { sha?: string }; message?: string };
  if (!cr.ok || !cj.tree?.sha) throw new Error(`github commit ${headSha.slice(0, 8)} ${cr.status}: ${cj.message || ''}`.trim());
  return { branch: br, headSha, treeSha: cj.tree.sha };
}

/** Create a blob per file. A per-file failure is COLLECTED (partial-failure reporting), never thrown. */
async function createTreeBlobs(owner: string, repo: string, tok: string, files: Array<{ path: string; buf: Buffer }>): Promise<{ entries: Array<{ path: string; sha: string }>; failed: Array<{ path: string; reason: string }> }> {
  const entries: Array<{ path: string; sha: string }> = [];
  const failed: Array<{ path: string; reason: string }> = [];
  for (const f of files) {
    try {
      const r = await fetch(`${GITHUB_API}/repos/${owner}/${encodeURIComponent(repo)}/git/blobs`, {
        method: 'POST', headers: githubHeaders(tok, true),
        body: JSON.stringify({ content: f.buf.toString('base64'), encoding: 'base64' }),
      });
      const j = (await r.json()) as { sha?: string; message?: string };
      if (!r.ok || !j.sha) { failed.push({ path: f.path, reason: `blob ${r.status}: ${(j.message || '').slice(0, 80)}`.trim() }); continue; }
      entries.push({ path: f.path, sha: j.sha });
    } catch (err) {
      failed.push({ path: f.path, reason: (err as Error).message.slice(0, 100) });
    }
  }
  return { entries, failed };
}

/**
 * @description Push a MULTI-FILE tree to the caller's github Code target in ONE commit — the
 * large-tree path a build-swarm needs, using the Git Data API (blobs -> a tree on the current
 * base_tree -> a commit -> a fast-forward ref update) rather than the one-file Contents API which
 * would be a commit per file. Honest surfacing: an oversize file or an over-cap total REJECTS the
 * whole push before anything is sent (atomic); a blob that fails mid-flight is reported in
 * `failed[]` while the files that did land still commit; a push where every blob failed throws.
 * @param ctx - app context
 * @param sub - caller sub (the target is the CALLER's github Code target)
 * @param files - the tree (repo-relative paths + bytes)
 * @param opts - branch/message + an optional explicit target + size caps
 * @returns the commit + the paths that landed + any per-file failures
 */
export async function pushTree(ctx: AppContext, sub: string, files: TreePushFile[], opts: TreePushOptions = {}): Promise<TreePushOutcome> {
  const target = opts.target || (await resolveStorageTarget(ctx, sub, 'code'));
  if (target.provider !== 'github') throw new Error(`tree push needs a GitHub Code target (got ${target.provider}) — change your Code storage target.`);
  if (!target.repo) throw new Error('No GitHub repo set for this target — pick one in Storage settings.');
  const norm = gateTreeFiles(files, target.folder || '', opts.maxFileBytes ?? TREE_PUSH_MAX_FILE_BYTES, opts.maxTreeBytes ?? TREE_PUSH_MAX_TREE_BYTES);

  const tok = await getValidAccessToken(ctx.pool, sub, 'github');
  if (!tok) throw new Error('GitHub not connected — connect it or change your storage target.');
  const owner = await resolveGithubOwner(ctx, sub);
  const repo = target.repo;
  const { branch, headSha, treeSha } = await resolveGithubHead(owner, repo, tok, opts.branch);

  const { entries, failed } = await createTreeBlobs(owner, repo, tok, norm);
  if (!entries.length) throw new Error(`tree push failed — no blobs created (${failed.length} file(s) failed): ${failed.slice(0, 3).map((f) => f.path).join(', ')}`);

  const treeBody = { base_tree: treeSha, tree: entries.map((e) => ({ path: e.path, mode: '100644', type: 'blob', sha: e.sha })) };
  const tr = await fetch(`${GITHUB_API}/repos/${owner}/${encodeURIComponent(repo)}/git/trees`, { method: 'POST', headers: githubHeaders(tok, true), body: JSON.stringify(treeBody) });
  const tj = (await tr.json()) as { sha?: string; message?: string };
  if (!tr.ok || !tj.sha) throw new Error(`github tree ${tr.status}: ${tj.message || ''}`.trim());

  const message = opts.message || `Add ${entries.length} file(s) (OSHAL)`;
  const co = await fetch(`${GITHUB_API}/repos/${owner}/${encodeURIComponent(repo)}/git/commits`, { method: 'POST', headers: githubHeaders(tok, true), body: JSON.stringify({ message, tree: tj.sha, parents: [headSha] }) });
  const cj = (await co.json()) as { sha?: string; html_url?: string; message?: string };
  if (!co.ok || !cj.sha) throw new Error(`github commit ${co.status}: ${cj.message || ''}`.trim());

  const up = await fetch(`${GITHUB_API}/repos/${owner}/${encodeURIComponent(repo)}/git/refs/heads/${encodeURIComponent(branch)}`, { method: 'PATCH', headers: githubHeaders(tok, true), body: JSON.stringify({ sha: cj.sha, force: false }) });
  if (!up.ok) { const uj = (await up.json()) as { message?: string }; throw new Error(`github ref update ${up.status}: ${uj.message || 'non-fast-forward — pull the branch first'}`.trim()); }

  logger.info({ sub, owner, repo, branch, commit: cj.sha.slice(0, 8), pushed: entries.length, failed: failed.length }, 'pushed multi-file tree to GitHub');
  return { provider: 'github', owner, repo, branch, commitSha: cj.sha, commitUrl: cj.html_url, pushed: entries.map((e) => e.path), failed };
}

/** List the bot-scoped folder in the user's OneDrive. */
async function listOneDrive(
  ctx: AppContext, sub: string, target: StorageTarget, sub2: string,
): Promise<{ provider: string; files: StoredFile[] }> {
  const tok = await graphToken(ctx, sub);
  const segs = targetSegments(target, sub2);
  const base = segs.length ? `root:/${segs.map(encodeURIComponent).join('/')}:/children` : 'root/children';
  const r = await fetch(`https://graph.microsoft.com/v1.0/me/drive/${base}?$select=name,size,webUrl,folder`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (r.status === 404) return { provider: 'onedrive', files: [] }; // nothing saved yet
  const j = (await r.json()) as { value?: Array<{ name: string; size?: number; webUrl?: string; folder?: unknown }> };
  if (!r.ok) throw new Error(`onedrive list ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return { provider: 'onedrive', files: (j.value || []).filter((e) => !e.folder).map((e) => ({ name: e.name, size: e.size, url: e.webUrl })) };
}
