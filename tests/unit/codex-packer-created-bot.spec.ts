import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { SWARM_BOT_REGISTRY } from '../../src/app/extensions/swarm/swarm-bot-registry';
import { LOCAL_BOT_REGISTRY } from '../../src/app/extensions/swarm/swarm-bot-registry-local';

function readYaml(file: string): any {
  return yaml.load(fs.readFileSync(file, 'utf8'));
}

describe('codex packer created bot contract', () => {
  it('keeps the packer selectable and preserves a packed bot manifest', () => {
    const packer = readYaml('swarm-apps/codex-packer.yaml');
    // The LIVE email-summarizer app carved to the store (ADR-085 Wave 3); the packer's
    // emitted artifact is preserved as an ARCHIVE at ai-lab/packer-emissions/ so this
    // guard keeps proving the emission against the real emitted manifest.
    const emitted = readYaml('ai-lab/packer-emissions/email-summarizer.yaml');
    const emittedSource = fs.readFileSync('ai-lab/packer-emissions/email-summarizer.yaml', 'utf8');

    expect(packer.name).toBe('codex-packer');
    expect(packer.status).toBe('active');
    expect(packer.bots?.[0]?.selectorDescriptor).toMatch(/create a bot|manifest emission|persona design/i);
    expect(packer.bots?.[0]?.routingKeywords).toEqual(expect.arrayContaining(['create a bot', 'manifest emission']));

    expect(emittedSource).toMatch(/Emitted by codex-packer/i);
    expect(emitted.name).toBe('email-summarizer');
    expect(emitted.ticketType).toBe('email-summarizer');
    expect(emitted.workflow?.workerBot).toBe('communications-bot');
    expect(emitted.bots?.[0]).toMatchObject({
      name: 'communications-bot',
      persona: 'ai-lab/bot-personas/email-summarizer.yaml',
    });
    expect(emitted.ui?.static?.length).toBeGreaterThanOrEqual(1);
    expect(emitted.ribbon?.defaultView).toBeTruthy();
  });

  it('the Forge bot exists identically in BOTH registries — SWARM_REGISTRY=full must not drop it', () => {
    // Regression: codex-packer lived only in the local registry, so running with
    // SWARM_REGISTRY=full removed the bot while its Forge tab, Packs studio, and
    // chat surface all stayed up and silently failed.
    const inFull = SWARM_BOT_REGISTRY.find((b) => b.name === 'codex-packer');
    const inLocal = LOCAL_BOT_REGISTRY.find((b) => b.name === 'codex-packer');
    expect(inFull, 'codex-packer missing from SWARM_BOT_REGISTRY').toBeTruthy();
    expect(inLocal, 'codex-packer missing from LOCAL_BOT_REGISTRY').toBeTruthy();
    for (const key of ['agentId', 'container', 'port', 'harnessType', 'apiType'] as const) {
      expect(inFull?.[key], `registry drift on ${key}`).toEqual(inLocal?.[key]);
    }
    expect(inFull?.agentId).toBe('a0000000-0000-0000-0000-000000000030');
    expect(inFull?.container).toBe('oshal-api');
  });
});
