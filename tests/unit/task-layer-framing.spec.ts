/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — task-layer framing contract: a whole-ticket dispatch (no decomposed workUnits) must present the message AS the work unit (never "0 work unit(s)" — the live dev-bot refusal class); decomposed dispatches keep the unit-count + acceptance-criteria framing; the ADR-081 dev-repo override appears only on nodes with OSHAL_DEV_REPO_URL.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { buildTaskLayer, buildUserMessage } from '../../src/features/swarm-orchestration/services/llm-execution-handler';
import type { MeshEnvelope } from '../../src/features/agent-management/services/mesh-communication-service';

function envelope(payload: Record<string, unknown>): MeshEnvelope {
  return {
    correlationId: 'c-1',
    fromAgentId: 'queue-manager',
    toAgentId: 'de000000-0000-0000-0000-000000000001',
    channel: 'agent.de000000-0000-0000-0000-000000000001',
    messageType: 'request',
    payload,
  } as MeshEnvelope;
}

const ORIGINAL_DEV_REPO_URL = process.env.OSHAL_DEV_REPO_URL;

afterEach(() => {
  if (ORIGINAL_DEV_REPO_URL === undefined) delete process.env.OSHAL_DEV_REPO_URL;
  else process.env.OSHAL_DEV_REPO_URL = ORIGINAL_DEV_REPO_URL;
});

describe('buildTaskLayer framing (zero-work-units refusal fix)', () => {
  it('a whole-ticket dispatch presents the message AS the work unit — never "0 work unit(s)"', () => {
    const layer = buildTaskLayer(envelope({ externalId: 'ab985e3a', text: 'Investigate the 404.' }));
    // The harmful pattern was the ANNOUNCEMENT "with 0 work unit(s)" — the framing may
    // still mention the phrase while instructing the bot never to SAY it.
    expect(layer.promptFragment).not.toContain('with 0 work unit(s)');
    expect(layer.promptFragment).toContain('dispatched WHOLE');
    expect(layer.promptFragment).toContain('IS the single work unit');
    // Query-shaped requests: findings are the deliverable, not code.
    expect(layer.promptFragment).toContain('written findings');
  });

  it('a decomposed dispatch keeps the unit count and lists acceptance criteria', () => {
    const layer = buildTaskLayer(envelope({
      externalId: 't-2',
      workUnits: [
        { acceptanceCriteria: ['compiles clean', 'tests pass'] },
        { acceptanceCriteria: [] },
      ],
    }));
    expect(layer.promptFragment).toContain('2 work unit(s)');
    expect(layer.promptFragment).toContain('- compiles clean');
    expect(layer.promptFragment).toContain('- tests pass');
    expect(layer.promptFragment).not.toContain('dispatched WHOLE');
  });

  it('a whole-ticket dispatch carries the MESSAGE TEXT into the user prompt', () => {
    // The deeper half of the refusal bug: buildExecutionUserMessage never included
    // payload.text, so the actual request was silently dropped (live: probe 396da4d0
    // — the bot got "the message IS the work unit" framing but no message).
    const ask = 'Investigate why the resume route returns 404 and report findings.';
    const msg = buildUserMessage(envelope({ externalId: 't-4', text: ask, workspaceTaskId: 't-4' }));
    expect(msg).toContain('THE TICKET — YOUR WORK UNIT');
    expect(msg).toContain(ask);
  });

  it('a decomposed dispatch does NOT duplicate the raw message text section', () => {
    const msg = buildUserMessage(envelope({
      externalId: 't-5',
      text: 'raw text that decomposition already superseded',
      workspaceTaskId: 't-5',
      workUnits: [{ description: 'unit A', acceptanceCriteria: ['done'] }],
    }));
    expect(msg).not.toContain('THE TICKET — YOUR WORK UNIT');
  });

  it('names the dev-repo clone as the working dir ONLY on a platform-dev node (ADR-081)', () => {
    delete process.env.OSHAL_DEV_REPO_URL;
    const plain = buildTaskLayer(envelope({ externalId: 't-3' }));
    expect(plain.promptFragment).not.toContain('platform-repo clone');

    process.env.OSHAL_DEV_REPO_URL = 'https://github.com/example/repo.git';
    const devNode = buildTaskLayer(envelope({ externalId: 't-3' }));
    expect(devNode.promptFragment).toContain('platform-repo clone');
    expect(devNode.promptFragment).toContain('/app/dev-repo');
  });
});
