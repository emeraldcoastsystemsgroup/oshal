/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for CKR-8 / D15: a bot node with no database repository could not signal completion. With no resolver, resolvePromptAuthorityBinding falls back to server-authored persona declarations, and no persona on this tree supplies a runnable tool list that way — so the binding came back empty, and an empty allowlist denies every tool INCLUDING attempt_completion, the side-effect-free control a bot uses to say it is finished. The database-backed resolver has always floored completion unconditionally, so the same bot finished its task with a database and hung without one. Crosses the boundary the defect lives on rather than stopping at the binding: the resolved authority is fed through the REAL captureDispatchCapabilities and authorizeCapability over a REAL ToolRegistry, because it is the capability snapshot — not the binding object — that decides what the model may call.
 */

import { describe, it, expect } from 'vitest';
import { resolvePromptAuthorityBinding } from '@/features/swarm-orchestration';
import { ANY_BOT_COMPLETION_SCOPE, ANY_BOT_COMPLETION_TOOL } from '@/shared/llm-runtime';
import type { PersonaLayer } from '@/features/agent-management';

/* eslint-disable @typescript-eslint/no-require-imports */
const ToolRegistry = require('../../any-bot/server/services/ToolRegistry');
const {
  authorizeCapability,
  captureDispatchCapabilities,
} = require('../../any-bot/server/utils/dispatch-capabilities');
const { normalizeAllowedTools } = require('../../any-bot/server/utils/untrusted-content');
const { normalizeAuthorizedScopes } = require('../../any-bot/server/utils/dispatch-capabilities');

const AGENT = 'a0000000-0000-0000-0000-00000000d15a';

/** The two shapes a database-less node actually presents. */
const LAYER_SHAPES: Array<{ name: string; layers: PersonaLayer[] }> = [
  { name: 'the direct/interactive shape (no layers at all)', layers: [] },
  {
    name: 'the consensus-review shape (one layer, no metadata)',
    layers: [{ layerType: 'platform', priority: 5, promptFragment: '# REVIEW MODE' }],
  },
];

async function bindWithoutResolver(layers: PersonaLayer[]) {
  return resolvePromptAuthorityBinding({
    userSub: 'user-1',
    ticketId: 'ticket-1',
    workloadId: AGENT,
    executionScope: 'scope:ticket-1',
    layers,
    resolver: undefined,
  });
}

/** A registry holding one side-effecting tool, so denial has something real to deny. */
function registryWithExecuteCommand() {
  const tools = new ToolRegistry();
  tools.register({
    name: 'execute_command',
    description: 'Run a command',
    inputSchema: { type: 'object' },
    requiresApproval: false,
    handler: async () => 'ran',
  });
  return tools;
}

describe('a node with no database can still say it is finished', () => {
  for (const shape of LAYER_SHAPES) {
    it(`floors the completion control in ${shape.name}`, async () => {
      const binding = await bindWithoutResolver(shape.layers);
      expect(binding.allowedTools, 'a bot that cannot complete hangs its ticket')
        .toContain(ANY_BOT_COMPLETION_TOOL);
      expect(binding.scopes).toContain(ANY_BOT_COMPLETION_SCOPE);
    });
  }

  it('the floor survives the REAL capability snapshot, which is what the model is offered', async () => {
    // A binding assertion alone would not cross the boundary: captureDispatchCapabilities decides
    // what is advertised and authorizeCapability decides what may run.
    const binding = await bindWithoutResolver([]);
    const caps = captureDispatchCapabilities(
      registryWithExecuteCommand(),
      normalizeAllowedTools([...binding.allowedTools]),
      normalizeAuthorizedScopes([...binding.scopes]),
    );

    expect(authorizeCapability(caps, ANY_BOT_COMPLETION_TOOL).allowed, 'completion must be callable').toBe(true);
    // ...and nothing else came along with it. The floor is a floor, not an opening.
    const denied = authorizeCapability(caps, 'execute_command');
    expect(denied.allowed, 'a database-less node must not gain a side-effecting tool').toBe(false);
  });

  it('a resolver that IS present still governs, floor and all', async () => {
    // The fix must not override a real resolver. A node WITH a database answers for itself.
    const binding = await resolvePromptAuthorityBinding({
      userSub: 'user-1',
      ticketId: 'ticket-1',
      workloadId: AGENT,
      executionScope: 'scope:ticket-1',
      layers: [],
      resolver: async () => ({ allowedTools: ['read_file'], scopes: ['tool:read_file'] }),
    });
    expect(binding.allowedTools).toEqual(['read_file']);
    expect(binding.allowedTools).not.toContain(ANY_BOT_COMPLETION_TOOL);
  });

  it('server-authored persona declarations still reach the binding alongside the floor', async () => {
    // The floor is additive. The documented fallback — server-authored persona metadata — must
    // still be honoured, or this fix would trade one silent loss for another.
    const binding = await bindWithoutResolver([{
      layerType: 'platform',
      priority: 10,
      promptFragment: 'policy',
      metadata: {
        serverAuthored: true,
        allowedTools: ['read_file'],
        authorizedScopes: ['tool:read_file'],
      },
    }]);
    expect(binding.allowedTools).toContain('read_file');
    expect(binding.allowedTools).toContain(ANY_BOT_COMPLETION_TOOL);
    expect(binding.scopes).toContain('tool:read_file');
  });
});
