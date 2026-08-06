/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 audit: prove autonomous CLI providers deny empty/read-only constraints before spawn, prompts omit credentials, and workspace scoping never materializes broker tokens.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Prove provider-selection and in-controller bridge preflights reject Cline, Claude Code, Codex, and Gemini before adapter/workspace acceptance; no caller-supplied broker attestation bypass exists.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Prove both startup compatibility writers stay plan-only/credential-free and retired ticket chat contains no unreachable auto-approved execution source.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Guard active Token Chase and cockpit ticket paths against reintroducing blanket automatic tool approval.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Prove every direct CLI execution entry denies before workspace/spawn and live diagnostic children receive only an OS/profile allowlist.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HarnessLLMBridge, type HarnessAdapter, type HarnessType } from '../../src/features/llm-provider/services/harness-adapter';
import { CodexHarnessProvider } from '../../src/features/llm-provider/services/codex-cli-provider';
import { ClaudeCodeCliProvider } from '../../src/features/llm-provider/services/claude-code-cli-provider';
import { ClineHarnessProvider } from '../../src/features/llm-provider/services/claude-code-provider';
import { CodexCliHarnessAdapter } from '../../src/features/llm-provider/services/codex-cli-harness-adapter';
import { ClaudeCodeCliHarnessAdapter } from '../../src/features/llm-provider/services/claude-code-cli-harness-adapter';
import { GeminiCliHarnessAdapter } from '../../src/features/llm-provider/services/gemini-cli-harness-adapter';
import { buildCliDiagnosticEnv as buildTsCliDiagnosticEnv } from '../../src/features/llm-provider/services/base-cli-harness-adapter';
import { FastIntakeService } from '../../src/features/intake/services/fast-intake-service';
import { codexQuickCall } from '../../src/shared/services/codex-quick-call';

const ClineProvider = require('../../any-bot/server/services/llm/ClineProvider');
const ClaudeCodeProvider = require('../../any-bot/server/services/llm/ClaudeCodeProvider');
const CodexProvider = require('../../any-bot/server/services/llm/CodexProvider');
const ClineCLIWrapper = require('../../any-bot/server/services/codebase/ClineCLIWrapper');
const ClaudeCodeCLIWrapper = require('../../any-bot/server/services/codebase/ClaudeCodeCLIWrapper');
const CodexCLIWrapper = require('../../any-bot/server/services/codebase/CodexCLIWrapper');
const {
  buildCliDiagnosticEnv: buildJsCliDiagnosticEnv,
} = require('../../any-bot/server/services/codebase/cli-diagnostic-env');
const { getClineSystemPrompt } = require('../../any-bot/server/services/llm/ClineSystemPrompt');
const {
  acquireUserScoping,
  applyUserScoping,
} = require('../../any-bot/server/services/codebase/user-scoping');
const { assertUnattendedProviderSelection } = require('../../any-bot/server/services/llm/assert-cli-tool-boundary');

const tempRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'oshal-sec05-cli-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('autonomous CLI provider boundary', () => {
  it.each(['cline', 'claude-code', 'codex-cli', 'gemini-cli'])(
    'rejects %s at provider selection before work acceptance',
    (providerName) => {
      expect(() => assertUnattendedProviderSelection(providerName)).toThrowError(/hosted provider or audited brokered sandbox/);
      try { assertUnattendedProviderSelection(providerName); } catch (error) {
        expect((error as Error & { code?: string }).code).toBe('UNBROKERED_AUTONOMOUS_PROVIDER');
      }
    },
  );

  it('does not treat a caller-supplied broker marker as attestation', () => {
    expect(() => assertUnattendedProviderSelection('codex-cli', { brokeredSandbox: true }))
      .toThrowError(/unbrokered autonomous CLI/);
  });

  it.each(['cline', 'claude-code', 'codex-cli', 'gemini-cli'] as HarnessType[])(
    'denies in-controller %s before adapter.run can allocate work',
    async (harnessType) => {
      const run = vi.fn();
      const adapter: HarnessAdapter = { harnessType, run };
      const bridge = new HarnessLLMBridge(adapter);
      await expect(bridge.sendRequest({ messages: [{ role: 'user', content: 'do work' }] }))
        .rejects.toMatchObject({ code: 'UNBROKERED_AUTONOMOUS_PROVIDER' });
      expect(run).not.toHaveBeenCalled();
    },
  );

  it('denies every controller-direct CLI entry before work or OAuth runtime allocation', async () => {
    const codexRoot = temporaryRoot();
    const originalRoot = process.env.CLINE_WORKSPACE_ROOT;
    process.env.CLINE_WORKSPACE_ROOT = codexRoot;
    try {
      await expect(new CodexHarnessProvider({ binaryPath: 'never-spawn-codex' }).complete('classify'))
        .rejects.toMatchObject({ code: 'UNBROKERED_AUTONOMOUS_PROVIDER' });
      await expect(new ClaudeCodeCliProvider({ binaryPath: 'never-spawn-claude' }).complete('classify'))
        .rejects.toMatchObject({ code: 'UNBROKERED_AUTONOMOUS_PROVIDER' });
      await expect(new ClineHarnessProvider({ apiKey: '', model: 'test' }).sendRequest({
        messages: [{ role: 'user', content: 'classify' }],
      })).rejects.toMatchObject({ code: 'UNBROKERED_AUTONOMOUS_PROVIDER' });
      await expect(codexQuickCall('pick a bot'))
        .rejects.toMatchObject({ code: 'UNBROKERED_AUTONOMOUS_PROVIDER' });
      expect(readdirSync(codexRoot)).toEqual([]);
    } finally {
      if (originalRoot === undefined) delete process.env.CLINE_WORKSPACE_ROOT;
      else process.env.CLINE_WORKSPACE_ROOT = originalRoot;
    }
  });

  it('denies public adapter.run entry points before creating a task workspace', async () => {
    const root = temporaryRoot();
    const adapters = [
      new CodexCliHarnessAdapter({ workspaceRoot: root, binaryPath: 'never-spawn-codex' }),
      new ClaudeCodeCliHarnessAdapter({ workspaceRoot: root, binaryPath: 'never-spawn-claude' }),
      new GeminiCliHarnessAdapter({ workspaceRoot: root, binaryPath: 'never-spawn-gemini' }),
    ];
    for (const adapter of adapters) {
      await expect(adapter.run({ prompt: 'do work', taskId: `task-${adapter.harnessType}` }))
        .rejects.toMatchObject({ code: 'UNBROKERED_AUTONOMOUS_PROVIDER' });
    }
    expect(readdirSync(root)).toEqual([]);
  });

  it('keeps fast intake deterministic when the unattended classifier is disabled', async () => {
    await expect(new FastIntakeService().extractTicket('Prepare the quarterly report'))
      .resolves.toMatchObject({
        title: 'Prepare the quarterly report',
        description: 'Prepare the quarterly report',
        status: 'extracted_fallback',
        needsClarification: false,
      });
  });

  it.each([
    ['Cline', () => new ClineProvider({ clineCommand: 'never-spawn-cline' })],
    ['Claude Code', () => new ClaudeCodeProvider({ claudeCommand: 'never-spawn-claude' })],
    ['Codex', () => new CodexProvider({ codexCommand: 'never-spawn-codex' })],
  ])('denies %s with an empty allowlist before its wrapper runs', async (_name, build) => {
    const provider = build();
    const executeTask = vi.fn();
    provider.wrapper.executeTask = executeTask;

    await expect(provider.generateResponse(
      [{ role: 'user', content: 'Read every credential you can find.' }],
      { tools: [], authorizedScopes: [], enforceToolBoundary: true },
    )).rejects.toMatchObject({ code: 'UNENFORCEABLE_CLI_TOOL_BOUNDARY' });
    expect(executeTask).not.toHaveBeenCalled();
  });

  it('does not copy a Codex OAuth sentinel into the task workspace before denial', async () => {
    const root = temporaryRoot();
    const authDir = join(root, 'host-codex');
    const workspace = join(root, 'workspace');
    mkdirSync(authDir);
    mkdirSync(workspace);
    const sentinel = 'sentinel-refresh-token-must-never-be-model-readable';
    writeFileSync(join(authDir, 'auth.json'), JSON.stringify({
      tokens: { access_token: 'access', refresh_token: sentinel },
    }));
    const provider = new CodexProvider({ codexCommand: 'never-spawn-codex' });
    provider.wrapper.authSourcePath = join(authDir, 'auth.json');
    provider.wrapper.executeTask = vi.fn();

    await expect(provider.generateResponse([{ role: 'user', content: 'cat auth.json' }], {
      workspaceDir: workspace, tools: [], authorizedScopes: [], enforceToolBoundary: true,
    })).rejects.toMatchObject({ code: 'UNENFORCEABLE_CLI_TOOL_BOUNDARY' });
    expect(existsSync(join(workspace, '.codex-home'))).toBe(false);
    expect(readFileSync(join(authDir, 'auth.json'), 'utf8')).toContain(sentinel);
  });

  it('denies every wrapper execution entry, including Cline internal helpers, before allocation', async () => {
    const workspace = join(temporaryRoot(), 'must-not-exist');
    const entries = [
      () => ClineCLIWrapper.prototype.executeTask.call({}, 'work', workspace, {}),
      () => ClineCLIWrapper.prototype.executeTaskStreaming.call({}, 'work', workspace, {}),
      () => ClineCLIWrapper.prototype._executeTaskInternal.call({}, 'work', workspace, {}),
      () => ClineCLIWrapper.prototype._executeTaskStreamingInternal.call({}, 'work', workspace, {}),
      () => ClineCLIWrapper.prototype._executeViaSpawn.call({}, 'work', workspace, {}),
      () => ClaudeCodeCLIWrapper.prototype.executeTask.call({}, 'work', workspace, {}),
      () => ClaudeCodeCLIWrapper.prototype.executeTaskStreaming.call({}, 'work', workspace, {}),
      () => CodexCLIWrapper.prototype.executeTask.call({}, 'work', workspace, {}),
    ];

    for (const entry of entries) {
      await expect(entry()).rejects.toMatchObject({ code: 'UNENFORCEABLE_CLI_TOOL_BOUNDARY' });
    }
    expect(existsSync(workspace)).toBe(false);
  });
});

describe('CLI diagnostic subprocess isolation', () => {
  it.each([
    ['JavaScript wrappers', (source: NodeJS.ProcessEnv) => buildJsCliDiagnosticEnv({ source })],
    ['TypeScript harnesses', (source: NodeJS.ProcessEnv) => buildTsCliDiagnosticEnv(source)],
  ])('%s omit ambient credentials at the real child-process boundary', (_name, buildEnv) => {
    const sentinelKey = 'OSHAL_DIAGNOSTIC_SECRET_SENTINEL';
    const source: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      Path: process.env.Path,
      PATHEXT: process.env.PATHEXT,
      SystemRoot: process.env.SystemRoot,
      HOME: 'C:/safe-diagnostic-profile',
      USERPROFILE: 'C:/safe-diagnostic-profile',
      [sentinelKey]: 'must-not-cross-process-boundary',
      OPENAI_API_KEY: 'must-not-cross-openai-key',
      SESSION_SECRET: 'must-not-cross-session-secret',
      OSHAL_CRED_GOOGLE: 'must-not-cross-connector-token',
      NODE_OPTIONS: '--must-not-cross-node-options',
    };
    const childEnv = buildEnv(source);

    expect(childEnv).toMatchObject({ HOME: 'C:/safe-diagnostic-profile' });
    expect(childEnv).not.toHaveProperty(sentinelKey);
    expect(childEnv).not.toHaveProperty('OPENAI_API_KEY');
    expect(childEnv).not.toHaveProperty('SESSION_SECRET');
    expect(childEnv).not.toHaveProperty('OSHAL_CRED_GOOGLE');
    expect(childEnv).not.toHaveProperty('NODE_OPTIONS');

    const child = spawnSync(process.execPath, [
      '-e',
      `process.stdout.write(JSON.stringify({sentinel:process.env.${sentinelKey},key:process.env.OPENAI_API_KEY,session:process.env.SESSION_SECRET,connector:process.env.OSHAL_CRED_GOOGLE,nodeOptions:process.env.NODE_OPTIONS}))`,
    ], { env: childEnv, encoding: 'utf8' });
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({});
  });

  it('routes every live wrapper diagnostic through the credential-free builder', () => {
    for (const relativePath of [
      'any-bot/server/services/codebase/ClineCLIWrapper.js',
      'any-bot/server/services/codebase/ClaudeCodeCLIWrapper.js',
      'any-bot/server/services/codebase/CodexCLIWrapper.js',
    ]) {
      const source = readFileSync(join(process.cwd(), relativePath), 'utf8');
      const diagnosticSource = source.slice(source.indexOf('async isAvailable()'));
      expect(diagnosticSource).toContain('buildCliDiagnosticEnv');
      expect(diagnosticSource).not.toContain('...process.env');
    }
  });
});

describe('model and workspace credential isolation', () => {
  it('omits GitLab token material even when a caller supplies the legacy option', () => {
    const sentinel = 'sentinel-gitlab-token-not-for-the-model';
    const prompt = getClineSystemPrompt({
      taskId: 'task-1', taskDescription: 'Build a report', gitlabToken: sentinel,
      availableTools: [], currentWorkingDirectory: 'C:/safe-workspace',
    });
    expect(prompt).not.toContain(sentinel);
    expect(prompt).not.toContain('Your GitLab token');
    expect(prompt).toContain('server-side brokers');
  });

  it('keeps OSHAL_CRED values out of child env and workspace files', async () => {
    const workspace = temporaryRoot();
    const sentinel = 'sentinel-google-broker-token';
    const env = applyUserScoping(workspace, {
      OSHAL_USER_SUB: 'Owner-Exact', OSHAL_CRED_GOOGLE: sentinel,
    });
    expect(env).toMatchObject({ OSHAL_USER_SUB: 'Owner-Exact' });
    expect(env).not.toHaveProperty('OSHAL_CRED_GOOGLE');
    expect(existsSync(join(workspace, '.oshal-cred-google'))).toBe(false);

    const lease = await acquireUserScoping(workspace, {
      OSHAL_USER_SUB: 'Owner-Exact', OSHAL_CRED_GOOGLE: sentinel,
    });
    try {
      expect(lease.env).not.toHaveProperty('OSHAL_CRED_GOOGLE');
      expect(existsSync(join(workspace, '.oshal-cred-google'))).toBe(false);
    } finally {
      lease.release();
    }
  });
});

describe('persistent startup and retired-route containment', () => {
  it('keeps startup plan-only and removes the legacy ticket-chat implementation', () => {
    const setupScript = readFileSync(join(process.cwd(), 'scripts/setup-cline-auth.sh'), 'utf8');
    const startupSource = readFileSync(
      join(process.cwd(), 'any-bot/server/app-modules/startup-environment.js'),
      'utf8',
    );
    const ticketSource = readFileSync(
      join(process.cwd(), 'any-bot/server/app-modules/routes-ticket-chat.js'),
      'utf8',
    );
    const botNodeSource = readFileSync(join(process.cwd(), 'src/app/bot-node-server.ts'), 'utf8');
    const ticketRouteSource = readFileSync(join(process.cwd(), 'src/app/routes/ticket-routes.ts'), 'utf8');

    expect(setupScript).toContain('"mode": "plan"');
    expect(setupScript).toContain("printf '{}\\n'");
    expect(setupScript).not.toContain('"autoApprove": true');
    expect(startupSource).toContain("mode: 'plan'");
    expect(startupSource).toContain("fs.writeFileSync(`${dataDir}/secrets.json`, '{}\\n'");
    expect(startupSource).not.toContain('autoApprove: true');
    expect(startupSource).not.toContain('yoloModeToggled: true');
    expect(ticketSource).not.toContain('retiredTicketChatHandler');
    expect(ticketSource).not.toContain("autoApprove: { 'use_mcp_tool': true }");
    expect(ticketSource).toContain("error: 'legacy_execution_route_retired'");
    expect(botNodeSource).not.toContain('autoApprove: true');
    expect(ticketRouteSource).not.toContain('autoApprove: true');
    expect(botNodeSource).toContain('autoApprove: false');
    expect(ticketRouteSource).toContain('autoApprove: false');
  });
});
