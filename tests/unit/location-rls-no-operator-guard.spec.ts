/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 D3/L2 static guard (operator decision Q2): no location_* policy, no function such a policy calls (transitively), no membership-fence helper and no dynamically built location policy in scripts/migrations may mention oshal.is_operator. Runs over the real migrations tree (non-vacuous: every location table's policies are read and the tenant-admin helper is reached), and goes red on each planted shape: a bypass policy, a bypass in a helper two calls deep, a dynamic EXECUTE format policy, a later migration that redefines a helper with a bypass, and a planted policy appended to the real 175 file. Prose (comments, COMMENT ON strings) and policies on non-location tables are not flagged.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCATION_TABLES } from '@/features/location';
import { scanForOperatorBypass, scanMigrationsDir, stripSqlProse } from '../helpers/location-rls-guard';

const MIGRATIONS = path.resolve(__dirname, '../../scripts/migrations');
const realFiles = (): Array<readonly [string, string]> => fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => [f, fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')] as const);

describe('ADR-169 L2: no oshal.is_operator in any location policy or its helpers', () => {
  it('holds on the real migrations tree and actually reads every location table\'s policies', () => {
    const report = scanMigrationsDir(MIGRATIONS);
    expect(report.bypasses).toEqual([]);
    const tablesWithPolicies = new Set(report.policies.map((p) => p.split('.')[0]));
    expect([...tablesWithPolicies].sort()).toEqual([...LOCATION_TABLES].sort());
    expect(report.functionsChecked).toEqual(expect.arrayContaining([
      'oshal_is_tenant_admin', 'oshal_is_tenant_member', 'location_row_writable', 'location_member_share_admissible',
      'location_guardian_share_admissible', 'location_places_digest', 'oshal_tenant_membership_fence',
    ]));
  });

  it('goes red on a planted bypass policy on a location table, and not on one elsewhere', () => {
    const planted = `CREATE POLICY sneaky ON location_current FOR SELECT USING (current_setting('oshal.is_operator', true) = 'on');
      CREATE POLICY elsewhere ON oshal_tenants FOR SELECT USING (current_setting('oshal.is_operator', true) = 'on');`;
    expect(scanForOperatorBypass([...realFiles(), ['999-planted.sql', planted]]).bypasses).toEqual(['policy location_current.sneaky']);
  });

  it('follows a policy into a helper two calls deep, and honours the last definition of a function', () => {
    const helpers = `CREATE OR REPLACE FUNCTION loc_inner() RETURNS boolean LANGUAGE sql AS $$ SELECT current_setting('oshal.is_operator', true) = 'on' $$;
      CREATE OR REPLACE FUNCTION loc_outer() RETURNS boolean LANGUAGE sql AS $$ SELECT loc_inner() $$;
      CREATE POLICY via_helper ON location_places FOR SELECT USING (loc_outer());`;
    expect(scanForOperatorBypass([['900-a.sql', helpers]]).bypasses).toEqual(['function loc_inner']);
    const redefined = `CREATE OR REPLACE FUNCTION location_row_readable(a text, b text, c uuid) RETURNS boolean LANGUAGE sql STABLE
      AS $$ SELECT current_setting('oshal.is_operator', true) = 'on' $$;`;
    expect(scanForOperatorBypass([...realFiles(), ['999-redefine.sql', redefined]]).bypasses).toEqual(['function location_row_readable']);
  });

});

describe('ADR-169 L2 static guard: the shapes it must catch and must not', () => {
  it('goes red on a policy built dynamically for a location table', () => {
    const dynamic = `DO $x$ BEGIN
      EXECUTE format('CREATE POLICY p ON %I USING (current_setting(''oshal.is_operator'', true) = ''on'')', 'location_devices');
    END $x$;`;
    expect(scanForOperatorBypass([['999-dynamic.sql', dynamic]]).bypasses).toEqual(['dynamic 999-dynamic.sql']);
  });

  it('goes red when the real 175 migration gains a bypass', () => {
    const files = realFiles().map(([f, sql]) => (f === '175-location-storage.sql'
      ? [f, `${sql}\nCREATE POLICY location_observations_root ON location_observations FOR SELECT USING (current_setting('oshal.is_operator', true) = 'on');\n`] as const
      : [f, sql] as const));
    expect(scanForOperatorBypass(files).bypasses).toEqual(['policy location_observations.location_observations_root']);
  });

  it('treats comments and COMMENT ON strings as prose, not policy', () => {
    const prose = `-- a location_ policy never uses oshal.is_operator
      /* nor is_operator here */
      COMMENT ON FUNCTION oshal_is_tenant_admin(text) IS 'oshal.is_operator is not consulted';
      CREATE POLICY honest ON location_settings FOR SELECT USING (true);`;
    expect(stripSqlProse(prose)).not.toContain('is_operator');
    expect(scanForOperatorBypass([['999-prose.sql', prose]]).bypasses).toEqual([]);
  });
});
