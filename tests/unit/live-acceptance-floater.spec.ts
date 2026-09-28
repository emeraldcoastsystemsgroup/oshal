/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the ADR-160 Floater live-acceptance case's own logic over a doubled HTTP transport and a recording statement port: a seeded Floater whose evaluation 1 is RED at +274.3 g with the fabricable sentence = pass, then exactly that vehicle is deleted by the named statement and proven gone by row count and 404; an owner's pre-existing Floater is only read; a green budget or a paraphrased sentence = fail (the seeded vehicle is still removed); residue after the delete = red cleanup; an unfingerprinted seed writes nothing to remove; a box without the record is unavailable. The statement text is covered by live-acceptance-runner.spec.ts; the real companion is `node scripts/operations/live-acceptance.js floater` on the box.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { fakeApi, type FakeHandler } from '../fixtures/live-acceptance-fake-api';

const requireCjs = createRequire(import.meta.url);
const floater = requireCjs('../../scripts/lib/live-acceptance-floater.js');

const OWNER = 'fixture|floater-owner';
const VEHICLE = '6d0f7a3e-2b1c-4d5e-8f90-a1b2c3d4e5f6';
const BUDGET = { status: 'red', certifiedG: 1080.2, asBuiltG: 1354.5, deltaG: 274.3,
  why: 'real parts sum to 1354.5 g against the 1080.2 g ledger the sizing closed on: +274.3 g of mass nothing was sized for.' };

function world(options: { seeded?: boolean; budget?: Record<string, unknown>; sentence?: string; residue?: number; over?: Record<string, FakeHandler> } = {}) {
  let exists = true;
  const record = () => ({ status: exists ? 200 : 404, json: exists ? {
    vehicle: { vehicleId: VEHICLE, name: 'Floater' },
    stage: { stage: 'sized', fabricable: options.sentence ?? floater.FABRICABLE_SENTENCE },
    evaluations: [{ sequence: 1, result: { budget: { ...BUDGET, ...(options.budget || {}) } } }], withheld: [] } : { error: 'vehicle_not_found' } });
  const api = fakeApi({
    'GET /api/aero-lab/vehicles/kinds': () => ({ status: 200, json: { kinds: [{ id: 'solar-dynastat' }] } }),
    'POST /api/aero-lab/vehicles/floater/seed': () => ({ status: options.seeded === false ? 200 : 201,
      json: { vehicle: { vehicleId: VEHICLE, name: 'Floater' }, seeded: options.seeded !== false } }),
    'GET /api/aero-lab/vehicles/:id': () => record(),
    ...(options.over || {}),
  });
  const statements: Array<{ name: string; params: unknown[] }> = [];
  const sql = async (name: string, params: unknown[]) => {
    statements.push({ name, params });
    if (name === 'aero-lab.floater-delete') { if (!options.residue) exists = false; return { rows: [] }; }
    return { rows: [{ vehicles: options.residue ?? 0, evaluations: options.residue ?? 0 }] };
  };
  return { api, sql, statements };
}

const run = (w: ReturnType<typeof world>) => floater.run({ api: w.api.api, sql: w.sql, ownerSub: OWNER });

describe('ADR-160 Floater live acceptance', () => {
  it('passes on RED +274.3 g and the fabricable sentence, then deletes exactly the seeded vehicle', async () => {
    const w = world();
    const result = await run(w);
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('budget RED at +274.3 g (1354.5 g against 1080.2 g)');
    expect(result.detail).toContain('carries the fabricable sentence verbatim');
    expect(w.statements).toEqual([
      { name: 'aero-lab.floater-delete', params: [OWNER, VEHICLE] },
      { name: 'aero-lab.floater-residue', params: [OWNER, VEHICLE] },
    ]);
    expect(result.cleanup.removed).toEqual([`aero-lab-vehicle ${VEHICLE}`]);
  });

  it('only reads an owner\'s existing Floater and writes nothing', async () => {
    const w = world({ seeded: false });
    const result = await run(w);
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('Read the existing Floater');
    expect(w.statements).toEqual([]);
    expect(result.cleanup.kept[0]).toContain('the owner already had a Floater');
  });

  it('fails a green budget or a paraphrased sentence and still removes the seeded vehicle', async () => {
    const green = await run(world({ budget: { status: 'green', deltaG: 0 } }));
    expect(green.state).toBe('fail');
    expect(green.detail).toContain('the budget is green, not red');
    expect(green.cleanup.removed).toEqual([`aero-lab-vehicle ${VEHICLE}`]);
    const worded = await run(world({ sentence: 'fabricable means ready to build' }));
    expect(worded.state).toBe('fail');
    expect(worded.detail).toContain('fabricable sentence is "fabricable means ready to build"');
  });

  it('turns residue after the delete into a red cleanup', async () => {
    const result = await run(world({ residue: 1 }));
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`CLEANUP INCOMPLETE: residue for ${VEHICLE}: vehicles=1, evaluations=1`);
  });

  it('writes nothing to remove when the seed refuses, and is unavailable without the record', async () => {
    const refused = world({ over: { 'POST /api/aero-lab/vehicles/floater/seed': () => ({ status: 503, json: { error: 'run_unfingerprinted' } }) } });
    const result = await run(refused);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('run_unfingerprinted');
    expect(refused.statements).toEqual([]);
    const absent = world({ over: { 'GET /api/aero-lab/vehicles/kinds': () => ({ status: 404 }) } });
    expect((await run(absent)).state).toBe('unavailable');
    expect(absent.api.calls.map((c) => c.method)).toEqual(['GET']);
  });
});
