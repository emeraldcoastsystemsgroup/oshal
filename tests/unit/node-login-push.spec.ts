/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-137 amendment A guard for the satellite half: only codex/claude are pushable, only their exact vendor file shapes leave the machine, a public plain-http swarm is refused, a finished browser login is detected from the file the CLI writes, and every swarm answer (adopted / sign in / not operator / not demo / read-only mount / bad shape) classifies to the reason the Config screen shows.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Google (Gemini) joins the pushable set: the row resolves to .gemini/oauth_creds.json and /api/gemini/auth/import, its google-auth-library shape is accepted, no vendor's file passes as another's in EITHER direction, an access token with no refresh token is refused, and the swarm's two Gemini-specific 409s classify to the sentence the Config screen shows. gcloud stays unpushable on purpose - it is the row below gemini in the account list and writes an ADC file the swarm does not consume.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The Google row is DORMANT, and this guard now pins that rather than its pushability. Measured on the operator's box 2026-09-22: the CLI's "Sign in with Google" answers "This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products", so oauth_creds.json cannot be produced by a sign-in and a push button on that row would have nothing to send. What is asserted is the SHAPE of that dormancy: the target, its file, its import path and its accepted vendor shape are all still there and still correct (reviving it is deleting one block), while isPushableLogin refuses it - and it refuses it by reading the table, which is why the last case flips the flag and watches the answer change.
 */

import { describe, expect, it } from 'vitest';
import {
  LOGIN_TARGETS,
  classifyPushResponse,
  importRequestBody,
  isPushableLogin,
  loginFileChanged,
  loginFilePath,
  parseLoginFile,
  swarmBaseUrl,
} from '../../packages/oshal-chat/src/main/login-push-core';

describe('@oshal/chat login push — what may leave the machine, and where', () => {
  it('pushes the three live vendor logins to their import routes', () => {
    expect(isPushableLogin('codex')).toBe(true);
    expect(isPushableLogin('claude')).toBe(true);
    expect(isPushableLogin('antigravity')).toBe(true);
    // Google is a KNOWN target that is not pushable: the vendor retired the sign-in that writes
    // its file, so the row keeps everything except the button. See the dormant block below.
    expect(isPushableLogin('gemini')).toBe(false);
    // gcloud signs into Google CLOUD and writes an ADC file the swarm does not consume — it sits
    // one row below gemini in the account list and must never be mistaken for it.
    for (const other of ['gcloud', 'aws', '', undefined, 42]) expect(isPushableLogin(other)).toBe(false);
    expect(loginFilePath('C:\\Users\\user\\', 'codex')).toBe('C:\\Users\\user/.codex/auth.json');
    expect(loginFilePath('/home/user', 'claude')).toBe('/home/user/.claude/.credentials.json');
    expect(loginFilePath('/home/user', 'gemini')).toBe('/home/user/.gemini/oauth_creds.json');
    expect(loginFilePath('/home/user', 'antigravity')).toBe('/home/user/.gemini/antigravity-cli/antigravity-oauth-token');
    expect(LOGIN_TARGETS.codex.importPath).toBe('/api/openai-codex/oauth/import');
    expect(LOGIN_TARGETS.claude.importPath).toBe('/api/claude-code/auth/import');
    expect(LOGIN_TARGETS.gemini.importPath).toBe('/api/gemini/auth/import');
    expect(LOGIN_TARGETS.gemini.statusPath).toBe('/api/gemini/auth/status');
    expect(LOGIN_TARGETS.antigravity.importPath).toBe('/api/antigravity/auth/import');
    expect(LOGIN_TARGETS.antigravity.statusPath).toBe('/api/antigravity/auth/status');
    // The file name is the vendor's, read from the installed @google/gemini-cli bundle
    // (packages/core/src/config/storage.ts: OAUTH_FILE = "oauth_creds.json" under ~/.gemini).
    expect(LOGIN_TARGETS.gemini.file).toBe('.gemini/oauth_creds.json');
  });

  it('keeps the Google target intact while it is dormant, and reads pushability off that flag', () => {
    // Dormancy is a statement about the VENDOR, so the reason travels with the row rather than
    // living in a comment somewhere: whoever revives it should see why it was parked.
    expect(LOGIN_TARGETS.gemini.dormant?.since).toBe('2026-09-22');
    expect(LOGIN_TARGETS.gemini.dormant?.reason).toContain('no longer supported for Gemini Code Assist for individuals');
    expect(LOGIN_TARGETS.codex.dormant).toBeUndefined();
    expect(LOGIN_TARGETS.claude.dormant).toBeUndefined();
    expect(LOGIN_TARGETS.antigravity.dormant).toBeUndefined();

    // The predicate DERIVES its answer from the table, so deleting the dormant block is the whole
    // revival. Proven by doing exactly that to the live record and watching the answer flip —
    // if a second list were the real gate, this would stay false.
    const row = LOGIN_TARGETS.gemini as { dormant?: unknown };
    const parked = row.dormant;
    try {
      delete row.dormant;
      expect(isPushableLogin('gemini')).toBe(true);
    } finally {
      row.dormant = parked;
    }
    expect(isPushableLogin('gemini')).toBe(false);
    // An id that is not a target at all is still refused — dormancy is not the only gate.
    expect(isPushableLogin('gemini-but-not-a-target')).toBe(false);
  });

  it('prefers the cockpit origin (where the OIDC cookie lives) and refuses plain http to a public host', () => {
    expect(swarmBaseUrl({ cockpitBaseUrl: 'https://oshal.example.com/', controlPlaneUrl: 'http://192.168.50.20:35457' }))
      .toEqual({ ok: true, url: 'https://oshal.example.com' });
    expect(swarmBaseUrl({ controlPlaneUrl: 'http://192.168.50.20:35457/' })).toEqual({ ok: true, url: 'http://192.168.50.20:35457' });
    expect(swarmBaseUrl({ controlPlaneUrl: 'http://localhost:35457' })).toMatchObject({ ok: true });
    expect(swarmBaseUrl({ controlPlaneUrl: 'http://swarm.local:35457' })).toMatchObject({ ok: true });
    expect(swarmBaseUrl({ controlPlaneUrl: 'http://oshal.example.com' })).toMatchObject({ ok: false, reason: 'plain_http_public' });
    expect(swarmBaseUrl({ controlPlaneUrl: 'http://8.8.8.8' })).toMatchObject({ ok: false, reason: 'plain_http_public' });
    expect(swarmBaseUrl({})).toMatchObject({ ok: false, reason: 'no_swarm_url' });
    expect(swarmBaseUrl({ controlPlaneUrl: 'ftp://x' })).toMatchObject({ ok: false, reason: 'bad_swarm_url' });
    expect(swarmBaseUrl({ controlPlaneUrl: 'not a url' })).toMatchObject({ ok: false, reason: 'bad_swarm_url' });
  });

  it('accepts exactly the vendor shapes and shapes each import body the way its route reads it', () => {
    const codex = { auth_mode: 'chatgpt', tokens: { access_token: 'a', refresh_token: 'r', id_token: 'i' } };
    const claude = { claudeAiOauth: { accessToken: 'sk-ant-oat01', refreshToken: 'sk-ant-ort01', expiresAt: 1 } };
    expect(parseLoginFile('codex', JSON.stringify(codex))).toEqual({ ok: true, body: codex });
    expect(parseLoginFile('claude', JSON.stringify(claude))).toEqual({ ok: true, body: claude });
    expect(importRequestBody('codex', codex)).toEqual({ authJson: codex });
    expect(importRequestBody('claude', claude)).toEqual({ credentials: claude });

    const gemini = { access_token: 'ya29.x', refresh_token: '1//y', token_type: 'Bearer', expiry_date: 1 };
    expect(parseLoginFile('gemini', JSON.stringify(gemini))).toEqual({ ok: true, body: gemini });
    expect(importRequestBody('gemini', gemini)).toEqual({ credentials: gemini });

    const antigravity = {
      token: { access_token: 'agy-access', refresh_token: 'agy-refresh', token_type: 'Bearer', expiry: '2026-09-23T00:00:00Z' },
      auth_method: 'oauth-personal',
      id_token: 'agy-id',
    };
    expect(parseLoginFile('antigravity', JSON.stringify(antigravity))).toEqual({ ok: true, body: antigravity });
    expect(importRequestBody('antigravity', antigravity)).toEqual({ credentials: antigravity });

    expect(parseLoginFile('codex', JSON.stringify(claude))).toMatchObject({ ok: false });
    expect(parseLoginFile('claude', JSON.stringify(codex))).toMatchObject({ ok: false });
    expect(parseLoginFile('gemini', JSON.stringify(codex))).toMatchObject({ ok: false });
    expect(parseLoginFile('gemini', JSON.stringify(claude))).toMatchObject({ ok: false });
    expect(parseLoginFile('claude', JSON.stringify(gemini))).toMatchObject({ ok: false });
    expect(parseLoginFile('antigravity', JSON.stringify(codex))).toMatchObject({ ok: false });
    expect(parseLoginFile('antigravity', JSON.stringify(claude))).toMatchObject({ ok: false });
    expect(parseLoginFile('antigravity', JSON.stringify(gemini))).toMatchObject({ ok: false });
    expect(parseLoginFile('claude', JSON.stringify(antigravity))).toMatchObject({ ok: false });
    expect(parseLoginFile('antigravity', JSON.stringify({ ...antigravity, id_token: '' }))).toMatchObject({ ok: false });
    // NOT asserted, and deliberately: parseLoginFile('codex', <a gemini file>) returns ok. The
    // codex arm reads `body.tokens ?? body`, so it accepts a bare {access_token, refresh_token}
    // object, and a google-auth-library credential is exactly that shape. It is a shape check,
    // not a routing decision — pushLoginToSwarm reads the file from loginFilePath(homedir(), id)
    // and parses it with the SAME id, so no push can reach the codex arm carrying a gemini file.
    // Left alone rather than tightened: narrowing the codex arm would risk a real codex login
    // shape this spec cannot see, for a confusion the caller cannot produce.
    // An access token alone expires within the hour — refused rather than adopted and found dead.
    expect(parseLoginFile('gemini', '{"access_token":"ya29.x"}')).toMatchObject({ ok: false });
    expect(parseLoginFile('gemini', '{"access_token":"","refresh_token":"1//y"}')).toMatchObject({ ok: false });
    expect(parseLoginFile('gemini', 'AIzaSyBareApiKey')).toMatchObject({ ok: false });
    expect(parseLoginFile('codex', '{"tokens":{}}')).toMatchObject({ ok: false });
    expect(parseLoginFile('claude', '{"claudeAiOauth":{"accessToken":""}}')).toMatchObject({ ok: false });
    expect(parseLoginFile('claude', 'garbage')).toMatchObject({ ok: false });
    expect(parseLoginFile('codex', '[]')).toMatchObject({ ok: false });
  });

  it('detects a finished browser login from the file the CLI writes', () => {
    const absent = { present: false, mtimeMs: 0, size: 0 };
    const first = { present: true, mtimeMs: 100, size: 900 };
    expect(loginFileChanged(absent, absent)).toBe(false);
    expect(loginFileChanged(absent, first)).toBe(true);
    expect(loginFileChanged(first, first)).toBe(false);
    expect(loginFileChanged(first, { ...first, mtimeMs: 200 })).toBe(true);
    expect(loginFileChanged(first, { ...first, size: 901 })).toBe(true);
    expect(loginFileChanged(first, absent)).toBe(false);
    expect(loginFileChanged(
      { present: true, mtimeMs: 0, size: 100, fingerprint: 'before' },
      { present: true, mtimeMs: 0, size: 100, fingerprint: 'after' },
    )).toBe(true);
    expect(loginFileChanged(
      { present: true, mtimeMs: 0, size: 100, fingerprint: 'same' },
      { present: true, mtimeMs: 0, size: 100, fingerprint: 'same' },
    )).toBe(false);
  });

  it('classifies every swarm answer to the reason the Config screen shows', () => {
    expect(classifyPushResponse(200, { success: true, email: 'op@example.com' })).toMatchObject({ ok: true, email: 'op@example.com' });
    expect(classifyPushResponse(200, { success: true, imported: true })).toMatchObject({ ok: true });
    expect(classifyPushResponse(401, null)).toMatchObject({ ok: false, needsSignIn: true, reason: 'sign_in_required' });
    expect(classifyPushResponse(403, { error: 'Forbidden' })).toMatchObject({ ok: false, refused: true, reason: 'not_operator' });
    const notDemo = classifyPushResponse(409, { error: 'credential_distribution_disabled_pending_versioned_revocation_rail' });
    expect(notDemo).toMatchObject({ ok: false, refused: true, reason: 'credential_distribution_disabled_pending_versioned_revocation_rail' });
    expect(notDemo.detail).toContain('DEMO_MODE');
    const geminiReadOnly = classifyPushResponse(409, { error: 'gemini_credentials_path_read_only' });
    expect(geminiReadOnly.detail).toContain('GEMINI_AUTH_MOUNT_MODE=rw');
    const geminiUnset = classifyPushResponse(409, { error: 'gemini_credentials_path_unset' });
    expect(geminiUnset.detail).toContain('GEMINI_OAUTH_CREDS_PATH');
    const antigravityReadOnly = classifyPushResponse(409, { error: 'antigravity_credentials_path_read_only' });
    expect(antigravityReadOnly.detail).toContain('GEMINI_AUTH_MOUNT_MODE=rw');
    const antigravityUnset = classifyPushResponse(409, { error: 'antigravity_credentials_path_unset' });
    expect(antigravityUnset.detail).toContain('ANTIGRAVITY_OAUTH_TOKEN_PATH');
    expect(classifyPushResponse(400, { error: 'gemini_login_file_invalid', detail: 'no refresh token' }))
      .toMatchObject({ ok: false, refused: false, reason: 'gemini_login_file_invalid', detail: 'no refresh token' });
    const readOnly = classifyPushResponse(409, { error: 'claude_credentials_path_read_only', hint: 'Set CLAUDE_AUTH_MOUNT_MODE=rw' });
    expect(readOnly).toMatchObject({ ok: false, refused: true, detail: 'Set CLAUDE_AUTH_MOUNT_MODE=rw' });
    expect(classifyPushResponse(400, { error: 'claude_login_file_invalid', detail: 'no token' })).toMatchObject({ ok: false, refused: false, reason: 'claude_login_file_invalid', detail: 'no token' });
    expect(classifyPushResponse(502, 'not json')).toMatchObject({ ok: false, reason: 'http_502' });
    expect(classifyPushResponse(200, { success: false, error: 'x' })).toMatchObject({ ok: false });
  });
});
