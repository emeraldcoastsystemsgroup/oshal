/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for migration 094 (ADR-076 Phase 2 — derived-owner RLS on the five table families 060 deferred): per table ENABLE + FORCE ROW LEVEL SECURITY + the named policy must exist; chat_messages/agent_memories policies must derive ownership via oshal_owns_task(task_id); the helper must be SECURITY DEFINER with a pinned search_path; the knowledge WITH CHECK must NOT carry the owner_sub IS NULL arm (forged-shared-doc hole); personal_graph policies must require a NON-EMPTY user_sub (anonymous connections are GUC-stamped ''); personal_graph gains the (user_sub,id) composite PK; and the file must stay transaction-safe under the runner (no top-level BEGIN;/COMMIT;, no CONCURRENTLY). Goes red if any of it is dropped or weakened.
 */

/**
 * @module tests/unit/rls-derived-owner-migration
 * @description Static regression guard over scripts/migrations/094-derived-owner-rls.sql — the
 * migration that closes migration 060's DEFERRED block. It pins the isolation-bearing shape of the
 * SQL so a future edit cannot silently drop FORCE RLS, weaken a policy arm, or make the file
 * non-atomic under the transactional migration runner. Complements the live A/B prover
 * (scripts/governance/verify-rls-isolation.mjs) which needs a running stack; this spec runs
 * offline in every CI pass.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  NO_TRANSACTION_PRAGMA,
  PRAGMA_SCAN_LINES,
  TOP_LEVEL_TXN_CONTROL,
} from '../../src/features/tool-registry/services/database-bootstrap-service';

const MIGRATION = path.resolve(__dirname, '../../scripts/migrations/094-derived-owner-rls.sql');
const sql = fs.readFileSync(MIGRATION, 'utf8');

/** The five tables 060 deferred that 094 must cover (lm_* ships from the store repo — Rule 0c). */
const COVERED_TABLES: Array<{ table: string; policy: string }> = [
  { table: 'chat_messages', policy: 'chat_messages_task_owner_or_operator' },
  { table: 'agent_memories', policy: 'agent_memories_task_owner_or_operator' },
  { table: 'knowledge_memory_documents', policy: 'knowledge_memory_documents_shared_or_owner' },
  { table: 'personal_graph_nodes', policy: 'personal_graph_nodes_owner_or_operator' },
  { table: 'personal_graph_edges', policy: 'personal_graph_edges_owner_or_operator' },
];

/**
 * @description Extract the full CREATE POLICY statement for a named policy from the migration.
 *
 * @param policy - Policy name to locate
 * @returns The statement text from CREATE POLICY up to its terminating semicolon
 */
function policyStatement(policy: string): string {
  const start = sql.indexOf(`CREATE POLICY ${policy} `);
  expect(start, `CREATE POLICY ${policy} must exist in 094`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf(';', start);
  return sql.slice(start, end);
}

describe('094-derived-owner-rls.sql — derived-owner RLS shape', () => {
  it('exists at the expected path', () => {
    expect(fs.existsSync(MIGRATION)).toBe(true);
  });

  it.each(COVERED_TABLES)('$table: ENABLE + FORCE ROW LEVEL SECURITY + named policy', ({ table, policy }) => {
    expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
    expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    // DROP IF EXISTS + CREATE keeps the file re-runnable without a policy-less window
    // (the whole file runs in one runner-owned transaction).
    expect(sql).toContain(`DROP POLICY IF EXISTS ${policy} ON ${table};`);
    expect(sql).toContain(`CREATE POLICY ${policy} ON ${table}`);
  });

  it('oshal_owns_task is SECURITY DEFINER with a pinned search_path and consults chat_tasks.owner_sub', () => {
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION oshal_owns_task');
    expect(start).toBeGreaterThanOrEqual(0);
    const fn = sql.slice(start, sql.indexOf('$$;', start));
    expect(fn).toContain('SECURITY DEFINER');
    expect(fn).toMatch(/SET search_path = public, pg_temp/);
    expect(fn).toContain('FROM chat_tasks');
    expect(fn).toMatch(/owner_sub = current_setting\('oshal\.current_sub', true\)/);
    // Definer functions must not stay executable-by-default without the explicit grant pair.
    expect(sql).toContain('REVOKE ALL ON FUNCTION oshal_owns_task(text) FROM PUBLIC;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION oshal_owns_task(text) TO PUBLIC;');
  });

  it.each(['chat_messages_task_owner_or_operator', 'agent_memories_task_owner_or_operator'])(
    '%s derives ownership through oshal_owns_task(task_id) in BOTH policy arms',
    (policy) => {
      const stmt = policyStatement(policy);
      const usingArm = stmt.slice(stmt.indexOf('USING'), stmt.indexOf('WITH CHECK'));
      const checkArm = stmt.slice(stmt.indexOf('WITH CHECK'));
      for (const arm of [usingArm, checkArm]) {
        expect(arm).toContain('oshal_owns_task(task_id)');
        expect(arm).toMatch(/current_setting\('oshal\.is_operator', true\) = 'on'/);
      }
    },
  );

  it('knowledge USING keeps NULL=shared readable, but WITH CHECK must NOT carry the owner_sub IS NULL arm', () => {
    const stmt = policyStatement('knowledge_memory_documents_shared_or_owner');
    const usingArm = stmt.slice(stmt.indexOf('USING'), stmt.indexOf('WITH CHECK'));
    const checkArm = stmt.slice(stmt.indexOf('WITH CHECK'));
    // Read side mirrors memory-layer-service.ts: shared (NULL) docs plus the caller's own.
    expect(usingArm).toMatch(/owner_sub IS NULL/);
    expect(usingArm).toMatch(/owner_sub = current_setting\('oshal\.current_sub', true\)/);
    // Write side is stricter: a non-operator minting owner_sub = NULL would forge a doc every
    // user can read. Only the operator/system arm may create shared docs.
    expect(checkArm).not.toMatch(/owner_sub IS NULL/);
    expect(checkArm).toMatch(/owner_sub = current_setting\('oshal\.current_sub', true\)/);
  });

  it.each(['personal_graph_nodes_owner_or_operator', 'personal_graph_edges_owner_or_operator'])(
    '%s requires a NON-EMPTY user_sub in both arms (anonymous connections are stamped \'\')',
    (policy) => {
      const stmt = policyStatement(policy);
      const usingArm = stmt.slice(stmt.indexOf('USING'), stmt.indexOf('WITH CHECK'));
      const checkArm = stmt.slice(stmt.indexOf('WITH CHECK'));
      for (const arm of [usingArm, checkArm]) {
        expect(arm).toMatch(/user_sub <> ''/);
        expect(arm).toMatch(/user_sub = current_setting\('oshal\.current_sub', true\)/);
      }
    },
  );

  it('re-points the personal_graph primary keys to the composite (user_sub, id)', () => {
    expect(sql).toMatch(/ADD CONSTRAINT %I PRIMARY KEY \(user_sub, id\)/);
    // The owner column must exist NOT NULL with the fail-closed '' default before the PK swap.
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS user_sub TEXT NOT NULL DEFAULT/);
  });

  it('adds the knowledge owner_sub column itself (fresh-DB order safety vs the lazy in-app DDL)', () => {
    expect(sql).toContain('ALTER TABLE knowledge_memory_documents ADD COLUMN IF NOT EXISTS owner_sub TEXT;');
  });

  it('stays transaction-safe under the migration runner: no top-level BEGIN;/COMMIT;, no pragma, no CONCURRENTLY', () => {
    // The runner must wrap this file + its history row in ONE transaction, so a mid-file failure
    // can never strand a table with RLS forced but no policy. Self-managing or opting out would
    // reopen exactly that window.
    expect(TOP_LEVEL_TXN_CONTROL.test(sql)).toBe(false);
    const pragmaPresent = sql
      .split(/\r?\n/, PRAGMA_SCAN_LINES)
      .some((line) => NO_TRANSACTION_PRAGMA.test(line));
    expect(pragmaPresent).toBe(false);
    // Comments legitimately explain WHY CONCURRENTLY is banned — check executable SQL only.
    const withoutComments = sql
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    expect(withoutComments).not.toMatch(/CONCURRENTLY/i);
  });

  it('leaves lm_* to the store repo explicitly (Rule 0c) rather than silently omitting it', () => {
    expect(sql).toMatch(/lm_\*/);
    expect(sql).toMatch(/store/i);
  });
});
