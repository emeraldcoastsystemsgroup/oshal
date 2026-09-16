/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the 2026-09-15 fault where a Jarvis turn answered an empty prompt: the assembled message is carried through the REAL prompt-containment boundary the bot node applies, and the user's question must still be inside the kept window when the context blocks are larger than that window; the typed access tools spend their operations/targets JSON only on an access ask; and the Haven long-tail search is given the user's own words, capped, with a time budget that degrades to the hot core instead of holding the turn.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review findings: an attachment-heavy turn must keep BOTH the ask and the tool guardrails in the window (framing is clipped per attachment, not in aggregate), a bare catalog render still lists the exact access operations, and access wording is matched by stem.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { assembleJarvisBotMessage, buildToolsBlock } from '../../src/app/routes/jarvis-tool-catalog';
import { wrapUntrustedPromptContent } from '../../src/features/swarm-orchestration/services/prompt-containment';

/** The live fault: context blocks far larger than the node's untrusted-content window. */
const HUGE_CONTEXT = `YOUR TOOLS: shell out to these.\n${'- a tool line with keywords and context.\n'.repeat(2_000)}`;
/** Two attached documents, each clipped to MAX_DOC_CHARS — larger than the whole window on their own. */
const HUGE_FRAMING = `[attachment digest]\n${'attached document text. '.repeat(1_100)}`;
const QUESTION = 'How did we do in the stock market today?';
/** The line that tells the model these are its only shell tools; it must never be truncated away. */
const GUARDRAIL = 'These are your ONLY shell tools';

/** Read the content the node would actually hand the model out of the contained record. */
function containedContent(text: string): string {
  const wrapped = wrapUntrustedPromptContent('direct-request', text);
  const json = wrapped.replace('<UNTRUSTED_CONTENT>', '').replace('</UNTRUSTED_CONTENT>', '');
  return String((JSON.parse(json) as { content: string }).content);
}

describe('the user question survives the bot node prompt containment', () => {
  it('keeps the question when the context blocks are larger than the whole window', () => {
    expect(HUGE_CONTEXT.length).toBeGreaterThan(24_000);
    const assembled = assembleJarvisBotMessage(HUGE_CONTEXT, '', QUESTION);
    // The REAL containment the node applies to a direct prompt (bot-node-execution-handler ->
    // assemblePromptForAnyBot -> wrapUntrustedPromptContent). Nothing here is doubled.
    expect(containedContent(assembled)).toContain(QUESTION);
  });

  it('would have lost the question with the context first — the shape that failed live', () => {
    const contextFirst = `${HUGE_CONTEXT}\n\n---\n\n${QUESTION}`;
    expect(containedContent(contextFirst)).not.toContain(QUESTION);
  });

  it('keeps the question AND the tool guardrails when the attachments alone exceed the window', () => {
    expect(HUGE_FRAMING.length).toBeGreaterThan(24_000);
    const tools = buildToolsBlock({ message: QUESTION, surface: 'jarvis' });
    expect(tools).toContain(GUARDRAIL);
    const kept = containedContent(assembleJarvisBotMessage(tools, HUGE_FRAMING, QUESTION));
    expect(kept).toContain(QUESTION);
    expect(kept).toContain(GUARDRAIL);
  });

  it('would have lost the question with the attachments ahead of it', () => {
    const framingFirst = `${HUGE_FRAMING}\n\n---\n\n${QUESTION}`;
    expect(containedContent(framingFirst)).not.toContain(QUESTION);
  });

  it('returns the message alone when there is no context and no framing', () => {
    expect(assembleJarvisBotMessage('', '', QUESTION)).toBe(QUESTION);
  });

  it('repeats the question as the closing line on a turn that fits', () => {
    const assembled = assembleJarvisBotMessage('SMALL CONTEXT', 'SMALL FRAMING', QUESTION);
    expect(assembled.trimEnd().endsWith(QUESTION)).toBe(true);
    expect(containedContent(assembled).trimEnd().endsWith(QUESTION)).toBe(true);
  });
});

describe('typed access tools spend their operations/targets JSON only when it is worth the window', () => {
  const authorizationTools = [{
    name: 'swarm_authorization',
    operations: Array.from({ length: 40 }, (_, i) => `operation_${i}`),
    targets: Array.from({ length: 400 }, (_, i) => ({ app: `app-${i}`, tenantId: `tenant-${i}`, label: `A target ${i}` })),
  }] as never;

  it('names the tool and its size for an unrelated ask, without the full JSON', () => {
    const block = buildToolsBlock({ message: QUESTION, surface: 'jarvis', authorizationTools });
    expect(block).toContain('TYPED APPLICATION ACCESS TOOLS');
    expect(block).toContain('registered operations over');
    expect(block).not.toContain('"app-399"');
  });

  it('lists the exact operations and targets when the ask IS about access', () => {
    const block = buildToolsBlock({
      message: 'grant me access permissions to that application', surface: 'jarvis', authorizationTools,
    });
    expect(block).toContain('operations=');
    expect(block).toContain('"app-399"');
  });

  it('matches access wording by stem, not just the catalog plural', () => {
    for (const ask of ["revoke Sarah's role on the CRM", 'make Bob an admin', 'who can see the trading app?']) {
      const block = buildToolsBlock({ message: ask, surface: 'jarvis', authorizationTools });
      expect(block, ask).toContain('operations=');
    }
  });

  it('lists everything when there is no ask to judge relevance from', () => {
    const block = buildToolsBlock({ authorizationTools });
    expect(block).toContain('operations=');
    expect(block).toContain('"app-399"');
  });
});

describe('the Haven long-tail search cannot hold up a turn', () => {
  const ORIGINAL_ENV = { ...process.env };
  const pool = { query: async () => ({ rows: [] }) } as never;

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
    vi.restoreAllMocks();
  });

  /** Load the service with a doubled RagService so the search's timing is controlled, not the DB's. */
  async function loadWithSearch(search: (...args: unknown[]) => Promise<unknown>) {
    vi.resetModules();
    vi.doMock('@/features/rag', () => ({ RagService: class { search = search; } }));
    vi.doMock('../../src/features/user-model/services/user-model-service', () => ({
      UserModelService: class { getFacts = async () => []; },
    }));
    vi.doMock('../../src/features/user-model/services/user-model-logic', () => ({
      renderHotCore: () => 'HOT CORE',
      buildExtractionPrompt: () => '',
      parseExtraction: () => ({ facts: [], narrative: '' }),
    }));
    return import('../../src/features/user-model/services/haven-context-service');
  }

  it('searches with the user own words, not the assembled prompt, and caps the query', async () => {
    const seen: string[] = [];
    const mod = await loadWithSearch(async (query: unknown) => { seen.push(String(query)); return []; });
    const assembled = `${HUGE_CONTEXT}\n\n---\n\n${QUESTION}`;
    await mod.buildHavenPreamble(pool, 'user-1', assembled, QUESTION);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(QUESTION);
    expect(seen[0].length).toBeLessThanOrEqual(512);
  });

  it('drops the long-tail when the search runs past its budget, and still returns the hot core', async () => {
    process.env.HAVEN_LONG_TAIL_TIMEOUT_MS = '250';
    const mod = await loadWithSearch(() => new Promise(() => { /* never settles: the live 100 s search */ }));
    const started = Date.now();
    const preamble = await mod.buildHavenPreamble(pool, 'user-1', QUESTION, QUESTION);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(preamble).toContain('HOT CORE');
    expect(preamble).not.toContain('Possibly relevant older memories');
  });

  it('uses the long-tail when the search answers inside the budget', async () => {
    process.env.HAVEN_LONG_TAIL_TIMEOUT_MS = '2000';
    const mod = await loadWithSearch(async () => [{ text: 'he trades a live book and a paper book' }]);
    const preamble = await mod.buildHavenPreamble(pool, 'user-1', QUESTION, QUESTION);
    expect(preamble).toContain('Possibly relevant older memories');
    expect(preamble).toContain('live book');
  });
});
