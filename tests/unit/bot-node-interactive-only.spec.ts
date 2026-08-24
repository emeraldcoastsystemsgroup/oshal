import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isBotNodeInteractiveOnly } from '@/app/bot-node-runtime-mode';

describe('bot-node interactive-only mode', () => {
  it('defaults off, accepts explicit booleans, and rejects production typos', () => {
    expect(isBotNodeInteractiveOnly({})).toBe(false);
    expect(isBotNodeInteractiveOnly({ BOT_NODE_INTERACTIVE_ONLY: 'true' })).toBe(true);
    expect(isBotNodeInteractiveOnly({ BOT_NODE_INTERACTIVE_ONLY: '1' })).toBe(true);
    expect(isBotNodeInteractiveOnly({ BOT_NODE_INTERACTIVE_ONLY: 'off' })).toBe(false);
    expect(() => isBotNodeInteractiveOnly({ BOT_NODE_INTERACTIVE_ONLY: 'tru' })).toThrow(/true or false/);
  });

  it('does not start, stop, or bid with the Redis worker in interactive-only mode', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app/bot-node-server.ts'), 'utf8');
    expect(source).toContain('const agentWorker = interactiveOnly ? null : new SwarmAgentWorker');
    expect(source).toContain('if (agentWorker) {');
    expect(source).toContain('await agentWorker.start()');
    expect(source).toContain('await agentWorker?.stop()');
  });
});
