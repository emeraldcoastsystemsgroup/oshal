/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR                          | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Phase 0 tool-exec hardening: guardTemplateValue (NUL byte => FatalToolError; oversize => recoverable Error; normal => pass) and the FatalToolError contract the agentic loop uses to halt instead of retry.
 */

import { describe, it, expect } from 'vitest';
import { guardTemplateValue, MAX_TEMPLATE_VALUE_BYTES } from '../../src/features/chat-orchestration/services/runtime-template-guard';
import { FatalToolError } from '../../src/features/chat-orchestration/services/fatal-tool-error';

const NUL = String.fromCharCode(0);

describe('guardTemplateValue', () => {
  it('passes ordinary values (including spaces, quotes, unicode)', () => {
    expect(() => guardTemplateValue('hello world', 'input.q')).not.toThrow();
    expect(() => guardTemplateValue("it's a {test} \"value\"", 'input.q')).not.toThrow();
    expect(() => guardTemplateValue('café — ✓', 'input.q')).not.toThrow();
    expect(() => guardTemplateValue('', 'input.q')).not.toThrow();
  });

  it('throws FatalToolError on a NUL byte (integrity violation, halts task)', () => {
    let caught: unknown;
    try {
      guardTemplateValue(`abc${NUL}def`, 'input.q');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FatalToolError);
    expect((caught as FatalToolError).reason).toBe('input-integrity');
  });

  it('throws a plain (recoverable) Error when over the size cap', () => {
    const big = 'x'.repeat(MAX_TEMPLATE_VALUE_BYTES + 1);
    let caught: unknown;
    try {
      guardTemplateValue(big, 'input.q');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(FatalToolError);
  });

  it('allows a value exactly at the size cap', () => {
    const atCap = 'x'.repeat(MAX_TEMPLATE_VALUE_BYTES);
    expect(() => guardTemplateValue(atCap, 'input.q')).not.toThrow();
  });

  it('respects an explicit smaller cap', () => {
    expect(() => guardTemplateValue('xxxxx', 'input.q', 4)).toThrow(/exceeds 4 bytes/);
    expect(() => guardTemplateValue('xxxx', 'input.q', 4)).not.toThrow();
  });
});

describe('FatalToolError', () => {
  it('is an Error with a name and reason', () => {
    const e = new FatalToolError('boom', 'sandbox');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('FatalToolError');
    expect(e.reason).toBe('sandbox');
    expect(e.message).toBe('boom');
  });

  it('defaults reason to "fatal"', () => {
    expect(new FatalToolError('x').reason).toBe('fatal');
  });
});
