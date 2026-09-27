/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Automated, read-only acceptance for the enterprise-authorization registration clause on an installed swarm: as the operator's own PAT (OSHAL_VERIFY_OPERATOR_PAT, read by name, never printed) it reads the live AI Test Lab catalog and asserts that core's authorization-management scenario registers the installer-root suites and that the installed Little Monsters package (>= 1.4.5) lists its structural and pilot authorization cases. It writes nothing, so there is nothing to clean up. Exit 0 pass, 1 fail, 2 missing input.
 */
'use strict';

/** Core suites the installed authorization-management scenario must register. */
const REQUIRED_CORE_SUITES = [
  'tests/unit/installer-root-bootstrap.spec.ts',
  'tests/unit/installer-root-oidc-browser.spec.ts',
  'tests/unit/chart-installer-root.spec.ts',
];
/** Pilot package cases the installed Little Monsters catalog must list. */
const REQUIRED_PILOT_CASES = ['structural-roles', 'authorization-groups-delegation', 'authorization-record-rights-postgres', 'authorization-permission-ui'];
const PILOT_APP = 'little-monsters';
const PILOT_FLOOR = [1, 4, 5];

/**
 * @description Compare a dotted package version with a numeric floor.
 * @param {string} value Installed version. @param {number[]} floor Minimum [major, minor, patch].
 * @returns {boolean} True when value is at least floor.
 */
function atLeast(value, floor) {
  const parts = String(value || '').split('.').map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < floor.length; index += 1) {
    const part = Number.isFinite(parts[index]) ? parts[index] : -1;
    if (part !== floor[index]) return part > floor[index];
  }
  return true;
}

/**
 * @description Judge one Test Lab catalog body. Pure, so the guard can drive it without a server.
 * @param {object} catalog Body of GET /api/test-lab/catalog.
 * @returns {{ ok: boolean, problems: string[], pilotVersion: string | null }} The verdict and every missing piece.
 */
function verdict(catalog) {
  const scenarios = Array.isArray(catalog && catalog.scenarios) ? catalog.scenarios : [];
  const problems = [];
  const core = scenarios.find((row) => row.id === 'authorization-management');
  if (!core) problems.push('core scenario authorization-management is not registered');
  for (const path of core ? REQUIRED_CORE_SUITES : []) {
    if (!(core.regressionTests || []).some((test) => test.path === path)) problems.push(`authorization-management does not register ${path}`);
  }
  const pilot = scenarios.filter((row) => row.installedTest && row.installedTest.appName === PILOT_APP);
  if (!pilot.length) problems.push(`${PILOT_APP} has no installed Test Lab cases visible to this operator`);
  for (const caseId of pilot.length ? REQUIRED_PILOT_CASES : []) {
    const row = pilot.find((item) => item.installedTest.caseId === caseId);
    if (!row) problems.push(`${PILOT_APP} case ${caseId} is not installed`);
    else if (!atLeast(row.installedTest.appVersion, PILOT_FLOOR)) {
      problems.push(`${PILOT_APP} case ${caseId} is installed at ${row.installedTest.appVersion}, below ${PILOT_FLOOR.join('.')}`);
    }
  }
  return { ok: problems.length === 0, problems, pilotVersion: pilot[0] ? pilot[0].installedTest.appVersion : null };
}

/**
 * @description Read the live catalog as the operator and print the verdict (never the token).
 * @returns {Promise<number>} Process exit code.
 */
async function main() {
  const token = (process.env.OSHAL_VERIFY_OPERATOR_PAT || '').trim();
  const base = (process.env.OSHAL_VERIFY_BASE_URL || `http://127.0.0.1:${process.env.PORT || '5000'}`).replace(/\/+$/, '');
  const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 1)}\n`);
  if (!token) { print({ ok: false, detail: 'OSHAL_VERIFY_OPERATOR_PAT is required (a session-minted operator PAT)' }); return 2; }
  let response;
  try {
    response = await fetch(`${base}/api/test-lab/catalog`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20000) });
  } catch (error) {
    print({ ok: false, detail: `catalog unreachable at ${base}: ${error && error.name ? error.name : 'error'}` });
    return 1;
  }
  if (!response.ok) { print({ ok: false, detail: `GET /api/test-lab/catalog answered ${response.status}` }); return 1; }
  const result = verdict(await response.json());
  print(result);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, () => {
    process.stdout.write(`${JSON.stringify({ ok: false, detail: 'catalog verification failed' })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { verdict, atLeast, REQUIRED_CORE_SUITES, REQUIRED_PILOT_CASES };
