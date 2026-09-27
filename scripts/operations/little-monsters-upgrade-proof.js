/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Automated, read-only AUTH-07 acceptance for a Little Monsters upgrade over installed assignments. Run it AFTER the new package version is staged: as the operator's own PAT (OSHAL_VERIFY_OPERATOR_PAT, read by name, never printed) it reads Access Administration and asserts that little-monsters is registered with its catalog at or above the expected version, that the installation recorded a catalog-migration onto exactly the running catalog revision, that the migration removed no grant and every assignment it carried is still present, and that no review for that revision is left pending. It stages nothing and writes nothing, so there is nothing to clean up. Exit 0 pass, 1 fail, 2 missing input.
 */
'use strict';

const DEFAULT_APP = 'little-monsters';
const DEFAULT_FLOOR = '1.4.4';
const AUDIT_PAGE = 100;
const AUDIT_PAGES = 20;

/**
 * @description Compare a dotted package version with a dotted floor.
 * @param {string} value Installed version. @param {string} floor Minimum version.
 * @returns {boolean} True when value is at least floor.
 */
function atLeast(value, floor) {
  const parts = String(value || '').split('.').map((part) => Number.parseInt(part, 10));
  const minimum = String(floor).split('.').map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < minimum.length; index += 1) {
    const part = Number.isFinite(parts[index]) ? parts[index] : -1;
    if (part !== minimum[index]) return part > minimum[index];
  }
  return true;
}

/**
 * @description Judge the three read-only bodies. Pure, so the guard can drive it without a server.
 * @param {{ catalog: object, audit: object[], migrations: object[] }} bodies GET /catalog, the
 * application's audit entries (newest first) and GET /catalog-migrations for the application.
 * @param {{ app?: string, floor?: string }} [options] Application and minimum version.
 * @returns {{ ok: boolean, problems: string[], version: string | null, catalogRevision: string | null,
 *   carried: number, migrationRevision: number | null }} The verdict and every missing piece.
 */
function verdict(bodies, options = {}) {
  const appName = options.app || DEFAULT_APP; const floor = options.floor || DEFAULT_FLOOR;
  const problems = [];
  const apps = Array.isArray(bodies.catalog && bodies.catalog.apps) ? bodies.catalog.apps : [];
  const app = apps.find((row) => row && row.app === appName);
  if (!app) return { ok: false, problems: [`${appName} is not registered with Access Administration (not loaded, or unreadable to this operator)`], version: null, catalogRevision: null, carried: 0, migrationRevision: null };
  if (app.status !== 'catalog') problems.push(`${appName} is registered as ${app.status}, not with its permission catalog`);
  if (!atLeast(app.version, floor)) problems.push(`${appName} is registered at ${app.version}, below ${floor}`);
  const present = new Set((Array.isArray(bodies.catalog.assignments) ? bodies.catalog.assignments : [])
    .filter((row) => row && row.app === appName).map((row) => row.id));
  const migration = (bodies.audit || []).find((entry) => entry && entry.action === 'catalog-migration' && entry.migration
    && entry.migration.toRevision === app.catalogRevision);
  if (!migration) problems.push(`no catalog-migration onto the running catalog revision ${String(app.catalogRevision).slice(0, 12)} is recorded for ${appName}`);
  const detail = migration ? migration.migration : { assignmentIds: [], removedIds: [] };
  if (detail.removedIds.length) problems.push(`the migration removed ${detail.removedIds.length} grant(s)`);
  const missing = detail.assignmentIds.filter((id) => !detail.removedIds.includes(id) && !present.has(id));
  if (missing.length) problems.push(`${missing.length} carried assignment(s) are no longer present`);
  const pending = (bodies.migrations || []).filter((row) => row && row.toRevision === app.catalogRevision && row.status === 'pending');
  if (pending.length) problems.push(`review ${pending[0].previewId} for the running revision is still pending`);
  return { ok: problems.length === 0, problems, version: app.version, catalogRevision: app.catalogRevision,
    carried: detail.assignmentIds.length - detail.removedIds.length, migrationRevision: migration ? migration.revision : null };
}

/**
 * @description GET one Access Administration read as the operator. Never prints the token.
 * @param {string} base Swarm origin. @param {string} path API path. @param {string} token Operator PAT.
 * @returns {Promise<object>} The JSON body.
 */
async function read(base, path, token) {
  const response = await fetch(`${base}/api/authorization${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`GET /api/authorization${path.split('?')[0]} answered ${response.status}`);
  return response.json();
}

/**
 * @description Follow the application's applied-change history until a catalog migration is found.
 * @param {string} base Swarm origin. @param {string} app Application. @param {string} token Operator PAT.
 * @returns {Promise<object[]>} Audit entries, newest first.
 */
async function readAudit(base, app, token) {
  const entries = []; let cursor = null;
  for (let page = 0; page < AUDIT_PAGES; page += 1) {
    const query = new URLSearchParams({ app, limit: String(AUDIT_PAGE), ...(cursor ? { cursor } : {}) });
    const body = await read(base, `/audit?${query.toString()}`, token);
    entries.push(...(body.entries || []));
    if (entries.some((entry) => entry.action === 'catalog-migration') || !body.nextCursor) break;
    cursor = body.nextCursor;
  }
  return entries;
}

/**
 * @description Read the installed swarm as the operator and print the verdict.
 * @returns {Promise<number>} Process exit code.
 */
async function main() {
  const token = (process.env.OSHAL_VERIFY_OPERATOR_PAT || '').trim();
  const base = (process.env.OSHAL_VERIFY_BASE_URL || `http://127.0.0.1:${process.env.PORT || '5000'}`).replace(/\/+$/, '');
  const app = (process.env.OSHAL_UPGRADE_PROOF_APP || DEFAULT_APP).trim();
  const floor = (process.env.OSHAL_UPGRADE_PROOF_MIN_VERSION || DEFAULT_FLOOR).trim();
  const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 1)}\n`);
  if (!token) { print({ ok: false, detail: 'OSHAL_VERIFY_OPERATOR_PAT is required (a session-minted operator PAT)' }); return 2; }
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(app) || !/^\d+(\.\d+)*$/.test(floor)) { print({ ok: false, detail: 'invalid application or version floor' }); return 2; }
  let bodies;
  try {
    bodies = { catalog: await read(base, '/catalog', token), audit: await readAudit(base, app, token),
      migrations: (await read(base, `/catalog-migrations?app=${app}`, token)).migrations || [] };
  } catch (error) {
    print({ ok: false, detail: error && error.message ? error.message : 'Access Administration unreachable' });
    return 1;
  }
  const result = verdict(bodies, { app, floor });
  print({ app, floor, ...result });
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, () => {
    process.stdout.write(`${JSON.stringify({ ok: false, detail: 'upgrade verification failed' })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { verdict, atLeast, DEFAULT_APP, DEFAULT_FLOOR };
