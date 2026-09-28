/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - live acceptance for ADR-160 S4 (backlog "A vehicle record, and the medium it runs in as a parameter"): seed the Floater through the installed aero-lab's own POST /api/aero-lab/vehicles/floater/seed as the caller, read it back through GET /api/aero-lab/vehicles/:id, and require evaluation 1's mass budget RED at +274.3 g and the stage's fabricable sentence verbatim. The seed is idempotent per owner by name: when the owner already has a Floater the case reads that one and writes nothing; when the case seeded it, it deletes exactly that vehicle (evaluations cascade) through the closed live-acceptance statement set under the owner's identity - the package has no delete route - and proves it gone by row count and by a 404.
 */

'use strict';

const common = require('./live-acceptance-common.js');

const CASE_ID = 'floater-budget-live';
const KEY = 'floater';
const TITLE = 'ADR-160 Floater record: RED +274.3 g budget and the fabricable sentence';
const NEEDS = Object.freeze(['api', 'sql', 'ownerSub']);
const BASE = '/api/aero-lab/vehicles';
/** The certified-vs-as-built excess ADR-160 D6 is about. */
const EXPECTED_DELTA_G = 274.3;
/** ADR-160's fabricable sentence, which every stage view must carry verbatim. */
const FABRICABLE_SENTENCE = 'fabricable means the files are complete and self-consistent. It does not mean the machine is safe to build, fly or wet.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @description Judge the read-back record.
 * @param {{status: number, json: object}} res - GET /api/aero-lab/vehicles/:id.
 * @returns {{ok: boolean, detail: string, budget: object|null}} The judgement.
 */
function judgeRecord(res) {
  if (res.status !== 200) return { ok: false, detail: `GET ${BASE}/:id answered HTTP ${res.status}`, budget: null };
  const body = res.json || {};
  const evaluations = Array.isArray(body.evaluations) ? body.evaluations : [];
  const first = evaluations.find((e) => e && Number(e.sequence) === 1) || evaluations[0];
  const budget = first && first.result && first.result.budget ? first.result.budget : null;
  const problems = [];
  if (!budget) problems.push(`no displayable evaluation carries a mass budget (withheld ${Array.isArray(body.withheld) ? body.withheld.length : 0})`);
  else {
    if (budget.status !== 'red') problems.push(`the budget is ${budget.status}, not red`);
    if (Math.abs(Number(budget.deltaG) - EXPECTED_DELTA_G) > 1e-6) problems.push(`the budget excess is ${budget.deltaG} g, not +${EXPECTED_DELTA_G} g`);
    if (!String(budget.why || '').includes(`+${EXPECTED_DELTA_G} g`)) problems.push('the budget explanation does not name +274.3 g');
  }
  const sentence = body.stage && body.stage.fabricable;
  if (sentence !== FABRICABLE_SENTENCE) problems.push(`the stage's fabricable sentence is ${sentence === undefined ? 'missing' : `"${String(sentence).slice(0, 120)}"`}`);
  if (problems.length) return { ok: false, detail: problems.join('; '), budget };
  return { ok: true, detail: `evaluation ${first.sequence} budget RED at +${budget.deltaG} g (${budget.asBuiltG} g against ${budget.certifiedG} g); stage ${body.stage.stage || 'shown'} carries the fabricable sentence verbatim`, budget };
}

/**
 * @description Seed (or find) the caller's Floater.
 * @param {object} ports - api.
 * @returns {Promise<{status: number, vehicleId: string|null, seeded: boolean, error: string|null}>} The seed outcome.
 */
async function seedFloater(ports) {
  const res = await ports.api('POST', `${BASE}/floater/seed`, {});
  const body = res.json || {};
  const vehicleId = body.vehicle && UUID_RE.test(String(body.vehicle.vehicleId)) ? String(body.vehicle.vehicleId) : null;
  const ok = (res.status === 201 && body.seeded === true) || (res.status === 200 && body.seeded === false);
  return { status: res.status, vehicleId: ok ? vehicleId : null, seeded: res.status === 201 && body.seeded === true,
    error: ok && vehicleId ? null : String(body.error || body.message || `HTTP ${res.status}`) };
}

/**
 * @description Delete the vehicle this run seeded and prove it gone (rows and route).
 * @param {object} ports - api, sql, ownerSub.
 * @param {string} vehicleId - The seeded vehicle.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function removeFloater(ports, vehicleId, ledger) {
  await ledger.attempt(`aero-lab vehicle ${vehicleId} delete`, async () => {
    if (!UUID_RE.test(vehicleId)) return `refusing to delete a non-uuid vehicle id ${vehicleId}`;
    await ports.sql('aero-lab.floater-delete', [ports.ownerSub, vehicleId]);
    const residue = ((await ports.sql('aero-lab.floater-residue', [ports.ownerSub, vehicleId])).rows || [])[0] || {};
    if (Number(residue.vehicles) || Number(residue.evaluations)) return `residue for ${vehicleId}: vehicles=${residue.vehicles}, evaluations=${residue.evaluations}`;
    const gone = await ports.api('GET', `${BASE}/${vehicleId}`);
    if (gone.status !== 404) return `GET ${BASE}/${vehicleId} answered HTTP ${gone.status} after the delete, not 404`;
    ledger.removed('aero-lab-vehicle', vehicleId);
    return null;
  });
}

/**
 * @description Run the case once.
 * @param {object} ports - api, sql, ownerSub.
 * @returns {Promise<object>} The result with its cleanup receipt.
 */
async function run(ports) {
  const missing = common.missingPorts(ports, NEEDS);
  if (missing.length) return common.unavailable(CASE_ID, `This runner has no ${missing.join('/')} port.`);
  const kinds = await ports.api('GET', `${BASE}/kinds`);
  if (kinds.status === 404) return common.unavailable(CASE_ID, 'aero-lab with the ADR-160 vehicle record (1.3.0 or later) is not installed.');
  const ledger = new common.CleanupLedger();
  let verdict;
  let evidence = {};
  let seed = null;
  try {
    seed = await seedFloater(ports);
    if (seed.vehicleId && seed.seeded) ledger.created('aero-lab-vehicle', seed.vehicleId);
    else if (seed.vehicleId) ledger.kept('aero-lab-vehicle', seed.vehicleId, 'the owner already had a Floater; the case read it and wrote nothing');
    if (!seed.vehicleId) verdict = { state: 'fail', detail: `POST ${BASE}/floater/seed did not produce a Floater: ${seed.error}.` };
    else {
      const judged = judgeRecord(await ports.api('GET', `${BASE}/${seed.vehicleId}`));
      evidence = { vehicleId: seed.vehicleId, seeded: seed.seeded, budget: judged.budget ? { status: judged.budget.status, deltaG: judged.budget.deltaG } : null };
      verdict = { state: judged.ok ? 'pass' : 'fail', detail: `${seed.seeded ? 'Seeded' : 'Read the existing'} Floater ${seed.vehicleId}: ${judged.detail}.` };
    }
  } catch (error) {
    verdict = { state: 'fail', detail: `The case crashed: ${common.errorText(error)}` };
  }
  if (seed && seed.seeded && seed.vehicleId) await removeFloater(ports, seed.vehicleId, ledger);
  return common.finish(CASE_ID, verdict, ledger, evidence);
}

module.exports = { CASE_ID, KEY, TITLE, NEEDS, EXPECTED_DELTA_G, FABRICABLE_SENTENCE, judgeRecord, seedFloater, run };
