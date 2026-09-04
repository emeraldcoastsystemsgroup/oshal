/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-137 amendment A guard for the satellite half: only codex/claude are pushable, only their exact vendor file shapes leave the machine, a public plain-http swarm is refused, a finished browser login is detected from the file the CLI writes, and every swarm answer (adopted / sign in / not operator / not demo / read-only mount / bad shape) classifies to the reason the Config screen shows.
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
  it('pushes only the two vendor logins, from the files their CLIs write, to their import routes', () => {
    expect(isPushableLogin('codex')).toBe(true);
    expect(isPushableLogin('claude')).toBe(true);
    for (const other of ['gcloud', 'aws', '', undefined, 42]) expect(isPushableLogin(other)).toBe(false);
    expect(loginFilePath('C:\\Users\\user\\', 'codex')).toBe('C:\\Users\\user/.codex/auth.json');
    expect(loginFilePath('/home/user', 'claude')).toBe('/home/user/.claude/.credentials.json');
    expect(LOGIN_TARGETS.codex.importPath).toBe('/api/openai-codex/oauth/import');
    expect(LOGIN_TARGETS.claude.importPath).toBe('/api/claude-code/auth/import');
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

    expect(parseLoginFile('codex', JSON.stringify(claude))).toMatchObject({ ok: false });
    expect(parseLoginFile('claude', JSON.stringify(codex))).toMatchObject({ ok: false });
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
  });

  it('classifies every swarm answer to the reason the Config screen shows', () => {
    expect(classifyPushResponse(200, { success: true, email: 'op@example.com' })).toMatchObject({ ok: true, email: 'op@example.com' });
    expect(classifyPushResponse(200, { success: true, imported: true })).toMatchObject({ ok: true });
    expect(classifyPushResponse(401, null)).toMatchObject({ ok: false, needsSignIn: true, reason: 'sign_in_required' });
    expect(classifyPushResponse(403, { error: 'Forbidden' })).toMatchObject({ ok: false, refused: true, reason: 'not_operator' });
    const notDemo = classifyPushResponse(409, { error: 'credential_distribution_disabled_pending_versioned_revocation_rail' });
    expect(notDemo).toMatchObject({ ok: false, refused: true, reason: 'credential_distribution_disabled_pending_versioned_revocation_rail' });
    expect(notDemo.detail).toContain('DEMO_MODE');
    const readOnly = classifyPushResponse(409, { error: 'claude_credentials_path_read_only', hint: 'Set CLAUDE_AUTH_MOUNT_MODE=rw' });
    expect(readOnly).toMatchObject({ ok: false, refused: true, detail: 'Set CLAUDE_AUTH_MOUNT_MODE=rw' });
    expect(classifyPushResponse(400, { error: 'claude_login_file_invalid', detail: 'no token' })).toMatchObject({ ok: false, refused: false, reason: 'claude_login_file_invalid', detail: 'no token' });
    expect(classifyPushResponse(502, 'not json')).toMatchObject({ ok: false, reason: 'http_502' });
    expect(classifyPushResponse(200, { success: false, error: 'x' })).toMatchObject({ ok: false });
  });
});
