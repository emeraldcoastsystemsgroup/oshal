/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Scoped workspace sync: pull ONLY the shared task folder this node currently holds into a local mirror, then push back additively. The node never sees other tasks' folders (the control plane gates by held-task). Pushes are additive — only files this node created/changed — so sibling rounds' handovers + .tokenchase capture are never clobbered.
 */

import { promises as fsp } from 'fs';
import { homedir } from 'os';
import { join, dirname, resolve, sep } from 'path';
import type { OshalChatConfig } from './config';

/** A file entry in the workspace manifest. */
interface ManifestFile { path: string; size: number; mtimeMs: number }

/** Baseline captured at pull time, used to push only what changed. */
export interface WorkspaceMirror {
  dir: string;
  baseline: Map<string, { size: number; mtimeMs: number }>;
}

/** Local root for mirrored task workspaces (kept, not deleted, like the swarm's). */
function mirrorRoot(): string {
  return join(homedir(), '.oshal-node', 'workspaces');
}

/** Auth headers matching the remote-client surface. */
function headers(config: OshalChatConfig): Record<string, string> {
  return {
    [config.authHeaderName]: config.sharedSecret,
    authorization: `Bearer ${config.sharedSecret}`,
  };
}

/** Guards a relative path so a hostile manifest can't write outside the mirror. */
function safeLocal(root: string, rel: string): string | null {
  const target = resolve(root, rel);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

/**
 * @description Pulls the held task's shared folder into a local mirror and returns
 * the mirror dir + a baseline of what was pulled (for an additive push later).
 */
export async function pullWorkspace(
  config: OshalChatConfig,
  taskId: string,
  folderId: string,
): Promise<WorkspaceMirror> {
  const base = `${config.controlPlaneUrl.replace(/\/+$/, '')}/api/remote-clients/${config.clientId}/tasks/${encodeURIComponent(taskId)}/workspace`;
  const dir = join(mirrorRoot(), folderId);
  await fsp.mkdir(dir, { recursive: true });

  const manifestRes = await fetch(base, { headers: headers(config) });
  if (!manifestRes.ok) throw new Error(`workspace manifest ${manifestRes.status}`);
  const manifest = (await manifestRes.json()) as { files?: ManifestFile[] };
  const files = manifest.files || [];

  const baseline = new Map<string, { size: number; mtimeMs: number }>();
  for (const file of files) {
    const local = safeLocal(dir, file.path);
    if (!local) continue;
    const res = await fetch(`${base}/file?path=${encodeURIComponent(file.path)}`, { headers: headers(config) });
    if (!res.ok) continue;
    const buf = Buffer.from(await res.arrayBuffer());
    await fsp.mkdir(dirname(local), { recursive: true });
    await fsp.writeFile(local, buf);
    const stat = await fsp.stat(local).catch(() => null);
    baseline.set(file.path, { size: buf.length, mtimeMs: stat ? Math.round(stat.mtimeMs) : 0 });
  }
  return { dir, baseline };
}

/**
 * @description Pushes back ONLY files this node created or changed since the pull
 * (additive — never deletes remote files). Returns the count pushed.
 */
export async function pushWorkspace(
  config: OshalChatConfig,
  taskId: string,
  mirror: WorkspaceMirror,
): Promise<number> {
  const base = `${config.controlPlaneUrl.replace(/\/+$/, '')}/api/remote-clients/${config.clientId}/tasks/${encodeURIComponent(taskId)}/workspace`;
  const current = await listLocal(mirror.dir);
  let pushed = 0;
  for (const rel of current) {
    const local = safeLocal(mirror.dir, rel);
    if (!local) continue;
    const stat = await fsp.stat(local).catch(() => null);
    if (!stat) continue;
    const prior = mirror.baseline.get(rel);
    // Only push new files or ones whose size/mtime changed (don't re-upload untouched).
    if (prior && prior.size === stat.size && prior.mtimeMs >= Math.round(stat.mtimeMs)) continue;
    const data = await fsp.readFile(local).catch(() => null);
    if (!data) continue;
    const res = await fetch(`${base}/file?path=${encodeURIComponent(rel)}`, {
      method: 'PUT',
      headers: { ...headers(config), 'content-type': 'application/octet-stream' },
      body: data,
    });
    if (res.ok) pushed += 1;
  }
  return pushed;
}

/** Lists workspace-relative file paths in the local mirror. */
async function listLocal(dir: string): Promise<string[]> {
  const root = resolve(dir);
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries: import('fs').Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = resolve(current, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) out.push(abs.slice(root.length + 1).split(sep).join('/'));
    }
  };
  await walk(root);
  return out;
}
