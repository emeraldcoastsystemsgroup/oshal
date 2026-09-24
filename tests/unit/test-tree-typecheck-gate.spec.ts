/**
 * tests/unit/test-tree-typecheck-gate.spec.ts
 * =============================================================================
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                   | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com | Unit tests guarding the test-tree typecheck gate contract.
 * =============================================================================
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { evaluateTypecheck, loadQuarantine } from '../../scripts/ci/check-tests-typecheck.mjs';

describe('Test-tree typecheck gate contract', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const tsconfigTestsPath = path.join(repoRoot, 'tsconfig.tests.json');
  const tsconfigPath = path.join(repoRoot, 'tsconfig.json');
  const quarantinePath = path.join(repoRoot, 'tests/typecheck-quarantine.json');

  it('declares tsconfig.tests.json without widening production tsconfig.json', () => {
    expect(fs.existsSync(tsconfigTestsPath)).toBe(true);
    expect(fs.existsSync(tsconfigPath)).toBe(true);

    const tsconfigTests = JSON.parse(fs.readFileSync(tsconfigTestsPath, 'utf8'));
    const tsconfigProd = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));

    // Production tsconfig excludes tests/ so dist/ remains unpolluted
    expect(tsconfigProd.exclude).toContain('tests');
    expect(tsconfigProd.compilerOptions.outDir).toBe('./dist');

    // Tests tsconfig includes tests/ and sets noEmit
    expect(tsconfigTests.compilerOptions.noEmit).toBe(true);
    expect(tsconfigTests.include.some((p: string) => p.includes('tests/'))).toBe(true);
  });

  it('requires every quarantine entry to carry a non-empty reason', () => {
    const quarantine = loadQuarantine(quarantinePath);
    expect(quarantine.version).toBe(1);
    expect(quarantine.entries.length).toBeGreaterThan(0);
    expect(quarantine.totalQuarantined).toBe(quarantine.entries.length);

    for (const entry of quarantine.entries) {
      expect(entry.file).toBeDefined();
      expect(entry.code).toMatch(/^TS\d+$/);
      expect(typeof entry.reason).toBe('string');
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      expect(entry.reason.toLowerCase()).toContain('pre-existing');
    }
  });

  it('passes when compiler errors match the quarantine ledger', () => {
    const mockQuarantine = {
      version: 1,
      totalQuarantined: 2,
      entries: [
        {
          file: 'tests/unit/example.spec.ts',
          line: 10,
          col: 5,
          code: 'TS2322',
          message: "Type 'string' is not assignable to type 'number'.",
          reason: 'Pre-existing: Mock type mismatch',
        },
        {
          file: 'tests/unit/example.spec.ts',
          line: 25,
          col: 3,
          code: 'TS2493',
          message: "Tuple type '[sql: string]' of length '1' has no element at index '1'.",
          reason: 'Pre-existing: Mock query tuple length',
        },
      ],
    };

    const mockErrors = [
      {
        file: 'tests/unit/example.spec.ts',
        line: 10,
        col: 5,
        code: 'TS2322',
        message: "Type 'string' is not assignable to type 'number'.",
      },
      {
        file: 'tests/unit/example.spec.ts',
        line: 25,
        col: 3,
        code: 'TS2493',
        message: "Tuple type '[sql: string]' of length '1' has no element at index '1'.",
      },
    ];

    const result = evaluateTypecheck(mockErrors, mockQuarantine);
    expect(result.unquarantined).toHaveLength(0);
    expect(result.quarantinedCount).toBe(2);
    expect(result.staleCount).toBe(0);
  });

  it('reddens when an unquarantined type error appears', () => {
    const mockQuarantine = {
      version: 1,
      totalQuarantined: 1,
      entries: [
        {
          file: 'tests/unit/example.spec.ts',
          line: 10,
          col: 5,
          code: 'TS2322',
          message: "Type 'string' is not assignable to type 'number'.",
          reason: 'Pre-existing: Mock type mismatch',
        },
      ],
    };

    const mockErrors = [
      {
        file: 'tests/unit/example.spec.ts',
        line: 10,
        col: 5,
        code: 'TS2322',
        message: "Type 'string' is not assignable to type 'number'.",
      },
      {
        file: 'tests/unit/broken.spec.ts',
        line: 42,
        col: 7,
        code: 'TS2339',
        message: "Property 'nonExistent' does not exist on type 'Foo'.",
      },
    ];

    const result = evaluateTypecheck(mockErrors, mockQuarantine);
    expect(result.unquarantined).toHaveLength(1);
    expect(result.unquarantined[0].file).toBe('tests/unit/broken.spec.ts');
    expect(result.unquarantined[0].code).toBe('TS2339');
  });

  it('detects resolved (stale) quarantine entries when errors are fixed', () => {
    const mockQuarantine = {
      version: 1,
      totalQuarantined: 2,
      entries: [
        {
          file: 'tests/unit/example.spec.ts',
          line: 10,
          col: 5,
          code: 'TS2322',
          message: "Type 'string' is not assignable to type 'number'.",
          reason: 'Pre-existing: Mock type mismatch',
        },
        {
          file: 'tests/unit/fixed.spec.ts',
          line: 20,
          col: 5,
          code: 'TS2322',
          message: "Type 'string' is not assignable to type 'number'.",
          reason: 'Pre-existing: Now resolved',
        },
      ],
    };

    // Only one error remains; the second was fixed
    const mockErrors = [
      {
        file: 'tests/unit/example.spec.ts',
        line: 10,
        col: 5,
        code: 'TS2322',
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ];

    const result = evaluateTypecheck(mockErrors, mockQuarantine);
    expect(result.unquarantined).toHaveLength(0);
    expect(result.quarantinedCount).toBe(1);
    expect(result.staleCount).toBe(1);
  });

  it('throws when a quarantine entry is missing its reason', () => {
    const invalidQuarantine = {
      version: 1,
      totalQuarantined: 1,
      entries: [
        {
          file: 'tests/unit/example.spec.ts',
          line: 10,
          col: 5,
          code: 'TS2322',
          message: "Type 'string' is not assignable to type 'number'.",
          reason: '', // Empty reason
        },
      ],
    };

    expect(() => evaluateTypecheck([], invalidQuarantine)).toThrow(/missing reason/);
  });
});
