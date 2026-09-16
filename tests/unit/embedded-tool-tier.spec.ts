/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the provider-embedded tool tier. Crosses the boundaries the change claims: a REAL persona YAML file on disk read by the REAL persona loader decides the per-agent grant, the REAL ToolAuthInterceptor decides execution, and the REAL runAgenticLoop produces the run trace. Nothing between the persona file and the ProcessResult is doubled; only the model provider itself is a fixture, because the model is the one thing a unit run must not call.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Pin the tier ORDER. `google_search` normalises onto the shipped `google-search` registry tool (defaultAuthMode 'off'), and checking embedded first let a persona file beat the database - the tool executed where the registry said off, and 'ask' never reached the approval workflow. Two cases: a registered name keeps the registry's answer, and an unregistered one still reaches the embedded tier so the fallback is not lost.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  EMBEDDED_TOOL_CATALOG,
  EMBEDDED_TOOL_DENIED_CODE,
  TOOL_TIERS,
  buildToolRunTraceEntry,
  classifyToolTier,
  decideEmbeddedToolUse,
  getEmbeddedTool,
  resolveEmbeddedToolOperation,
} from '../../src/shared/tools/embedded-tool-tier';
import { createPersonaEmbeddedToolPolicy } from '../../src/app/composition/embedded-tool-policy';
import { ToolAuthInterceptor } from '../../src/features/tool-approval/services/tool-auth-interceptor';
import type { ApprovalWorkflowService } from '../../src/features/tool-approval/services/approval-workflow-service';
import { runAgenticLoop } from '../../src/features/chat-orchestration/services/agentic-loop';
import { LLMService, type LLMResponse, type SendRequestOptions } from '../../src/features/llm-provider/services/llm-service';
import { ProcessResultSchema } from '../../src/shared/types/task';
import { AuthMode, InstallMethod, ToolType, type Tool } from '../../src/shared/types/tool';

const GRANTED_AGENT = 'a0000000-0000-0000-0000-0000000e1001';
const DISABLED_AGENT = 'a0000000-0000-0000-0000-0000000e1002';
const SILENT_AGENT = 'a0000000-0000-0000-0000-0000000e1003';

let personaDir: string;

/** @description Writes one persona YAML fixture into the temp persona dir. */
function writePersona(fileName: string, agentId: string, authorizations: string): void {
  writeFileSync(
    join(personaDir, fileName),
    [
      `name: ${fileName.replace(/\.yaml$/, '')}`,
      'role: Fixture bot',
      `agent_id: ${agentId}`,
      'perspective: |',
      '  Fixture persona for the embedded tool tier guard.',
      'capabilities:',
      '  - research',
      authorizations,
      '',
    ].join('\n'),
    'utf8',
  );
}

beforeAll(() => {
  personaDir = mkdtempSync(join(tmpdir(), 'oshal-embedded-tier-'));
  writePersona('granted-bot.yaml', GRANTED_AGENT, 'authorizations:\n  web-search: auto\n  rag-query: auto');
  writePersona('disabled-bot.yaml', DISABLED_AGENT, 'authorizations:\n  web-search: off\n  rag-query: auto');
  writePersona('silent-bot.yaml', SILENT_AGENT, 'authorizations:\n  rag-query: auto');
});

afterAll(() => {
  rmSync(personaDir, { recursive: true, force: true });
});

describe('tool tier vocabulary', () => {
  it('names exactly three tiers, embedded beside registry and harness-native', () => {
    expect([...TOOL_TIERS]).toEqual(['framework-registry', 'harness-native', 'provider-embedded']);
  });

  it('classifies a registry tool, a harness primitive and an embedded tool into different tiers', () => {
    expect(classifyToolTier('rag-query')).toBe('framework-registry');
    expect(classifyToolTier('read_file')).toBe('harness-native');
    expect(classifyToolTier('web-search')).toBe('provider-embedded');
  });

  it('resolves every catalog spelling — platform name and each provider operation id', () => {
    for (const descriptor of EMBEDDED_TOOL_CATALOG) {
      expect(getEmbeddedTool(descriptor.name)?.name).toBe(descriptor.name);
      for (const [providerId, operation] of Object.entries(descriptor.providerOperations)) {
        expect(getEmbeddedTool(operation)?.name).toBe(descriptor.name);
        expect(resolveEmbeddedToolOperation(descriptor.name, providerId)).toEqual({ providerId, operation });
      }
    }
  });

  it('returns no operation when the active provider does not expose the embedded tool', () => {
    expect(resolveEmbeddedToolOperation('file-search', 'anthropic')).toBeNull();
    expect(resolveEmbeddedToolOperation('file-search', 'openai')).toEqual({
      providerId: 'openai',
      operation: 'file_search',
    });
  });

  it('denies every mode that is not exactly auto, and names the tier and operation in the reason', () => {
    for (const mode of [null, 'off', 'ask', 'disabled', 'maybe']) {
      const decision = decideEmbeddedToolUse({
        toolName: 'web-search', agentId: DISABLED_AGENT, providerId: 'anthropic', mode,
      });
      expect(decision.allowed, `mode=${String(mode)}`).toBe(false);
      expect(decision.reason).toContain(EMBEDDED_TOOL_DENIED_CODE);
      expect(decision.reason).toContain('tier=provider-embedded');
      expect(decision.reason).toContain('operation=web_search_20250305');
    }
    expect(decideEmbeddedToolUse({
      toolName: 'web-search', agentId: GRANTED_AGENT, providerId: 'anthropic', mode: 'auto',
    })).toMatchObject({ allowed: true, tier: 'provider-embedded', providerOperation: 'web_search_20250305' });
  });
});

describe('per-agent embedded grants come from the agent persona on disk', () => {
  it('reads auto / off / undeclared through the real persona loader', async () => {
    const policy = createPersonaEmbeddedToolPolicy({ personaDir });
    expect(await policy.resolveMode(GRANTED_AGENT, 'web-search')).toBe('auto');
    expect(await policy.resolveMode(DISABLED_AGENT, 'web-search')).toBe('off');
    expect(await policy.resolveMode(SILENT_AGENT, 'web-search')).toBeNull();
  });

  it('accepts the provider operation id as the declared name', async () => {
    const policy = createPersonaEmbeddedToolPolicy({ personaDir });
    expect(await policy.resolveMode(GRANTED_AGENT, 'web_search_20250305')).toBe('auto');
  });

  it('never answers for a non-embedded tool — the registry tier still owns those', async () => {
    const policy = createPersonaEmbeddedToolPolicy({ personaDir });
    expect(await policy.resolveMode(GRANTED_AGENT, 'rag-query')).toBeNull();
  });
});

/** @description Registry row used to prove the registry tier is untouched by the embedded path. */
const RAG_TOOL: Tool = {
  toolId: '00000000-0000-0000-0000-0000000000aa',
  name: 'rag-query',
  displayName: 'RAG query',
  type: ToolType.RAG,
  category: 'knowledge',
  version: '1.0.0',
  installSpec: { method: InstallMethod.NONE },
  skills: [],
  selectorFragment: '',
  routingTags: [],
  authGroup: '',
  defaultAuthMode: AuthMode.AUTO,
  description: 'Registry-tier fixture tool',
  inputSchema: {},
  examples: [],
  requiresApproval: false,
  timeoutMs: 30000,
} as unknown as Tool;

function buildInterceptor(): { interceptor: ToolAuthInterceptor; executed: string[] } {
  const executed: string[] = [];
  const interceptor = new ToolAuthInterceptor({
    approvalService: {} as unknown as ApprovalWorkflowService,
    embeddedToolPolicy: createPersonaEmbeddedToolPolicy({ personaDir }),
    lookupAuthMode: async (_agentId, toolName) =>
      (toolName === RAG_TOOL.name ? { authMode: AuthMode.AUTO, tool: RAG_TOOL } : null),
  });
  return { interceptor, executed };
}

describe('a denied embedded tool fails at execution', () => {
  it('blocks the disabled agent, never reaching the executor, and says which tier and operation', async () => {
    const { interceptor, executed } = buildInterceptor();
    const executor = interceptor.createInterceptedExecutor(
      async (name) => { executed.push(name); return `EXECUTED:${name}`; },
      DISABLED_AGENT,
      'task-embedded-1',
      'anthropic',
    );

    const result = await executor('web-search', { query: 'anything' });
    expect(result).toContain('[BLOCKED]');
    expect(result).toContain(EMBEDDED_TOOL_DENIED_CODE);
    expect(result).toContain('tier=provider-embedded');
    expect(result).toContain('provider=anthropic');
    expect(result).toContain('operation=web_search_20250305');
    expect(executed).toEqual([]);
  });

  it('blocks an agent that declares nothing for it (fail-closed default)', async () => {
    const { interceptor, executed } = buildInterceptor();
    const executor = interceptor.createInterceptedExecutor(
      async (name) => { executed.push(name); return `EXECUTED:${name}`; },
      SILENT_AGENT,
      'task-embedded-2',
      'anthropic',
    );
    const result = await executor('web-search', {});
    expect(result).toContain(EMBEDDED_TOOL_DENIED_CODE);
    expect(executed).toEqual([]);
  });

  it('blocks every embedded tool when no embedded policy is wired at all', async () => {
    const executed: string[] = [];
    const interceptor = new ToolAuthInterceptor({
      approvalService: {} as unknown as ApprovalWorkflowService,
      lookupAuthMode: async () => null,
    });
    const executor = interceptor.createInterceptedExecutor(
      async (name) => { executed.push(name); return `EXECUTED:${name}`; },
      GRANTED_AGENT,
      'task-embedded-3',
      'anthropic',
    );
    const result = await executor('web-search', {});
    expect(result).toContain(EMBEDDED_TOOL_DENIED_CODE);
    expect(executed).toEqual([]);
  });

  it('lets the granted agent through, and leaves the registry tier deciding its own tools', async () => {
    const { interceptor, executed } = buildInterceptor();
    const executor = interceptor.createInterceptedExecutor(
      async (name) => { executed.push(name); return `EXECUTED:${name}`; },
      GRANTED_AGENT,
      'task-embedded-4',
      'anthropic',
    );

    expect(await executor('web-search', {})).toBe('EXECUTED:web-search');
    expect(await executor('rag-query', {})).toBe('EXECUTED:rag-query');
    expect(await executor('not-a-real-tool', {})).toContain('[BLOCKED]');
    expect(executed).toEqual(['web-search', 'rag-query']);
  });
});

/**
 * @description Two-turn fixture provider: turn 1 asks for the named tools, turn 2 answers in text.
 * The model is the only doubled collaborator — a unit run must never call one.
 */
class ScriptedProvider extends LLMService {
  private turn = 0;

  constructor(providerId: string, private readonly requestedTools: string[]) {
    super(providerId, {});
  }

  async sendRequest(_options: SendRequestOptions): Promise<LLMResponse> {
    this.turn += 1;
    if (this.turn === 1) {
      return {
        content: this.requestedTools.map((name, index) => ({
          type: 'tool_use' as const, id: `call-${index}`, name, input: {},
        })),
        usage: { inputTokens: 10, outputTokens: 5 },
        model: 'fixture-model',
      };
    }
    return {
      content: [{ type: 'text' as const, text: 'done' }],
      usage: { inputTokens: 4, outputTokens: 2 },
      model: 'fixture-model',
    };
  }
}

describe('a name the registry knows is decided by the registry, never by the embedded tier', () => {
  // google_search normalises onto `google-search`, a shipped baseline registry tool whose
  // defaultAuthMode is 'off'. Checking embedded FIRST let a persona file beat the database: the
  // tool executed where the registry said off, and with 'ask' the approval workflow was never
  // reached. 57 shipped personas name it, so the cockpit toggle was dead in both directions.
  const COLLIDING = 'google-search';

  it('refuses a registry tool the registry has switched off, even when a persona grants the name', async () => {
    const executed: string[] = [];
    const interceptor = new ToolAuthInterceptor({
      approvalService: {} as unknown as ApprovalWorkflowService,
      embeddedToolPolicy: createPersonaEmbeddedToolPolicy({ personaDir }),
      // The registry KNOWS this name and says off. That answer is the whole point of the tier order.
      lookupAuthMode: async (_agentId, toolName) => (toolName === COLLIDING
        ? { authMode: AuthMode.OFF, tool: { toolId: 'baseline-google-search', name: COLLIDING } as never }
        : null),
    });
    const executor = interceptor.createInterceptedExecutor(
      async (name) => { executed.push(name); return `EXECUTED:${name}`; },
      GRANTED_AGENT,
      'task-embedded-collide-1',
      'anthropic',
    );

    const result = await executor(COLLIDING, {});
    expect(executed, 'the persona grant overruled the registry and the tool ran').toEqual([]);
    expect(String(result)).not.toContain('EXECUTED:');
  });

  it('still reaches the embedded tier for a name the registry does NOT know', async () => {
    // The fallback must survive the fix, or embedded tools stop working entirely.
    const { interceptor, executed } = buildInterceptor();
    const executor = interceptor.createInterceptedExecutor(
      async (name) => { executed.push(name); return `EXECUTED:${name}`; },
      GRANTED_AGENT,
      'task-embedded-collide-2',
      'anthropic',
    );
    expect(String(await executor('web-search', {}))).toContain('EXECUTED:');
    expect(executed).toEqual(['web-search']);
  });
});

describe('the run trace identifies the tier and the provider operation', () => {
  it('traces an embedded tool with its provider operation and a registry tool without one', async () => {
    const { interceptor } = buildInterceptor();
    const provider = new ScriptedProvider('anthropic', ['web-search', 'rag-query', 'read_file']);
    const executor = interceptor.createInterceptedExecutor(
      async (name) => `EXECUTED:${name}`,
      GRANTED_AGENT,
      'task-trace-1',
      'anthropic',
    );

    const result = await runAgenticLoop(provider, [], 'system', [], executor, {
      maxTurns: 4, taskId: 'task-trace-1', agentId: GRANTED_AGENT,
    });

    expect(ProcessResultSchema.safeParse(result).success).toBe(true);
    expect(result.toolRuns).toEqual([
      { name: 'web-search', tier: 'provider-embedded', providerId: 'anthropic', providerOperation: 'web_search_20250305' },
      { name: 'rag-query', tier: 'framework-registry' },
      { name: 'read_file', tier: 'harness-native' },
    ]);
    expect(result.toolsUsed).toEqual(['web-search', 'rag-query', 'read_file']);
  });

  it('records the operation of the ACTIVE provider, not a fixed one', async () => {
    const { interceptor } = buildInterceptor();
    const provider = new ScriptedProvider('google', ['web-search']);
    const executor = interceptor.createInterceptedExecutor(
      async (name) => `EXECUTED:${name}`,
      GRANTED_AGENT,
      'task-trace-2',
      'google',
    );

    const result = await runAgenticLoop(provider, [], 'system', [], executor, {
      maxTurns: 4, taskId: 'task-trace-2', agentId: GRANTED_AGENT,
    });

    expect(result.toolRuns?.[0]).toEqual({
      name: 'web-search', tier: 'provider-embedded', providerId: 'google', providerOperation: 'google_search',
    });
  });

  it('traces a DENIED embedded invocation too — the refusal is part of the run, not a hole in it', async () => {
    const { interceptor } = buildInterceptor();
    const provider = new ScriptedProvider('anthropic', ['web-search']);
    const executor = interceptor.createInterceptedExecutor(
      async (name) => `EXECUTED:${name}`,
      DISABLED_AGENT,
      'task-trace-3',
      'anthropic',
    );

    const result = await runAgenticLoop(provider, [], 'system', [], executor, {
      maxTurns: 4, taskId: 'task-trace-3', agentId: DISABLED_AGENT,
    });

    expect(result.toolRuns).toEqual([
      { name: 'web-search', tier: 'provider-embedded', providerId: 'anthropic', providerOperation: 'web_search_20250305' },
    ]);
  });

  it('builds a trace row with no operation when the provider is unknown', () => {
    expect(buildToolRunTraceEntry('web-search')).toEqual({ name: 'web-search', tier: 'provider-embedded' });
    expect(buildToolRunTraceEntry('web_search_20250305')).toEqual({
      name: 'web-search', tier: 'provider-embedded', providerId: 'anthropic', providerOperation: 'web_search_20250305',
    });
  });
});
