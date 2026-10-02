/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the test-engineer persona's execution contract (ai-lab/bot-personas/test-engineer.yaml). A build ticket on 2026-10-02 completed with one failing test the test-engineer had written, next to a handover saying "fully verified": the persona's Execute step allowed "trace code execution mentally". This reads the persona the bots are mounted with and proves: the Execute step names the toolchain run and refuses a verdict without executed output; the mental-trace wording is gone; a failing or unrun test is Partial, never Complete; the implementation under test is not edited. It is a text contract, so it guards the wording, not the model; the live proof is the review ticket re-run recorded in COLLABORATE.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PERSONA = resolve(__dirname, '../../ai-lab/bot-personas/test-engineer.yaml');

/**
 * @description The `perspective: |` block of the persona, which is the bot's whole system prompt.
 * @returns The block's text.
 */
function perspective(): string {
  const text = readFileSync(PERSONA, 'utf8');
  const match = /^perspective: \|\r?\n([\s\S]*?)^(?=\S)/m.exec(text);
  if (!match) throw new Error('test-engineer.yaml has no perspective block');
  return match[1] as string;
}

describe('test-engineer persona: execution contract', () => {
  const text = perspective();

  it('the Execute step runs the suite with the workspace toolchain and refuses a verdict without executed output', () => {
    const step = /3\. \*\*Execute\*\*[\s\S]*?(?=\n\s*4\. \*\*Report\*\*)/.exec(text);
    expect(step, 'Execute step').not.toBeNull();
    expect(step![0]).toMatch(/npx vitest run/);
    expect(step![0]).toMatch(/a verdict without executed output is not a verdict/i);
  });

  it('mental tracing is no longer an accepted form of execution', () => {
    expect(text).not.toMatch(/trace code execution mentally/i);
  });

  it('a failing or unrun test is a Partial handover and a FAIL verdict, named', () => {
    expect(text).toMatch(/\*\*Status:\*\* Complete \(every test executed and green\) \| Partial \(any test failing, not run, or blocked\)/);
    expect(text).toMatch(/Any failing or unrun test makes the verdict FAIL and the handover Status Partial, naming the test/);
    expect(text).toMatch(/reported\s+as NOT RUN with the reason/);
    expect(text).not.toMatch(/"Nothing — fully validated"/);
  });

  it('the implementation under test is reported on, never edited', () => {
    expect(text).toMatch(/You DO NOT edit the implementation under test, even to make your test pass/);
  });
});
