/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | New. Config secrets survive a save: the real config router over HTTP with a disposable CONFIG_OUTPUT_DIR, CLINE_CONFIG_DIR, HOME and encryption key. A redacted GET posted back keeps every stored secret for POST /api/config, /mcp, /rag, /presentron, /google-search-mcp and /llm; an unresolved placeholder is dropped and reported; Google-numeric and local- sub envelopes never reach global-config.json; a stored '[REDACTED]' reads as absent (env fallback) and the next save removes it; a placeholder never crosses partitions; real values still overwrite.
 * 2   | maintainer@emeraldcoastsystemsgroup.com     | The read-time clean-up warns once per store and set of paths per process (then logs at debug), so a corrupted value that stays until the next save does not repeat a warning on every read.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfigRoutes } from '@/app/routes/config-routes';
import { readGlobalRuntimeSettings } from '@/shared/services/runtime-config-loader';
import { ClineRuntimeConfigSyncService } from '@/features/llm-provider/services';
import { shouldWarnRedactedPlaceholders } from '@/shared/config';

const require = createRequire(import.meta.url);
const { EncryptedConfigManager } = require('../../src/api/encrypted-config-manager.js');
const { decrypt } = require('../../src/api/crypto-utils.js');

const OPERATOR = 'Config-Roundtrip-Operator';
const ENCRYPTION_KEY = 'placeholder-config-roundtrip-encryption-key';
const PLACEHOLDER = '[REDACTED]';
const NUMERIC_SUB = '1234567890123';
const LOCAL_SUB = 'local-0123456789abcdef';

interface SecretsManager {
  loadSecrets(userId?: string | null): Record<string, any>;
  saveSecrets(data: Record<string, unknown>, userId?: string | null): void;
}

interface Harness {
  root: string;
  clineDir: string;
  homeDir: string;
  call: (method: string, route: string, body?: unknown, sub?: string) => Promise<{ status: number; body: any }>;
  secrets: () => SecretsManager;
  rawSecrets: () => Record<string, any>;
  settingsText: () => string;
  settings: () => Record<string, any>;
  readJson: (file: string) => Record<string, any>;
  writeJson: (file: string, data: unknown) => void;
  close: () => Promise<void>;
}

const open: Harness[] = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
  vi.unstubAllEnvs();
});

/** Start the production config router on a real port with every mutable path under one temp root. */
async function startHarness(): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-config-roundtrip-'));
  const clineDir = path.join(root, 'cline');
  const homeDir = path.join(root, 'home');
  vi.stubEnv('OSHAL_OPERATOR_SUBS', OPERATOR);
  vi.stubEnv('ENCRYPTION_KEY', ENCRYPTION_KEY);
  vi.stubEnv('CONFIG_OUTPUT_DIR', root);
  vi.stubEnv('CLINE_CONFIG_DIR', clineDir);
  vi.stubEnv('OPENAI_CODEX_SHARED_SEED_PATH', path.join(root, 'seed', 'secrets.json'));
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('USERPROFILE', homeDir);
  vi.stubEnv('LLM_PROVIDER', '');
  vi.stubEnv('LLM_MODEL', '');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const sub = req.get('x-test-sub');
    if (sub) (req as any).oidc = { isAuthenticated: () => true, user: { sub } };
    next();
  });
  app.use('/api/config', createConfigRoutes());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/config`;
  const readJson = (file: string): Record<string, any> => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const harness: Harness = {
    root,
    clineDir,
    homeDir,
    call: async (method, route, body, sub = OPERATOR) => {
      const response = await fetch(base + route, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-test-sub': sub },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : {} };
    },
    secrets: () => new EncryptedConfigManager(root, ENCRYPTION_KEY) as SecretsManager,
    rawSecrets: () => JSON.parse(decrypt(readJson('secrets.enc.json'), ENCRYPTION_KEY)),
    settingsText: () => fs.readFileSync(path.join(root, 'global-config.json'), 'utf8'),
    settings: () => readJson('global-config.json'),
    readJson,
    writeJson: (file, data) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), JSON.stringify(data, null, 2), 'utf8');
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  open.push(harness);
  return harness;
}

/** GET a route and POST exactly what it returned, the way the config pages save. */
async function roundTrip(h: Harness, route: string, wrap = false): Promise<{ status: number; body: any }> {
  const read = await h.call('GET', route);
  expect(read.status).toBe(200);
  const config = route === '/llm' ? read.body : read.body.config;
  return h.call('POST', route, wrap ? { config } : config);
}

describe('POST /api/config keeps stored secrets when a redacted GET is posted back', () => {
  it('keeps every secret and nested credential across a full GET → POST round trip', async () => {
    const h = await startHarness();
    expect((await h.call('POST', '/', {
      planModeApiProvider: 'anthropic',
      anthropicApiKey: 'placeholder-anthropic-api-key',
      facebookAppSecret: 'placeholder-facebook-app-secret',
      gitToken: 'placeholder-git-token',
      apiKey: 'placeholder-shared-api-key',
      ragServiceConfig: { endpoint: 'http://rag:8000', apiKey: 'placeholder-rag-service-key' },
      toolRuntime: { env: { UNUSUAL_NAME: 'placeholder-env-value' }, label: 'visible' },
    })).status).toBe(200);

    const read = await h.call('GET', '/');
    // GET output is unchanged: credentials are redacted by key name, everything else is visible.
    expect(read.body.config).toEqual({
      planModeApiProvider: 'anthropic',
      anthropicApiKey: PLACEHOLDER,
      facebookAppSecret: PLACEHOLDER,
      gitToken: PLACEHOLDER,
      apiKey: PLACEHOLDER,
      ragServiceConfig: { endpoint: 'http://rag:8000', apiKey: PLACEHOLDER },
      toolRuntime: { env: { UNUSUAL_NAME: PLACEHOLDER }, label: 'visible' },
    });

    const saved = await h.call('POST', '/', read.body.config);
    expect(saved.status).toBe(200);
    expect(h.secrets().loadSecrets()).toEqual({
      anthropicApiKey: 'placeholder-anthropic-api-key',
      facebookAppSecret: 'placeholder-facebook-app-secret',
      gitToken: 'placeholder-git-token',
      apiKey: 'placeholder-shared-api-key',
    });
    expect(h.settings()).toEqual({
      planModeApiProvider: 'anthropic',
      ragServiceConfig: { endpoint: 'http://rag:8000', apiKey: 'placeholder-rag-service-key' },
      toolRuntime: { env: { UNUSUAL_NAME: 'placeholder-env-value' }, label: 'visible' },
    });
    expect(h.settingsText()).not.toContain(PLACEHOLDER);
    expect(JSON.stringify(h.rawSecrets())).not.toContain(PLACEHOLDER);
    expect(saved.body.droppedPlaceholders).toEqual([]);
  });

  it('keeps stored secrets for the partial payloads the /config page and cockpit Settings post', async () => {
    const h = await startHarness();
    await h.call('POST', '/', { apiKey: 'placeholder-shared-api-key', gitToken: 'placeholder-git-token' });
    const saved = await h.call('POST', '/', {
      actModeApiProvider: 'openai',
      planModeApiProvider: 'openai',
      apiKey: PLACEHOLDER,
      gitToken: PLACEHOLDER,
      planeUrl: 'http://plane:3000',
    });
    expect(saved.status).toBe(200);
    expect(h.secrets().loadSecrets()).toEqual({ apiKey: 'placeholder-shared-api-key', gitToken: 'placeholder-git-token' });
    expect(h.settings()).toEqual({ actModeApiProvider: 'openai', planModeApiProvider: 'openai', planeUrl: 'http://plane:3000' });
  });
});

describe('the sibling POSTs keep stored secrets when their redacted GET is posted back', () => {
  it('POST /api/config/mcp keeps MCP env values and credential headers', async () => {
    const h = await startHarness();
    expect((await h.call('POST', '/mcp', {
      mcpServers: {
        demo: {
          command: 'node',
          args: ['server.js'],
          env: {
            ODD_CREDENTIAL_NAME: 'placeholder-mcp-env-secret',
            PLAIN_FLAG: 'placeholder-mcp-plain-flag',
            KEY_LIST: ['placeholder-mcp-list-a', 'placeholder-mcp-list-b'],
          },
          headers: { Authorization: 'Bearer placeholder-mcp-header-token' },
        },
        dockerish: { command: 'docker', env: ['API_TOKEN=placeholder-docker-token', 'MODE=placeholder-docker-mode'] },
      },
    })).status).toBe(200);

    const read = await h.call('GET', '/mcp');
    // Every direct child of env is replaced wholesale, so one placeholder stands for the whole list;
    // a list-shaped env is redacted element by element and resolves by index.
    expect(read.body.config.mcpServers.demo.env).toEqual({
      ODD_CREDENTIAL_NAME: PLACEHOLDER, PLAIN_FLAG: PLACEHOLDER, KEY_LIST: PLACEHOLDER,
    });
    expect(read.body.config.mcpServers.demo.headers.Authorization).toBe(PLACEHOLDER);
    expect(read.body.config.mcpServers.dockerish.env).toEqual([PLACEHOLDER, PLACEHOLDER]);

    const saved = await h.call('POST', '/mcp', read.body.config);
    expect(saved.status).toBe(200);
    for (const file of ['mcp_settings.json', path.join('data', 'settings', 'cline_mcp_settings.json')]) {
      const servers = JSON.parse(fs.readFileSync(path.join(h.clineDir, file), 'utf8')).mcpServers;
      expect(servers.demo.env).toEqual({
        ODD_CREDENTIAL_NAME: 'placeholder-mcp-env-secret',
        PLAIN_FLAG: 'placeholder-mcp-plain-flag',
        KEY_LIST: ['placeholder-mcp-list-a', 'placeholder-mcp-list-b'],
      });
      expect(servers.demo.headers).toEqual({ Authorization: 'Bearer placeholder-mcp-header-token' });
      expect(servers.demo.args).toEqual(['server.js']);
      expect(servers.dockerish.env).toEqual(['API_TOKEN=placeholder-docker-token', 'MODE=placeholder-docker-mode']);
      expect(fs.readFileSync(path.join(h.clineDir, file), 'utf8')).not.toContain(PLACEHOLDER);
    }
    expect(saved.body.config.mcpServers.demo.env.ODD_CREDENTIAL_NAME).toBe(PLACEHOLDER);
    expect(saved.body.droppedPlaceholders).toEqual([]);
  });

  it('POST /rag, /presentron and /google-search-mcp keep nested service credentials', async () => {
    const h = await startHarness();
    const services: Array<[string, string, Record<string, unknown>, boolean]> = [
      ['/rag', 'ragServiceConfig', {
        endpoint: 'http://rag:8000',
        apiKey: 'placeholder-rag-key',
        auth: { bearerToken: 'placeholder-rag-bearer' },
        // GET keeps arrays and redacts inside their objects, so these resolve by index.
        replicas: [{ url: 'http://rag-a:8000', apiKey: 'placeholder-rag-replica-a' }, { url: 'http://rag-b:8000', apiKey: 'placeholder-rag-replica-b' }],
      }, false],
      ['/presentron', 'presentronServiceConfig', { endpoint: 'http://presentron:8080', mcpUrl: 'http://presentron-mcp:8081', accessKey: 'placeholder-presentron-access-key' }, true],
      ['/google-search-mcp', 'googleSearchMcpConfig', { url: 'http://search:8080/mcp', headers: { Authorization: 'Bearer placeholder-search-token' } }, true],
    ];
    for (const [route, , config] of services) {
      expect((await h.call('POST', route, { config })).status).toBe(200);
    }
    expect((await h.call('GET', '/rag')).body.config.replicas).toEqual([
      { url: 'http://rag-a:8000', apiKey: PLACEHOLDER },
      { url: 'http://rag-b:8000', apiKey: PLACEHOLDER },
    ]);
    for (const [route, key, config, wrap] of services) {
      const read = await h.call('GET', route);
      expect(JSON.stringify(read.body.config)).toContain(PLACEHOLDER);
      const saved = await roundTrip(h, route, wrap);
      expect(saved.status).toBe(200);
      expect(h.settings()[key]).toEqual(config);
      expect(saved.body.droppedPlaceholders).toEqual([]);
    }
    expect(h.settingsText()).not.toContain(PLACEHOLDER);
  });

  it('POST /llm keeps the stored legacy key and never writes the placeholder into the Cline file', async () => {
    const h = await startHarness();
    expect((await h.call('POST', '/llm', {
      provider: 'anthropic', model: 'claude-model-a', apiKey: 'placeholder-legacy-anthropic-key',
    })).status).toBe(200);
    const clineConfigPath = path.join(h.homeDir, '.cline', 'config.json');
    const clineBefore = fs.readFileSync(clineConfigPath, 'utf8');

    const read = await h.call('GET', '/llm');
    expect(read.body).toEqual({ provider: 'anthropic', model: 'claude-model-a', apiKey: PLACEHOLDER });
    const saved = await h.call('POST', '/llm', { ...read.body, model: 'claude-model-b' });
    expect(saved.status).toBe(200);
    expect(h.readJson('llm-config.json')).toEqual({
      provider: 'anthropic', model: 'claude-model-b', apiKey: 'placeholder-legacy-anthropic-key',
    });
    // A kept key is not copied into another file; the request carried no key to write there.
    expect(fs.readFileSync(clineConfigPath, 'utf8')).toBe(clineBefore);
    expect(clineBefore).not.toContain(PLACEHOLDER);
  });
});

describe('an unresolved placeholder is dropped, reported, and the save succeeds', () => {
  it('omits placeholders with nothing stored behind them in every partition', async () => {
    const h = await startHarness();
    const saved = await h.call('POST', '/', {
      planModeApiProvider: 'openai',
      brandNewApiKey: PLACEHOLDER,
      credentialsBundle: PLACEHOLDER,
      ragServiceConfig: { endpoint: 'http://rag:8000', apiKey: PLACEHOLDER },
    });
    expect(saved.status).toBe(200);
    expect(h.secrets().loadSecrets()).toEqual({});
    expect(h.settings()).toEqual({ planModeApiProvider: 'openai', ragServiceConfig: { endpoint: 'http://rag:8000' } });
    expect([...saved.body.droppedPlaceholders].sort()).toEqual(['brandNewApiKey', 'credentialsBundle', 'ragServiceConfig.apiKey']);

    const mcp = await h.call('POST', '/mcp', {
      mcpServers: { fresh: { command: 'node', env: { NEVER_STORED: PLACEHOLDER, KEPT: 'placeholder-kept-value' } } },
    });
    expect(mcp.status).toBe(200);
    expect(mcp.body.droppedPlaceholders).toEqual(['mcpServers.fresh.env.NEVER_STORED']);
    expect(JSON.parse(fs.readFileSync(path.join(h.clineDir, 'mcp_settings.json'), 'utf8')).mcpServers.fresh.env)
      .toEqual({ KEPT: 'placeholder-kept-value' });

    const service = await h.call('POST', '/presentron', { config: { endpoint: 'http://presentron:8080', apiKey: PLACEHOLDER } });
    expect(service.status).toBe(200);
    expect(service.body.droppedPlaceholders).toEqual(['apiKey']);
    expect(h.settings().presentronServiceConfig).toEqual({ endpoint: 'http://presentron:8080' });

    const legacy = await h.call('POST', '/llm', { provider: 'openai', model: 'gpt-model', apiKey: PLACEHOLDER });
    expect(legacy.status).toBe(200);
    expect(legacy.body.droppedPlaceholders).toEqual(['apiKey']);
    expect(h.readJson('llm-config.json')).toEqual({ provider: 'openai', model: 'gpt-model', apiKey: '' });
    expect(h.settingsText()).not.toContain(PLACEHOLDER);
  });
});

describe('per-user secret envelopes never reach global-config.json', () => {
  const credentials = (label: string): string => JSON.stringify({
    type: 'openai-codex',
    accessToken: `placeholder-${label}-access-token`,
    refreshToken: `placeholder-${label}-refresh-token`,
    expiresAt: 4102444800000,
  });

  it('drops the numeric-sub and local- sub envelopes GET merged when the /chat page posts them back', async () => {
    const h = await startHarness();
    await h.call('POST', '/', { anthropicApiKey: 'placeholder-anthropic-api-key', planModeApiProvider: 'anthropic' });
    h.secrets().saveSecrets({ openAiCodexOauthCredentials: credentials('numeric-sub') }, NUMERIC_SUB);
    h.secrets().saveSecrets({ openAiCodexOauthCredentials: credentials('local-sub') }, LOCAL_SUB);

    const read = await h.call('GET', '/');
    // GET merges these envelopes into its global view (unchanged); this is what /chat posts back.
    expect(read.body.config[NUMERIC_SUB]).toEqual({ openAiCodexOauthCredentials: PLACEHOLDER });
    expect(read.body.config[LOCAL_SUB]).toEqual({ openAiCodexOauthCredentials: PLACEHOLDER });

    expect((await h.call('POST', '/', read.body.config)).status).toBe(200);
    const settings = h.settings();
    expect(Object.keys(settings).sort()).toEqual(['planModeApiProvider']);
    for (const needle of ['numeric-sub-access-token', 'local-sub-access-token', 'openAiCodexOauthCredentials', NUMERIC_SUB, LOCAL_SUB]) {
      expect(h.settingsText()).not.toContain(needle);
    }
    expect(h.secrets().loadSecrets(NUMERIC_SUB)).toEqual({ openAiCodexOauthCredentials: credentials('numeric-sub') });
    expect(h.secrets().loadSecrets(LOCAL_SUB)).toEqual({ openAiCodexOauthCredentials: credentials('local-sub') });
    expect(h.secrets().loadSecrets().anthropicApiKey).toBe('placeholder-anthropic-api-key');
  });

  it('drops envelopes a stale page still holds and removes one an earlier save wrote into settings', async () => {
    const h = await startHarness();
    const stale = await h.call('POST', '/', {
      '9876543210987': { openAiCodexOauthCredentials: PLACEHOLDER },
      'local-fedcba9876543210': { openAiCodexOauthCredentials: 'placeholder-stale-local-token' },
      mode: 'plan',
    });
    expect(stale.status).toBe(200);
    expect(h.settings()).toEqual({ mode: 'plan' });
    expect(h.settingsText()).not.toContain('placeholder-stale-local-token');

    // The shape the unfixed route left behind: the merged envelope written into plaintext settings.
    h.secrets().saveSecrets({ openAiCodexOauthCredentials: credentials('numeric-sub') }, NUMERIC_SUB);
    h.writeJson('global-config.json', { mode: 'plan', [NUMERIC_SUB]: { openAiCodexOauthCredentials: PLACEHOLDER } });
    expect((await h.call('POST', '/', { mode: 'act' })).status).toBe(200);
    expect(h.settings()).toEqual({ mode: 'act' });
    expect(h.secrets().loadSecrets(NUMERIC_SUB)).toEqual({ openAiCodexOauthCredentials: credentials('numeric-sub') });
  });
});

describe('a stored placeholder reads as absent and the next save of that partition removes it', () => {
  it('secrets: the consumer falls back to env, and the next secrets save drops the corrupted value', async () => {
    const h = await startHarness();
    h.secrets().saveSecrets({
      facebookAppId: 'placeholder-facebook-app-id',
      facebookAppSecret: PLACEHOLDER,
      anthropicApiKey: 'placeholder-anthropic-api-key',
    });
    expect(h.rawSecrets().facebookAppSecret).toBe(PLACEHOLDER);
    vi.stubEnv('FACEBOOK_APP_SECRET', 'placeholder-env-facebook-app-secret');

    const secrets = h.secrets().loadSecrets();
    expect(Object.prototype.hasOwnProperty.call(secrets, 'facebookAppSecret')).toBe(false);
    // The facebook-auth expression: secrets.facebookAppSecret || process.env.FACEBOOK_APP_SECRET.
    expect(secrets.facebookAppSecret || process.env.FACEBOOK_APP_SECRET).toBe('placeholder-env-facebook-app-secret');
    expect(Object.keys((await h.call('GET', '/')).body.config).sort()).toEqual(['anthropicApiKey', 'facebookAppId']);

    expect((await h.call('POST', '/', { mode: 'act' })).status).toBe(200);
    expect(h.rawSecrets()).toEqual({ facebookAppId: 'placeholder-facebook-app-id', anthropicApiKey: 'placeholder-anthropic-api-key' });
  });

  it('settings: the shared loader skips the corrupted leaf, and a settings or service save drops it', async () => {
    const h = await startHarness();
    const corrupted = {
      planModeApiProvider: 'anthropic',
      openAiCodexOauthCredentials: PLACEHOLDER,
      ragServiceConfig: { endpoint: 'http://rag:8000', apiKey: PLACEHOLDER },
    };
    h.writeJson('global-config.json', corrupted);
    expect(readGlobalRuntimeSettings(path.join(h.root, 'global-config.json'))).toEqual({
      planModeApiProvider: 'anthropic',
      ragServiceConfig: { endpoint: 'http://rag:8000' },
    });
    expect((await h.call('POST', '/', { mode: 'act' })).status).toBe(200);
    expect(h.settings()).toEqual({ planModeApiProvider: 'anthropic', ragServiceConfig: { endpoint: 'http://rag:8000' }, mode: 'act' });

    h.writeJson('global-config.json', corrupted);
    expect((await h.call('POST', '/presentron', { config: { endpoint: 'http://presentron:8080' } })).status).toBe(200);
    expect(h.settingsText()).not.toContain(PLACEHOLDER);
    expect(h.settings().ragServiceConfig).toEqual({ endpoint: 'http://rag:8000' });
  });

  it('MCP and legacy llm: readers skip the corrupted leaf, and the next save of that file drops it', async () => {
    const h = await startHarness();
    h.writeJson(path.join('cline', 'mcp_settings.json'), {
      mcpServers: { demo: { command: 'node', env: { TOKEN: PLACEHOLDER, KEEP: 'placeholder-keep-value' } } },
    });
    const reader = new ClineRuntimeConfigSyncService(h.clineDir, h.root);
    expect((reader.readMcpSettings().mcpServers as any).demo.env).toEqual({ KEEP: 'placeholder-keep-value' });
    const mcp = await roundTrip(h, '/mcp');
    expect(mcp.status).toBe(200);
    expect(h.readJson(path.join('cline', 'mcp_settings.json')).mcpServers.demo.env).toEqual({ KEEP: 'placeholder-keep-value' });

    h.writeJson('llm-config.json', { provider: 'openai', model: 'gpt-model', apiKey: PLACEHOLDER });
    expect((await roundTrip(h, '/llm')).status).toBe(200);
    expect(h.readJson('llm-config.json')).toEqual({ provider: 'openai', model: 'gpt-model', apiKey: '' });
  });
});

describe('a placeholder resolves only inside its own partition', () => {
  it('never copies an encrypted secret into settings, or a settings value into the encrypted store', async () => {
    const h = await startHarness();
    // A secret stored under a key POST would route to settings, and a secret-shaped key held in settings.
    h.secrets().saveSecrets({ openAiCodexOauthCredentials: 'placeholder-global-codex-blob' });
    h.writeJson('global-config.json', {
      legacyApiKey: 'placeholder-plaintext-legacy-key',
      authorization: 'placeholder-settings-authorization',
    });
    const read = await h.call('GET', '/');
    expect(read.body.config).toEqual({
      openAiCodexOauthCredentials: PLACEHOLDER,
      legacyApiKey: PLACEHOLDER,
      authorization: PLACEHOLDER,
    });

    const saved = await h.call('POST', '/', read.body.config);
    expect(saved.status).toBe(200);
    expect(h.settings()).toEqual({
      legacyApiKey: 'placeholder-plaintext-legacy-key',
      authorization: 'placeholder-settings-authorization',
    });
    expect(h.settingsText()).not.toContain('placeholder-global-codex-blob');
    expect(h.rawSecrets()).toEqual({ openAiCodexOauthCredentials: 'placeholder-global-codex-blob' });
    expect([...saved.body.droppedPlaceholders].sort()).toEqual(['legacyApiKey', 'openAiCodexOauthCredentials']);
  });
});

describe('non-placeholder values still overwrite', () => {
  it('replaces stored values in every partition when the request carries real values', async () => {
    const h = await startHarness();
    await h.call('POST', '/', { anthropicApiKey: 'placeholder-old-anthropic', ragServiceConfig: { apiKey: 'placeholder-old-rag' } });
    await h.call('POST', '/mcp', { mcpServers: { demo: { command: 'node', env: { TOKEN: 'placeholder-old-env' } } } });
    await h.call('POST', '/presentron', { config: { endpoint: 'http://old', accessKey: 'placeholder-old-presentron' } });
    await h.call('POST', '/llm', { provider: 'openai', model: 'gpt-model', apiKey: 'placeholder-old-legacy' });

    const contains = 'placeholder-new-[REDACTED]-is-not-the-placeholder';
    await h.call('POST', '/', { anthropicApiKey: contains, ragServiceConfig: { apiKey: 'placeholder-new-rag' } });
    await h.call('POST', '/mcp', { mcpServers: { demo: { command: 'node', env: { TOKEN: 'placeholder-new-env' } } } });
    await h.call('POST', '/presentron', { config: { endpoint: 'http://new', accessKey: 'placeholder-new-presentron' } });
    await h.call('POST', '/llm', { provider: 'openai', model: 'gpt-model', apiKey: 'placeholder-new-legacy' });

    expect(h.secrets().loadSecrets()).toEqual({ anthropicApiKey: contains });
    expect(h.settings().ragServiceConfig).toEqual({ apiKey: 'placeholder-new-rag' });
    expect(h.settings().presentronServiceConfig).toEqual({ endpoint: 'http://new', accessKey: 'placeholder-new-presentron' });
    expect(h.readJson(path.join('cline', 'mcp_settings.json')).mcpServers.demo.env).toEqual({ TOKEN: 'placeholder-new-env' });
    expect(h.readJson('llm-config.json').apiKey).toBe('placeholder-new-legacy');
  });

  it('keeps the operator gate in front of every save', async () => {
    const h = await startHarness();
    await h.call('POST', '/', { anthropicApiKey: 'placeholder-anthropic-api-key' });
    expect((await h.call('POST', '/', { anthropicApiKey: PLACEHOLDER }, 'ordinary-user')).status).toBe(403);
    expect((await h.call('POST', '/mcp', { mcpServers: {} }, 'ordinary-user')).status).toBe(403);
    expect(h.secrets().loadSecrets()).toEqual({ anthropicApiKey: 'placeholder-anthropic-api-key' });
  });
});

describe('the placeholder literal is defined once per runtime and the definitions agree', () => {
  it('pins the plain-JS secrets store constant to the TypeScript one GET writes', async () => {
    const { REDACTED_CONFIG_PLACEHOLDER } = await import('@/shared/config');
    const { REDACTED_SECRET_PLACEHOLDER } = require('../../src/api/encrypted-config-manager.js');
    expect(REDACTED_SECRET_PLACEHOLDER).toBe(REDACTED_CONFIG_PLACEHOLDER);
    expect(REDACTED_CONFIG_PLACEHOLDER).toBe(PLACEHOLDER);
  });
});

describe('placeholder clean-up logging', () => {
  it('warns once per store and set of paths, not on every read', () => {
    expect(shouldWarnRedactedPlaceholders('/placeholder/store-a', ['facebookAppSecret'])).toBe(true);
    expect(shouldWarnRedactedPlaceholders('/placeholder/store-a', ['facebookAppSecret'])).toBe(false);
    expect(shouldWarnRedactedPlaceholders('/placeholder/store-a', ['facebookAppSecret', 'gitToken'])).toBe(true);
    expect(shouldWarnRedactedPlaceholders('/placeholder/store-b', ['facebookAppSecret'])).toBe(true);
  });
});
