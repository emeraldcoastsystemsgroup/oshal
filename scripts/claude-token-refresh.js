/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — host-side refresh of the operator's OWN Claude Code OAuth token (BACKLOG 2026-07-09). Mirrors the repo's existing token-endpoint flow (claude-code-auth-service.ts: same https://claude.ai/oauth/token endpoint + CLI client id), but with grant_type=refresh_token. Needed because the CLI only refreshes a token it finds expired — it will not proactively rotate a valid one — so idle/overnight gaps left every ro-mounted container 401ing until the next interactive session. Atomic write (tmp+rename), preserves all other credential fields. Run by scripts/claude-token-keepalive.ps1 (scheduled 2-hourly).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Must match the Claude Code CLI's registered OAuth client (same client id as
// src/features/claude-code-auth/services/claude-code-auth-service.ts). The refresh
// grant lives on the console token endpoint (JSON body); claude.ai (form-encoded)
// is the code-exchange endpoint and 403s refresh grants — kept as a fallback.
const CLIENT_ID = process.env.ANTHROPIC_OAUTH_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ENDPOINTS = [
  { url: 'https://console.anthropic.com/v1/oauth/token', json: true },
  { url: 'https://claude.ai/oauth/token', json: false },
];

const credPath = path.join(os.homedir(), '.claude', '.credentials.json');

async function tryRefresh(endpoint, refreshToken) {
  const fields = { grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: refreshToken };
  const response = await fetch(endpoint.url, {
    method: 'POST',
    headers: endpoint.json
      ? { 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: endpoint.json ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok && Boolean(payload.access_token), status: response.status, payload };
}

async function main() {
  const raw = fs.readFileSync(credPath, 'utf8');
  const creds = JSON.parse(raw);
  const oauth = creds.claudeAiOauth;
  if (!oauth || !oauth.refreshToken) {
    console.error('no claudeAiOauth.refreshToken in credentials file');
    process.exitCode = 1;
    return;
  }

  const hoursLeft = ((oauth.expiresAt - Date.now()) / 3.6e6).toFixed(2);
  let result = null;
  for (const endpoint of ENDPOINTS) {
    result = await tryRefresh(endpoint, oauth.refreshToken);
    if (result.ok) break;
    console.error(`refresh via ${endpoint.url} failed (${result.status}) — trying next`);
  }
  if (!result || !result.ok) {
    console.error(`refresh failed on all endpoints (last status ${result ? result.status : 'n/a'})`);
    process.exitCode = 1;
    return;
  }
  const payload = result.payload;

  // Preserve every other field (scopes, subscriptionType, …); rotate only the tokens.
  const next = {
    ...creds,
    claudeAiOauth: {
      ...oauth,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || oauth.refreshToken,
      expiresAt: Date.now() + Number(payload.expires_in || 28800) * 1000,
    },
  };

  // Atomic write so concurrent readers (active sessions + ro-mounted containers)
  // never see a torn file.
  const tmp = `${credPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(tmp, credPath);

  const newHours = ((next.claudeAiOauth.expiresAt - Date.now()) / 3.6e6).toFixed(2);
  console.log(`refreshed: ${hoursLeft}h -> ${newHours}h left`);
}

main().catch((err) => { console.error(err.message || String(err)); process.exitCode = 1; });
