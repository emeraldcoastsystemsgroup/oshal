/**
 * Veo smoke test — proves the Video Studio's generation path end-to-end against the
 * operator's real GCP project: mint a service-account token, call Veo predictLongRunning,
 * poll the operation, and write the returned clip to disk. Mirrors
 * src/features/video-generation/services/veo-client.ts (kept dependency-free so it runs
 * with plain `node`).
 *
 * Usage:
 *   node scripts/video-veo-smoke.mjs ["a prompt"] [durationSec] [aspectRatio]
 * Env (reads the same vars as the app; defaults match .env):
 *   GOOGLE_APPLICATION_CREDENTIALS (default ./config-seed/vertex-service-account.json)
 *   VERTEX_PROJECT / GCP_PROJECT_ID, VERTEX_LOCATION, VERTEX_VEO_MODEL
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial Veo single-clip smoke test for the Video Studio.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

const KEY_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || './config-seed/vertex-service-account.json';
const PROJECT = process.env.VERTEX_PROJECT || process.env.GCP_PROJECT_ID || 'tactical-gate-256211';
const LOCATION = process.env.VERTEX_LOCATION || process.env.GCP_LOCATION || 'us-central1';
const MODEL = process.env.VERTEX_VEO_MODEL || 'veo-3.1-generate-001';
const PROMPT = process.argv[2] || 'A futuristic muscle-cat bakes a cake over a campfire, cinematic, vertical, funny.';
const DURATION = Number(process.argv[3] || 6);
const ASPECT = process.argv[4] || '9:16';

const b64url = (x) => Buffer.from(x).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}`;

async function token() {
  const k = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: k.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: k.token_uri, iat: now, exp: now + 3600 };
  const si = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claim))}`;
  const sig = b64url(crypto.createSign('RSA-SHA256').update(si).sign(k.private_key));
  const r = await fetch(k.token_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${si}.${sig}` }) });
  const j = await r.json();
  if (!j.access_token) throw new Error('token exchange failed: ' + JSON.stringify(j));
  return j.access_token;
}

async function main() {
  console.log(`[veo-smoke] project=${PROJECT} location=${LOCATION} model=${MODEL} duration=${DURATION}s aspect=${ASPECT}`);
  const t = await token();
  console.log('[veo-smoke] SA token minted');

  const startBody = { instances: [{ prompt: PROMPT }], parameters: { durationSeconds: DURATION, aspectRatio: ASPECT, sampleCount: 1, generateAudio: false } };
  const startRes = await fetch(`${base}:predictLongRunning`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify(startBody) });
  const startText = await startRes.text();
  if (!startRes.ok) throw new Error(`predictLongRunning ${startRes.status}: ${startText.slice(0, 500)}`);
  const op = JSON.parse(startText).name;
  console.log('[veo-smoke] operation started:', op);

  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    await sleep(6000);
    const pr = await fetch(`${base}:fetchPredictOperation`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ operationName: op }) });
    const pj = await pr.json();
    if (pj.error) throw new Error('operation error: ' + JSON.stringify(pj.error));
    if (pj.done) {
      const vid = pj.response?.videos?.[0];
      if (!vid?.bytesBase64Encoded) throw new Error('done but no inline bytes: ' + JSON.stringify(pj).slice(0, 500));
      const out = `veo-smoke-${Date.now()}.mp4`;
      fs.writeFileSync(out, Buffer.from(vid.bytesBase64Encoded, 'base64'));
      console.log(`[veo-smoke] ✅ SUCCESS — wrote ${out} (${fs.statSync(out).size} bytes)`);
      return;
    }
    console.log('[veo-smoke] still generating…');
  }
  throw new Error('timed out');
}

main().catch((e) => { console.error('[veo-smoke] ❌', e.message); process.exit(1); });
