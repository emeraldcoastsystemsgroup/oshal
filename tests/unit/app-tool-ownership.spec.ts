/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D11: lock tool ownership. Tool names are GLOBAL (runtime_tool_executors is keyed by tool_name, upserted ON CONFLICT DO UPDATE), so a duplicate name silently repoints another app's tool at the newcomer's executor — purchasing + travel both declared `explain-pick`, travel sorted last under readdirSync, and the SHOPPING concierge was live-routing to POST /api/travel/chat. These tests pin the invariants that make that unrepeatable: names are unique across active apps, a tool is never torn down while another active app provides it, and a tool dependent BLOCKS an uninstall rather than pinning the executor alive.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 1: pin {packageDir} substitution in a packaged cli tool's cliCommand — resolved to the package dir before registration (the validator rejects unknown tokens, so what persists must be a concrete path), inserted verbatim even when the path contains `$`-sequences.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  assertToolDependenciesResolvable,
  assertToolNamesUnique,
  computeToolDependents,
  dependedToolNames,
  otherProvidersOf,
  providedToolNames,
  SwarmAppService,
} from '../../src/features/swarm-apps';
import type { SwarmAppManifest, SwarmApplicationRecord } from '../../src/features/swarm-apps';

/**
 * @description Build an app record around a manifest.
 * @param name - App name.
 * @param manifest - Partial manifest (tools / dependencies / ui).
 * @param status - Active by default.
 * @returns A record shaped like the repo's.
 */
function rec(
  name: string,
  manifest: Partial<SwarmAppManifest>,
  status: 'active' | 'inactive' = 'active',
): SwarmApplicationRecord {
  return {
    appId: name,
    name,
    displayName: name,
    description: '',
    version: '1.0.0',
    status,
    manifestPath: `/tmp/${name}.yaml`,
    agentIds: [],
    toolNames: [],
    manifest: { name, displayName: name, ...manifest } as SwarmAppManifest,
    scope: 'public',
    ownerSub: null,
    tenantId: null,
    loadedAt: new Date(),
    updatedAt: new Date(),
  } as unknown as SwarmApplicationRecord;
}

/** @description A manifest tool with an api executor. @param name - Tool name. @param endpoint - Its endpoint. @returns The declaration. */
const tool = (name: string, endpoint: string) => ({
  name,
  displayName: name,
  type: 'api',
  category: 'test',
  description: name,
  executor: { executorType: 'api', apiEndpoint: endpoint },
});

describe('tool ownership — derivation (ADR-085 D11)', () => {
  it('providedToolNames reads the tools block ONLY — never ribbon surface ids', () => {
    // staticToolNames() unions ui.static[].toolName with tools[].name; ownership must not, or a
    // ribbon icon would masquerade as a registry tool and block a real one's name.
    const m = {
      name: 'a',
      displayName: 'a',
      tools: [tool('real-tool', 'POST /x')],
      ui: { static: [{ toolName: 'a-dashboard', label: 'D', icon: 'i', iframeUrl: '/u', section: 'top' }] },
    } as unknown as SwarmAppManifest;

    expect(providedToolNames(m)).toEqual(['real-tool']);
    expect(providedToolNames(m)).not.toContain('a-dashboard');
  });

  it('dependedToolNames reads dependencies.tools', () => {
    const m = { name: 'a', displayName: 'a', dependencies: { tools: ['t1'] } } as SwarmAppManifest;
    expect(dependedToolNames(m)).toEqual(['t1']);
    expect(dependedToolNames({ name: 'b', displayName: 'b' } as SwarmAppManifest)).toEqual([]);
  });

  it('finds other active providers of a name, and ignores inactive ones', () => {
    const others = [
      rec('travel', { tools: [tool('explain-pick', 'POST /api/travel/chat')] }),
      rec('dormant', { tools: [tool('explain-pick', 'POST /api/dormant/chat')] }, 'inactive'),
    ].filter((r) => r.status === 'active');

    expect(otherProvidersOf('explain-pick', others)).toEqual(['travel']);
    expect(otherProvidersOf('nothing', others)).toEqual([]);
  });

  it('computes tool dependents across active apps', () => {
    const target = { name: 'trading', displayName: 't', tools: [tool('trading_scan', 'POST /s')] } as unknown as SwarmAppManifest;
    const others = [
      rec('career-hunter', { dependencies: { tools: ['trading_scan'] } }),
      rec('unrelated', { dependencies: { tools: ['other'] } }),
    ];

    expect(computeToolDependents(target, others)).toEqual([
      { app: 'career-hunter', tools: ['trading_scan'] },
    ]);
  });
});

describe('tool ownership — uniqueness guard (the explain-pick bug)', () => {
  it('rejects a manifest taking a tool name another ACTIVE app provides', () => {
    const purchasing = { name: 'purchasing', displayName: 'p', tools: [tool('explain-pick', 'POST /api/purchasing/chat')] } as unknown as SwarmAppManifest;
    const others = [rec('travel', { tools: [tool('explain-pick', 'POST /api/travel/chat')] })];

    expect(() => assertToolNamesUnique(purchasing, others)).toThrow(/already taken.*explain-pick.*travel/s);
  });

  it('rejects a manifest declaring the same tool name twice', () => {
    const m = { name: 'a', displayName: 'a', tools: [tool('dup', '/1'), tool('dup', '/2')] } as unknown as SwarmAppManifest;
    expect(() => assertToolNamesUnique(m, [])).toThrow(/twice: dup/);
  });

  // The reload case. loadApp checks BEFORE upsert, so the DB still holds the app's previous
  // manifest — without self-exclusion, editing an app's own tool would make it permanently
  // unloadable. The service excludes by name; this proves the primitive cooperates.
  it('does not collide an app with its own stored record (reload must work)', () => {
    const travel = { name: 'travel', displayName: 't', tools: [tool('explain-travel-pick', 'POST /api/travel/chat')] } as unknown as SwarmAppManifest;
    const others: SwarmApplicationRecord[] = []; // caller filtered r.name !== manifest.name
    expect(() => assertToolNamesUnique(travel, others)).not.toThrow();
  });

  it('allows a name no other active app provides', () => {
    const m = { name: 'travel', displayName: 't', tools: [tool('explain-travel-pick', '/x')] } as unknown as SwarmAppManifest;
    expect(() => assertToolNamesUnique(m, [rec('purchasing', { tools: [tool('explain-pick', '/y')] })])).not.toThrow();
  });
});

describe('tool ownership — dependency resolution', () => {
  it('fails closed when dependencies.tools names a tool nothing provides', () => {
    const m = { name: 'a', displayName: 'a', dependencies: { tools: ['ghost'] } } as SwarmAppManifest;
    expect(() => assertToolDependenciesResolvable(m, new Set(['real']))).toThrow(/unknown tool\(s\): ghost/);
  });

  it('accepts when the universe contains the tool', () => {
    const m = { name: 'a', displayName: 'a', dependencies: { tools: ['real'] } } as SwarmAppManifest;
    expect(() => assertToolDependenciesResolvable(m, new Set(['real']))).not.toThrow();
  });
});

// ── Service-level: teardown + impact ────────────────────────────────────────

/**
 * @description Build a service over a fixed record set with a spied tool-registration port.
 * @param records - The apps the repo reports.
 * @param target - The record findByName resolves.
 * @returns The service and the deregister spy.
 */
function serviceOver(records: SwarmApplicationRecord[], target: SwarmApplicationRecord) {
  const deregisterRuntimeTool = vi.fn(async () => ({ removed: true, disabled: true }));
  const repo = {
    upsert: async () => target,
    list: async () => records,
    findByName: async (n: string) => records.find((r) => r.name === n) ?? null,
    updateStatus: async () => target,
    delete: async () => true,
  };
  const svc = new SwarmAppService(
    { query: async () => ({ rows: [], rowCount: 0 }) } as never,
    repo as never,
    { updateAgentStatus: async () => undefined } as never,
    { deregisterRuntimeTool, registerRuntimeTool: vi.fn(), listRuntimeExecutors: async () => [] } as never,
  );
  return { svc, deregisterRuntimeTool };
}

describe('tool ownership — teardown never strands a survivor', () => {
  it('RETAINS a tool another active app still provides', async () => {
    // Defence in depth: the uniqueness guard should prevent this state, but a database that
    // predates it can still hold one — and deleting the executor here is the original bug.
    const leaving = rec('travel', { tools: [tool('shared', 'POST /api/travel/chat')] });
    const survivor = rec('purchasing', { tools: [tool('shared', 'POST /api/purchasing/chat')] });
    const { svc, deregisterRuntimeTool } = serviceOver([leaving, survivor], leaving);

    await (svc as unknown as { deregisterManifestTools: (m: SwarmAppManifest) => Promise<void> })
      .deregisterManifestTools(leaving.manifest);

    expect(deregisterRuntimeTool).not.toHaveBeenCalled();
  });

  it('DELETES a tool when it is the sole provider', async () => {
    const leaving = rec('travel', { tools: [tool('explain-travel-pick', 'POST /api/travel/chat')] });
    const { svc, deregisterRuntimeTool } = serviceOver([leaving], leaving);

    await (svc as unknown as { deregisterManifestTools: (m: SwarmAppManifest) => Promise<void> })
      .deregisterManifestTools(leaving.manifest);

    expect(deregisterRuntimeTool).toHaveBeenCalledWith('explain-travel-pick', true);
  });

  // The ordering trap: toggleApp/unloadApp call deactivate() BEFORE flipping status, so the target
  // still reads active. Without the r.name !== target exclusion an app always "retains" its own
  // tools and nothing is ever torn down.
  it('does not treat the departing app as its own retainer', async () => {
    const leaving = rec('travel', { tools: [tool('own-tool', '/x')] }); // still status: active
    const { svc, deregisterRuntimeTool } = serviceOver([leaving], leaving);

    await (svc as unknown as { deregisterManifestTools: (m: SwarmAppManifest) => Promise<void> })
      .deregisterManifestTools(leaving.manifest);

    expect(deregisterRuntimeTool).toHaveBeenCalledWith('own-tool', true);
  });
});

describe('tool ownership — uninstall impact + block', () => {
  const provider = rec('trading', { tools: [tool('trading_scan', 'POST /s')] });
  const dependent = rec('career-hunter', { dependencies: { tools: ['trading_scan'] } });

  it('reports toolsProvided + toolDependents', async () => {
    const { svc } = serviceOver([provider, dependent], provider);
    const impact = await svc.uninstallImpact('trading');

    expect(impact.toolsProvided).toEqual(['trading_scan']);
    expect(impact.toolDependents).toEqual([{ app: 'career-hunter', tools: ['trading_scan'] }]);
  });

  it('BLOCKS an uninstall that would strand a tool dependent', async () => {
    const { svc } = serviceOver([provider, dependent], provider);
    const res = await svc.unloadApp('trading');

    expect(res.blocked).toBe(true);
    expect(res.removed).toBe(false);
    expect(res.toolDependents).toEqual([{ app: 'career-hunter', tools: ['trading_scan'] }]);
  });

  // A dependent BLOCKS; it never RETAINS. Retention-by-dependent would let any installed package —
  // including a third-party store package — pin another app's executor alive across its owner's
  // removal just by naming it, leaving a runnable executor with no owning app.
  it('under --force the tool goes with its owner (a dependent cannot pin it alive)', async () => {
    const { svc, deregisterRuntimeTool } = serviceOver([provider, dependent], provider);
    const res = await svc.unloadApp('trading', { force: true });

    expect(res.blocked).toBeUndefined();
    expect(deregisterRuntimeTool).toHaveBeenCalledWith('trading_scan', true);
  });
});

// ── Packaged cli tools: {packageDir} resolution (ADR-085 Wave 1) ────────────

describe('packaged cli tools — {packageDir} substitution', () => {
  /** @description A manifest cli tool. @param name - Tool name. @param cmd - Command template. @returns The declaration. */
  const cliTool = (name: string, cmd: string) => ({
    name,
    displayName: name,
    type: 'cli',
    category: 'test',
    description: name,
    executor: { executorType: 'cli', cliCommand: cmd },
  });

  /** @description Register a one-tool manifest and capture the executor descriptor it persists. @param cmd - Template. @param dir - Package dir. @returns The registered descriptor. */
  async function registeredDescriptor(cmd: string, dir?: string) {
    const record = rec('brandish', { tools: [cliTool('brandish_intro', cmd)] } as Partial<SwarmAppManifest>);
    const { svc } = serviceOver([record], record);
    const registerRuntimeTool = (svc as unknown as { runtimeToolRegistrationService: { registerRuntimeTool: ReturnType<typeof vi.fn> } })
      .runtimeToolRegistrationService.registerRuntimeTool;
    await (svc as unknown as { registerManifestTools: (m: SwarmAppManifest, packageDir?: string) => Promise<void> })
      .registerManifestTools(record.manifest, dir);
    return registerRuntimeTool.mock.calls[0]?.[1];
  }

  it('resolves {packageDir} to the package directory before registration', async () => {
    const d = await registeredDescriptor('node {packageDir}/tools/intro.js intro {input}', '/deployed-apps/brandish');
    expect(d.cliCommand).toBe('node /deployed-apps/brandish/tools/intro.js intro {input}');
  });

  it('leaves a command without the token untouched', async () => {
    const d = await registeredDescriptor('node /app/scripts/fixed.js {input}', '/deployed-apps/brandish');
    expect(d.cliCommand).toBe('node /app/scripts/fixed.js {input}');
  });

  it('inserts a path containing $-sequences verbatim (no replacement-pattern reinterpretation)', async () => {
    const d = await registeredDescriptor('node {packageDir}/t.js {input}', '/apps/$&weird');
    expect(d.cliCommand).toBe('node /apps/$&weird/t.js {input}');
  });
});
