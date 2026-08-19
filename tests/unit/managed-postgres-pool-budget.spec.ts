/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the declared CRM connection budget: pool-max resolution bounds, per-service application_name stamping, and the 23-of-47 launch ceiling against DigitalOcean's 2 GiB tier.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  postgresApplicationName,
  resolvePoolMax,
} from '../../src/shared/services/database/pool-sizing';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.resolve(root, relative), 'utf8');

describe('managed PostgreSQL pool budget', () => {
  it('accepts valid ceilings, clamps oversized values, and rejects ambiguous inputs', () => {
    expect(resolvePoolMax('8', 20)).toBe(8);
    expect(resolvePoolMax('2', 20, 2)).toBe(2);
    expect(resolvePoolMax('1', 20, 2)).toBe(2);
    expect(resolvePoolMax('1000', 20, 1, 100)).toBe(100);
    expect(resolvePoolMax('1.5', 20)).toBe(20);
    expect(resolvePoolMax('0', 20)).toBe(20);
    expect(resolvePoolMax('-1', 20)).toBe(20);
    expect(resolvePoolMax('not-a-number', 20)).toBe(20);
    expect(resolvePoolMax(undefined, 20)).toBe(20);
  });

  it('produces bounded, observable pg_stat_activity application names', () => {
    expect(postgresApplicationName('sales bot / primary', 'fallback')).toBe('sales-bot-primary');
    expect(postgresApplicationName(' ', 'oshal-api-main')).toBe('oshal-api-main');
    expect(postgresApplicationName('x'.repeat(100), 'fallback')).toHaveLength(63);
  });

  it('wires independent API, optional, RAG, and bot ceilings', () => {
    expect(read('src/app/composition/app-runtime-factory.ts')).toContain(
      "resolvePoolMax(process.env.OSHAL_DB_POOL_MAX, 20)",
    );
    expect(read('src/shared/services/database/optional-postgres-pool.ts')).toContain(
      "resolvePoolMax(process.env.PGPOOL_MAX, 20, 2)",
    );
    expect(read('src/features/rag/services/pgvector-rag-engine.ts')).toContain(
      "resolvePoolMax(process.env.RAG_DB_POOL_MAX, 4)",
    );
    expect(read('src/app/bot-node-runtime.ts')).toContain(
      "resolvePoolMax(process.env.DB_MAX_CONNECTIONS, 5)",
    );
  });

  it('lets direct DATABASE_URL own verify-full TLS parsing', () => {
    const source = read('src/shared/services/database/optional-postgres-pool.ts');
    const directBranch = source.match(
      /if \(typeof directUrl[\s\S]*?return \{([\s\S]*?)\n\s*\};/,
    );
    expect(directBranch).not.toBeNull();
    expect(directBranch?.[1]).toContain('connectionString: directUrl.trim()');
    expect(directBranch?.[1]).not.toMatch(/\bssl\s*:/);
  });
});
