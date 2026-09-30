/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the protected Cline-backed direct lane: one Gemini hosted request, in-memory persona, no native CLI/context file, fail-closed tool/empty responses and no fallback when provider authority or credentials cannot support the one-shot contract. The paired control keeps ordinary Cline execution on its existing context-file/CLI path.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pin the literal transport/accounting contract: Cline seconds become a bounded SDK timeout, maxRetries is zero, one chat-completions request is made, and Gemini usage is reported with zero/unknown cost instead of OpenAI fallback pricing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ClineProvider = require_('../../any-bot/server/services/llm/ClineProvider');
const gateModule = require_('../../any-bot/server/services/llm/llmGate');
const originalGate = gateModule.gateLlmCall;

const ENV_KEYS = [
  'HOME', 'CONFIG_OUTPUT_DIR', 'CLINE_API_PROVIDER', 'CLINE_API_MODEL',
  'FORCE_LLM_PROVIDER', 'LLM_PROVIDER', 'FORCE_LLM_MODEL', 'LLM_MODEL',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'BOT_PERSONA_FILE', 'AGENT_ID', 'WORKSPACE_DIR',
  'DEMO_MODE', 'OSHAL_OPERATOR_SUBS', 'MOCK_OIDC', 'AWS_REGION',
] as const;
const AGENT_ID = 'sales-bot';
const OPERATOR = 'single-shot-spec-operator';

let saved: Record<string, string | undefined> = {};
let scratch: string;
let workspace: string;

const successfulHostedResult = () => ({
  content: [{ type: 'text', text: 'The authorized pipeline total is $42.' }],
  stopReason: 'stop',
  usage: { inputTokens: 12, outputTokens: 8, cacheReads: 0, cost: 0.002 },
  model: 'provider-returned-alias-that-must-not-own-authority',
});

function protectedOptions(overrides: Record<string, unknown> = {}) {
  return {
    workspaceDir: workspace,
    agentId: AGENT_ID,
    source: 'swarm-dispatch',
    singleShotToolless: true,
    protectedSingleShotVerified: true,
    enforceToolBoundary: true,
    tools: [],
    maxTokens: 1024,
    temperature: 0,
    systemPrompt: 'generic controller prompt',
    ...overrides,
  };
}

function providerWithHostedResult(result: unknown = successfulHostedResult()) {
  const provider = new ClineProvider({ model: 'fleet-default', timeout: 5, inactivityTimeout: 5 });
  const executeTask = vi.fn(async (_task: string, _directory: string, _options: Record<string, unknown>) => {
    throw new Error('Cline CLI must remain unreachable');
  });
  const sendRequest = vi.fn(async (_request: Record<string, unknown>) => result);
  const createHosted = vi.fn((_config: Record<string, unknown>) => ({ sendRequest }));
  provider.wrapper.executeTask = executeTask;
  provider._createSingleShotProvider = createHosted;
  return { provider, executeTask, sendRequest, createHosted };
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  scratch = mkdtempSync(join(tmpdir(), 'oshal-cline-single-shot-'));
  workspace = join(scratch, 'workspace');
  const output = join(scratch, 'output');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(output, { recursive: true });
  const persona = join(scratch, 'sales-concierge.yaml');
  writeFileSync(persona, [
    'name: Sales Concierge',
    'role: CRM pipeline analyst',
    'perspective: |',
    '  Reason only from the CRM facts supplied in the current task.',
    'capabilities:',
    '  - Explain authorized sales figures',
  ].join('\n'), 'utf8');
  process.env.HOME = scratch;
  process.env.CONFIG_OUTPUT_DIR = output;
  process.env.CLINE_API_PROVIDER = 'gemini';
  process.env.CLINE_API_MODEL = 'gemini-fixture-model';
  process.env.GEMINI_API_KEY = 'fixture-gemini-key';
  process.env.BOT_PERSONA_FILE = persona;
  gateModule.gateLlmCall = vi.fn(async (model: string) => ({ allowed: true, model, reason: 'fixture' }));
});

afterEach(() => {
  gateModule.gateLlmCall = originalGate;
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key] as string;
  }
  vi.restoreAllMocks();
  rmSync(scratch, { recursive: true, force: true });
});

describe('ClineProvider protected single-shot tool-less reasoning', () => {
  it('uses the configured Gemini backing model for exactly one no-tool request with the persona in memory', async () => {
    const { provider, executeTask, sendRequest, createHosted } = providerWithHostedResult();

    const response = await provider.generateResponse(
      [{ role: 'user', content: 'Summarize the authorized pipeline.' }],
      protectedOptions(),
    );

    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(sendRequest).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{ type: 'user', text: 'Summarize the authorized pipeline.' }],
      tools: [],
      stream: false,
      systemPrompt: expect.stringContaining('Sales Concierge'),
    }));
    expect(String(sendRequest.mock.calls[0][0].systemPrompt)).toContain('No tools are available');
    expect(createHosted).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'fixture-gemini-key',
      model: 'gemini-fixture-model',
      requestTimeoutMs: 5_000,
    }));
    expect(executeTask).not.toHaveBeenCalled();
    expect(existsSync(join(workspace, `${AGENT_ID}-context.md`))).toBe(false);
    expect(response).toMatchObject({
      content: 'The authorized pipeline total is $42.',
      provider: 'cline-cli',
      apiProvider: 'gemini',
      model: 'gemini-fixture-model',
      cost: 0,
      clineMetadata: { turns: 1, toolsUsed: 0, protectedSingleShot: true, costEstimated: false },
    });
  });

  it('disables SDK retries, caps timeout and makes one zero-cost Gemini transport request', async () => {
    const provider = new ClineProvider({ model: 'fleet-default', timeout: 900, inactivityTimeout: 5 });
    const executeTask = vi.fn(async () => { throw new Error('Cline CLI must remain unreachable'); });
    const transport = vi.fn(async (_request: Record<string, unknown>) => ({
      choices: [{ message: { content: 'One transport answer.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      model: 'gemini-provider-returned-model',
    }));
    const realFactory = provider._createSingleShotProvider.bind(provider);
    let sdkClient: { maxRetries: number; timeout: number } | undefined;
    let costMode: string | undefined;
    let transportUsage: Record<string, unknown> | undefined;
    provider.wrapper.executeTask = executeTask;
    provider._createSingleShotProvider = vi.fn((config: Record<string, unknown>) => {
      const adapter = realFactory(config);
      sdkClient = adapter.client;
      costMode = adapter.costMode;
      adapter.client.chat.completions.create = transport;
      const sendRequest = adapter.sendRequest.bind(adapter);
      adapter.sendRequest = async (request: Record<string, unknown>) => {
        const result = await sendRequest(request);
        transportUsage = result.usage;
        return result;
      };
      return adapter;
    });

    const response = await provider.generateResponse(
      [{ role: 'user', content: 'Return one answer.' }], protectedOptions(),
    );

    expect(sdkClient).toMatchObject({ maxRetries: 0, timeout: 300_000 });
    expect(costMode).toBe('unknown');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).not.toHaveProperty('tools');
    expect(transportUsage).toMatchObject({ cost: 0, costKnown: false });
    expect(response).toMatchObject({
      content: 'One transport answer.',
      cost: 0,
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      clineMetadata: { costEstimated: false },
    });
  });

  it('rejects any tool call after the first request, even when the response also contains text', async () => {
    const { provider, executeTask, sendRequest } = providerWithHostedResult({
      content: [
        { type: 'text', text: 'I can answer after reading a file.' },
        { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'context.md' } },
      ],
      usage: {},
    });

    await expect(provider.generateResponse(
      [{ role: 'user', content: 'Answer from the supplied facts.' }], protectedOptions(),
    )).rejects.toMatchObject({ code: 'DIRECT_REASONING_UNSAFE_RESPONSE' });
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(executeTask).not.toHaveBeenCalled();
  });

  it('rejects an empty final answer after one request without a CLI fallback', async () => {
    const { provider, executeTask, sendRequest } = providerWithHostedResult({
      content: [{ type: 'text', text: '   ' }],
      usage: {},
    });

    await expect(provider.generateResponse(
      [{ role: 'user', content: 'Answer once.' }], protectedOptions(),
    )).rejects.toMatchObject({ code: 'EMPTY_FINAL_ANSWER' });
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(executeTask).not.toHaveBeenCalled();
  });

  it('fails closed before transport when the configured backing provider has no direct adapter', async () => {
    process.env.CLINE_API_PROVIDER = 'openrouter';
    const { provider, executeTask, sendRequest, createHosted } = providerWithHostedResult();

    await expect(provider.generateResponse(
      [{ role: 'user', content: 'Answer once.' }], protectedOptions(),
    )).rejects.toMatchObject({ code: 'DIRECT_REASONING_UNAVAILABLE' });
    expect(createHosted).not.toHaveBeenCalled();
    expect(sendRequest).not.toHaveBeenCalled();
    expect(executeTask).not.toHaveBeenCalled();
  });

  it('fails closed before transport when Gemini has no hosted API key', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const { provider, executeTask, sendRequest, createHosted } = providerWithHostedResult();

    await expect(provider.generateResponse(
      [{ role: 'user', content: 'Answer once.' }], protectedOptions(),
    )).rejects.toMatchObject({ code: 'DIRECT_REASONING_UNAVAILABLE' });
    expect(createHosted).not.toHaveBeenCalled();
    expect(sendRequest).not.toHaveBeenCalled();
    expect(executeTask).not.toHaveBeenCalled();
  });

  it.each([
    { protectedSingleShotVerified: false },
    { source: 'dashboard' },
    { agentId: '' },
    { enforceToolBoundary: false },
    { tools: [{ name: 'read_file' }] },
  ])('rejects an inconsistent single-shot boundary before gating or transport: %j', async override => {
    const { provider, executeTask, sendRequest, createHosted } = providerWithHostedResult();

    await expect(provider.generateResponse(
      [{ role: 'user', content: 'Answer once.' }], protectedOptions(override),
    )).rejects.toMatchObject({ code: 'DIRECT_REASONING_BOUNDARY_INVALID' });
    expect(gateModule.gateLlmCall).not.toHaveBeenCalled();
    expect(createHosted).not.toHaveBeenCalled();
    expect(sendRequest).not.toHaveBeenCalled();
    expect(executeTask).not.toHaveBeenCalled();
  });

  it('keeps a call without the marker on the ordinary context-file and Cline CLI path', async () => {
    process.env.DEMO_MODE = 'true';
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
    const provider = new ClineProvider({ model: 'fleet-default', timeout: 5, inactivityTimeout: 5 });
    const executeTask = vi.fn(async (_task: string, _directory: string, _options: Record<string, unknown>) => (
      { success: true, text: 'ordinary Cline answer', activityStats: {} }
    ));
    const createHosted = vi.fn((_config: Record<string, unknown>) => {
      throw new Error('Hosted single-shot adapter must remain unreachable');
    });
    provider.wrapper.executeTask = executeTask;
    provider._createSingleShotProvider = createHosted;

    const response = await provider.generateResponse(
      [{ role: 'user', content: 'Perform the ordinary task.' }],
      { workspaceDir: workspace, agentId: AGENT_ID, extraEnv: { OSHAL_USER_SUB: OPERATOR } },
    );

    expect(executeTask).toHaveBeenCalledTimes(1);
    expect(String(executeTask.mock.calls[0][0])).toContain(`${AGENT_ID}-context.md`);
    expect(createHosted).not.toHaveBeenCalled();
    expect(existsSync(join(workspace, `${AGENT_ID}-context.md`))).toBe(true);
    expect(response).toMatchObject({ content: 'ordinary Cline answer', provider: 'cline-cli' });
  });
});
