'use strict';
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Google Drive uploader: resolve a drive-scoped token (env access token or refresh-token creds file) and resumable-upload the finished story MP4 into a target folder.
 */
/**
 * @description Google Drive v3 uploader for finished story videos.
 *
 * The connection OSHAL holds today has `gmail.send` but NOT `drive` scope
 * (ADR-074), so this module resolves a Drive token independently:
 *   1. VIDS_DRIVE_ACCESS_TOKEN — a ready access token (simplest for the node), or
 *   2. a creds file (VIDS_DRIVE_CREDS, default ~/.oshal-vids/drive-creds.json)
 *      holding { client_id, client_secret, refresh_token } — exchanged for an
 *      access token at the Google token endpoint.
 * When neither is present, upload is SKIPPED (the caller keeps the local copy and
 * reports drivePending) — never a fabricated success. The clean long-term path is
 * to add `drive.file` scope to the OSHAL Google connector and broker the token.
 *
 * Uses resumable upload (metadata → session URI → PUT bytes) so multi-scene MP4s
 * larger than the 5MB simple-upload limit succeed.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const RESUMABLE_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink';

/**
 * @description Resolve a Drive OAuth access token, or null if none is configured.
 * @returns {Promise<string|null>} bearer access token, or null when unavailable
 */
async function resolveAccessToken() {
  if (process.env.VIDS_DRIVE_ACCESS_TOKEN) return process.env.VIDS_DRIVE_ACCESS_TOKEN.trim();
  const credsPath = process.env.VIDS_DRIVE_CREDS || path.join(os.homedir(), '.oshal-vids', 'drive-creds.json');
  if (!fs.existsSync(credsPath)) return null;
  let creds;
  try { creds = JSON.parse(fs.readFileSync(credsPath, 'utf8')); } catch { return null; }
  const { client_id, client_secret, refresh_token } = creds || {};
  if (!client_id || !client_secret || !refresh_token) return null;
  const body = new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' });
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) throw new Error(`Drive token refresh HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const json = await res.json();
  if (!json.access_token) throw new Error('Drive token refresh returned no access_token');
  return json.access_token;
}

/**
 * @description Upload one file to Drive (resumable) into an optional folder.
 * @param {string} file absolute path of the MP4 to upload
 * @param {{name?:string, folderId?:string, token?:string, mimeType?:string}} [opts] upload options
 * @returns {Promise<{ok:boolean, uploaded:boolean, id?:string, name?:string, webViewLink?:string, reason?:string, error?:string}>} result
 */
async function uploadToDrive(file, opts = {}) {
  if (!fs.existsSync(file)) return { ok: false, uploaded: false, error: `file not found: ${file}` };
  let token;
  try { token = opts.token || (await resolveAccessToken()); }
  catch (err) { return { ok: false, uploaded: false, error: String((err && err.message) || err) }; }
  if (!token) {
    return { ok: true, uploaded: false, reason: 'no Drive token (set VIDS_DRIVE_ACCESS_TOKEN or ~/.oshal-vids/drive-creds.json, or add drive.file scope to the Google connector)' };
  }

  const name = opts.name || path.basename(file);
  const folderId = opts.folderId || process.env.VIDS_DRIVE_FOLDER_ID || null;
  const mimeType = opts.mimeType || 'video/mp4';
  const metadata = { name, mimeType };
  if (folderId) metadata.parents = [folderId];

  // 1. Start a resumable session.
  const start = await fetch(RESUMABLE_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType },
    body: JSON.stringify(metadata),
  });
  if (!start.ok) return { ok: false, uploaded: false, error: `Drive resumable start HTTP ${start.status}: ${(await start.text().catch(() => '')).slice(0, 200)}` };
  const session = start.headers.get('location');
  if (!session) return { ok: false, uploaded: false, error: 'Drive resumable start returned no session URI' };

  // 2. PUT the bytes.
  const bytes = fs.readFileSync(file);
  const put = await fetch(session, { method: 'PUT', headers: { 'content-type': mimeType, 'content-length': String(bytes.length) }, body: bytes });
  if (!put.ok) return { ok: false, uploaded: false, error: `Drive upload HTTP ${put.status}: ${(await put.text().catch(() => '')).slice(0, 200)}` };
  const info = await put.json().catch(() => ({}));
  return { ok: true, uploaded: true, id: info.id, name: info.name || name, webViewLink: info.webViewLink };
}

module.exports = { resolveAccessToken, uploadToDrive };
