'use strict';
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Content storage: copy the finished story MP4 into the local content folder (source of truth) + best-effort upload to the configured Google Drive folder, with a sidecar manifest.
 */
/**
 * @description Content storage — where finished story videos land.
 *
 * Two tiers, both honest about what actually happened:
 *   1. LOCAL content folder (VIDS_CONTENT_DIR, default ~/.oshal-vids/content):
 *      always written — the reliable source of truth, organised by pack.
 *   2. Google Drive (the operator's chosen target): best-effort via src/storage/
 *      drive.js. If no Drive token is configured yet, the copy stays local and the
 *      result reports drivePending — nothing is faked.
 *
 * A sidecar `<file>.json` manifest records title/pack/moral/drive link so the
 * content folder is self-describing and the creative bot can list what it made.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { uploadToDrive } = require('./drive');

/** @description Resolve the local content root. @returns {string} absolute content dir */
function contentDir() {
  return process.env.VIDS_CONTENT_DIR || path.join(os.homedir(), '.oshal-vids', 'content');
}

/**
 * @description Persist a finished story: local copy (always) + Drive (best-effort) + manifest.
 * @param {string} file absolute path of the finished story MP4
 * @param {{pack?:string, id?:string, title?:string, moral?:string, filename?:string, sceneCount?:number, mode?:string, driveFolderId?:string}} meta story metadata for the manifest + naming
 * @returns {Promise<{ok:boolean, localPath?:string, manifestPath?:string, drive:object, drivePending:boolean, error?:string}>} storage result
 */
async function saveStory(file, meta = {}) {
  if (!file || !fs.existsSync(file)) return { ok: false, drive: {}, drivePending: true, error: `story file not found: ${file}` };
  const pack = meta.pack || 'stories';
  const filename = meta.filename || path.basename(file);
  const destDir = path.join(contentDir(), pack);
  fs.mkdirSync(destDir, { recursive: true });
  const localPath = path.join(destDir, filename);

  try {
    if (path.resolve(file) !== path.resolve(localPath)) fs.copyFileSync(file, localPath);
  } catch (err) {
    return { ok: false, drive: {}, drivePending: true, error: `local copy failed: ${String((err && err.message) || err)}` };
  }

  // Best-effort Drive upload — never blocks the local save.
  let drive = {};
  let drivePending = true;
  try {
    drive = await uploadToDrive(localPath, { name: filename, folderId: meta.driveFolderId });
    drivePending = !(drive && drive.uploaded);
  } catch (err) {
    drive = { ok: false, uploaded: false, error: String((err && err.message) || err) };
    drivePending = true;
  }

  const manifest = {
    id: meta.id || null,
    title: meta.title || null,
    pack,
    moral: meta.moral || null,
    sceneCount: meta.sceneCount || null,
    mode: meta.mode || null,
    file: localPath,
    bytes: fs.existsSync(localPath) ? fs.statSync(localPath).size : null,
    drive: drive && drive.uploaded ? { id: drive.id, webViewLink: drive.webViewLink } : null,
    drivePending,
    createdAt: new Date().toISOString(),
  };
  const manifestPath = localPath.replace(/\.mp4$/i, '') + '.json';
  try { fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2)); } catch { /* non-fatal */ }

  return { ok: true, localPath, manifestPath, drive, drivePending };
}

/**
 * @description Ids of stories already produced + stored (a manifest exists). The
 * cycler skips these; a failed run leaves no manifest, so it's retried next cycle.
 * @returns {Set<string>} produced library ids
 */
function producedIds() {
  const root = contentDir();
  const ids = new Set();
  let packs = [];
  try { packs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return ids; }
  for (const pack of packs) {
    let files = [];
    try { files = fs.readdirSync(path.join(root, pack)).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      try { const m = JSON.parse(fs.readFileSync(path.join(root, pack, f), 'utf8')); if (m && m.id) ids.add(m.id); } catch { /* skip */ }
    }
  }
  return ids;
}

/**
 * @description List produced stories (newest first) from their manifests.
 * @param {number} [limit] max entries
 * @returns {object[]} manifest records
 */
function listProduced(limit = 100) {
  const root = contentDir();
  const out = [];
  let packs = [];
  try { packs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
  for (const pack of packs) {
    let files = [];
    try { files = fs.readdirSync(path.join(root, pack)).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      try { out.push(JSON.parse(fs.readFileSync(path.join(root, pack, f), 'utf8'))); } catch { /* skip */ }
    }
  }
  return out.sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? 1 : -1)).slice(0, limit);
}

module.exports = { saveStory, contentDir, producedIds, listProduced };
