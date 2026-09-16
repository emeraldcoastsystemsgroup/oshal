/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Static lock coverage for the trading schema bootstraps. The concurrency guard beside this one cannot catch a forgotten lock: its own review showed that the locked books/accounts prologue staggers cold workers enough to hide a single downstream miss, so removing the lock from trading-schema.ts left it green. This reads the tree instead — every trading module that bootstraps through runRuntimeSchemaBootstrap must pass the family lock key, which is the assertion that protects the seventeenth store and the eighteenth. It also NAMES the three trading bootstraps that issue bare DDL and hold no lock, so "the family is serialised" cannot be read as "all of it is".
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_DIR = resolve(__dirname, '..', '..', 'src', 'app');

/** Trading bootstraps that issue DDL directly instead of through the shared helper, and therefore
 *  take no advisory lock. Named so a NEW one cannot join them silently; each is its own hazard. */
const BARE_DDL_BOOTSTRAPS = [
  'trading-bar-store.ts',
  'trading-config-overrides.ts',
  'trading-strategy-lab-store.ts',
];

/** @description Every `src/app/trading-*.ts`, read once. @returns Name and source per file. */
function tradingModules(): Array<{ name: string; source: string }> {
  return readdirSync(APP_DIR)
    .filter(name => name.startsWith('trading-') && name.endsWith('.ts'))
    .map(name => ({ name, source: readFileSync(join(APP_DIR, name), 'utf8') }));
}

describe('every trading schema bootstrap takes the family advisory lock', () => {
  const modules = tradingModules();

  it('read the trading modules at all — an empty sweep would pass every case below', () => {
    expect(modules.length, 'no src/app/trading-*.ts was read; the discovery is broken').toBeGreaterThan(20);
    expect(modules.some(m => m.source.includes('runRuntimeSchemaBootstrap'))).toBe(true);
  });

  it('passes lockKey: SCHEMA_LOCK_KEYS.trading wherever it bootstraps through the shared helper', () => {
    const missing = modules
      .filter(m => m.source.includes('runRuntimeSchemaBootstrap'))
      .filter(m => !/lockKey:\s*SCHEMA_LOCK_KEYS\.trading/.test(m.source))
      .map(m => m.name);
    expect(missing,
      'these trading bootstraps run unlocked, so a concurrent CREATE TABLE IF NOT EXISTS or trigger '
      + 'creation races (23505 / 42710 / 40P01) — add lockKey: SCHEMA_LOCK_KEYS.trading').toEqual([]);
  });

  it('covers the whole family, not a sample', () => {
    const locked = modules.filter(m => /lockKey:\s*SCHEMA_LOCK_KEYS\.trading/.test(m.source));
    // The count is derived, never typed: it is whatever the tree holds today.
    expect(locked.length).toBe(modules.filter(m => m.source.includes('runRuntimeSchemaBootstrap')).length);
    expect(locked.length, 'the family shrank unexpectedly; check whether a store was deleted or renamed')
      .toBeGreaterThanOrEqual(17);
  });

  it('names the bare-DDL bootstraps that hold no lock, so a new one cannot join them quietly', () => {
    const bare = modules
      .filter(m => !m.source.includes('runRuntimeSchemaBootstrap'))
      .filter(m => /CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS|CREATE POLICY/.test(m.source))
      .map(m => m.name)
      .sort();
    expect(bare,
      'a trading module issues DDL outside the shared bootstrap. Either route it through '
      + 'runRuntimeSchemaBootstrap with the family lock, or add it here with its own reason.')
      .toEqual([...BARE_DDL_BOOTSTRAPS].sort());
  });
});
