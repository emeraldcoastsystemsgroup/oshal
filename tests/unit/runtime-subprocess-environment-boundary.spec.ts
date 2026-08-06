/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the app-store install, update install, fare-watch Duffel, and Google Workspace CLI child-process environments against controller/database/session and unrelated provider credential inheritance.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildRemoteAppInstallerProcessEnv } from '../../src/app/routes/app-store-remote';
import { buildTravelFarewatchProcessEnv } from '../../src/app/routes/travel-farewatch';
import { buildUpdateInstallerProcessEnv } from '../../src/app/routes/update-check-cron';
import { buildGoogleWorkspaceCliProcessEnv } from '../../src/features/tool-integrations/google-workspace-cli-integration';

const AMBIENT_SENTINELS: NodeJS.ProcessEnv = {
  PATH: '/runtime/bin',
  Path: 'C:\\runtime',
  TEMP: '/runtime/tmp',
  LANG: 'en_US.UTF-8',
  HTTPS_PROXY: 'http://proxy.example',
  NODE_EXTRA_CA_CERTS: '/runtime/ca.pem',
  NODE_USE_ENV_PROXY: '1',
  DATABASE_URL: 'controller-database-sentinel',
  SESSION_SECRET: 'controller-session-sentinel',
  SWARM_SERVICE_SECRET: 'controller-service-sentinel',
  ANTHROPIC_API_KEY: 'anthropic-provider-sentinel',
  OPENAI_API_KEY: 'openai-provider-sentinel',
  AWS_SECRET_ACCESS_KEY: 'cloud-provider-sentinel',
  DUFFEL_ACCESS_TOKEN: 'ambient-duffel-sentinel',
  OSHAL_CRED_DUFFEL: 'ambient-broker-sentinel',
  OSHAL_STORE_TOKEN: 'ambient-store-sentinel',
  GITHUB_TOKEN: 'ambient-github-sentinel',
  HOME: '/ambient/home',
  USERPROFILE: 'C:\\ambient-home',
  APPDATA: 'C:\\ambient-appdata',
  LOCALAPPDATA: 'C:\\ambient-localappdata',
};

const FORBIDDEN_KEYS = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'SWARM_SERVICE_SECRET',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
] as const;

const PROBE_KEYS = [
  ...FORBIDDEN_KEYS,
  'GITHUB_TOKEN',
  'OSHAL_STORE_TOKEN',
  'DUFFEL_ACCESS_TOKEN',
  'OSHAL_CRED_DUFFEL',
  'OSHAL_USER_SUB',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'OSHAL_GOOGLE_WORKSPACE_HOME',
  'OSHAL_AGENT_ID',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'GOOGLE_TOKEN_CACHE',
] as const;

function expectControllerSentinelsAbsent(env: NodeJS.ProcessEnv): void {
  for (const key of FORBIDDEN_KEYS) expect(env).not.toHaveProperty(key);
}

/** Cross the real child-process boundary and report only the keys this guard audits. */
function probeChildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const script = [
    `const keys = ${JSON.stringify(PROBE_KEYS)};`,
    'const visible = Object.fromEntries(keys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));',
    'process.stdout.write(JSON.stringify(visible));',
  ].join('');
  return JSON.parse(execFileSync(process.execPath, ['-e', script], {
    env,
    encoding: 'utf8',
  })) as NodeJS.ProcessEnv;
}

describe('non-model runtime subprocess environment containment', () => {
  it('gives catalog-pinned remote installs only runtime settings and the resolved store token', () => {
    const env = buildRemoteAppInstallerProcessEnv('exact-store-token', AMBIENT_SENTINELS);

    expect(env).toEqual({
      PATH: '/runtime/bin',
      Path: 'C:\\runtime',
      TEMP: '/runtime/tmp',
      LANG: 'en_US.UTF-8',
      HTTPS_PROXY: 'http://proxy.example',
      NODE_EXTRA_CA_CERTS: '/runtime/ca.pem',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
      OSHAL_STORE_TOKEN: 'exact-store-token',
    });
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expectControllerSentinelsAbsent(env);
    const childEnv = probeChildEnvironment(env);
    expect(childEnv.OSHAL_STORE_TOKEN).toBe('exact-store-token');
    expect(childEnv).not.toHaveProperty('GITHUB_TOKEN');
    expectControllerSentinelsAbsent(childEnv);
  });

  it('gives update installs only runtime settings and the resolved store token', () => {
    const env = buildUpdateInstallerProcessEnv('exact-update-token', AMBIENT_SENTINELS);

    expect(env).toEqual({
      PATH: '/runtime/bin',
      Path: 'C:\\runtime',
      TEMP: '/runtime/tmp',
      LANG: 'en_US.UTF-8',
      HTTPS_PROXY: 'http://proxy.example',
      NODE_EXTRA_CA_CERTS: '/runtime/ca.pem',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
      OSHAL_STORE_TOKEN: 'exact-update-token',
    });
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expectControllerSentinelsAbsent(env);
    const childEnv = probeChildEnvironment(env);
    expect(childEnv.OSHAL_STORE_TOKEN).toBe('exact-update-token');
    expect(childEnv).not.toHaveProperty('GITHUB_TOKEN');
    expectControllerSentinelsAbsent(childEnv);
  });

  it('gives fare-watch only the exact watcher and brokered Duffel token', () => {
    const env = buildTravelFarewatchProcessEnv(
      'watch-owner-exact',
      'duffel_test_exact_operation_token',
      AMBIENT_SENTINELS,
    );

    expect(env).toEqual({
      PATH: '/runtime/bin',
      Path: 'C:\\runtime',
      TEMP: '/runtime/tmp',
      LANG: 'en_US.UTF-8',
      HTTPS_PROXY: 'http://proxy.example',
      NODE_EXTRA_CA_CERTS: '/runtime/ca.pem',
      NODE_USE_ENV_PROXY: '1',
      OSHAL_USER_SUB: 'watch-owner-exact',
      OSHAL_CRED_DUFFEL: 'duffel_test_exact_operation_token',
    });
    expect(env).not.toHaveProperty('DUFFEL_ACCESS_TOKEN');
    expect(env).not.toHaveProperty('OSHAL_STORE_TOKEN');
    expectControllerSentinelsAbsent(env);
    const childEnv = probeChildEnvironment(env);
    expect(childEnv.OSHAL_USER_SUB).toBe('watch-owner-exact');
    expect(childEnv.OSHAL_CRED_DUFFEL).toBe('duffel_test_exact_operation_token');
    expect(childEnv).not.toHaveProperty('DUFFEL_ACCESS_TOKEN');
    expectControllerSentinelsAbsent(childEnv);
  });

  it('isolates Google Workspace to the agent home and exact Google settings', () => {
    const homeDir = path.resolve('scoped-google-home');
    const env = buildGoogleWorkspaceCliProcessEnv({
      agentId: 'google-agent-exact',
      homeDir,
      clientId: 'google-client-exact',
      clientSecret: 'google-secret-exact',
      accountEmail: 'owner@example.test',
      defaultAccount: 'work',
      serviceAccountJson: '{"client_email":"svc@example.test"}',
      serviceAccountSubject: 'owner@example.test',
      redirectPort: '8123',
      scopes: 'scope-one scope-two',
    }, {
      ...AMBIENT_SENTINELS,
      GOOGLE_CLIENT_ID: 'ambient-google-client-sentinel',
      GOOGLE_CLIENT_SECRET: 'ambient-google-secret-sentinel',
      GOOGLE_SERVICE_ACCOUNT_JSON: 'ambient-google-service-sentinel',
      GOOGLE_TOKEN_CACHE: 'ambient-google-token-cache-sentinel',
      GOOGLE_GMAIL_API_BASE_URL: 'http://google-test-endpoint.example',
    });

    expect(env).toMatchObject({
      PATH: '/runtime/bin',
      HTTPS_PROXY: 'http://proxy.example',
      NODE_EXTRA_CA_CERTS: '/runtime/ca.pem',
      NODE_USE_ENV_PROXY: '1',
      HOME: homeDir,
      USERPROFILE: homeDir,
      APPDATA: path.join(homeDir, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(homeDir, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(homeDir, '.config'),
      XDG_CACHE_HOME: path.join(homeDir, '.cache'),
      OSHAL_GOOGLE_WORKSPACE_HOME: homeDir,
      OSHAL_AGENT_ID: 'google-agent-exact',
      GOOGLE_CLIENT_ID: 'google-client-exact',
      GOOGLE_CLIENT_SECRET: 'google-secret-exact',
      GOOGLE_ACCOUNT_EMAIL: 'owner@example.test',
      GOG_ACCOUNT: 'work',
      GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"svc@example.test"}',
      GOOGLE_SERVICE_ACCOUNT_SUBJECT: 'owner@example.test',
      GOOGLE_REDIRECT_PORT: '8123',
      GOOGLE_SCOPES: 'scope-one scope-two',
      GOOGLE_GMAIL_API_BASE_URL: 'http://google-test-endpoint.example',
    });
    expect(env).not.toHaveProperty('GOOGLE_TOKEN_CACHE');
    expect(env).not.toHaveProperty('OSHAL_CRED_DUFFEL');
    expect(env).not.toHaveProperty('OSHAL_STORE_TOKEN');
    expectControllerSentinelsAbsent(env);
    const childEnv = probeChildEnvironment(env);
    expect(childEnv).toMatchObject({
      HOME: homeDir,
      USERPROFILE: homeDir,
      APPDATA: path.join(homeDir, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(homeDir, 'AppData', 'Local'),
      OSHAL_GOOGLE_WORKSPACE_HOME: homeDir,
      OSHAL_AGENT_ID: 'google-agent-exact',
      GOOGLE_CLIENT_ID: 'google-client-exact',
      GOOGLE_CLIENT_SECRET: 'google-secret-exact',
      GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"svc@example.test"}',
    });
    expect(childEnv).not.toHaveProperty('GOOGLE_TOKEN_CACHE');
    expectControllerSentinelsAbsent(childEnv);
  });

  it('keeps every audited call site wired to a restricted builder', () => {
    const filesAndBuilders = [
      ['src/app/routes/app-store-remote.ts', 'buildRemoteAppInstallerProcessEnv(token)'],
      ['src/app/routes/travel-farewatch.ts', 'buildTravelFarewatchProcessEnv(sub, creds.OSHAL_CRED_DUFFEL)'],
      ['src/app/routes/update-check-cron.ts', 'buildUpdateInstallerProcessEnv(token)'],
      ['src/features/tool-integrations/google-workspace-cli-integration.ts', 'buildGoogleWorkspaceCliProcessEnv(this.config)'],
    ] as const;

    for (const [relativePath, builderCall] of filesAndBuilders) {
      const source = fs.readFileSync(path.resolve(relativePath), 'utf8');
      expect(source, relativePath).toContain(builderCall);
      expect(source, relativePath).not.toMatch(/env\s*:\s*\{\s*\.\.\.process\.env/u);
      expect(source, relativePath).not.toMatch(/const\s+\w*[Ee]nv[^=]*=\s*\{\s*\.\.\.process\.env/u);
    }
  });
});
