/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Judge and ledger of the storyboard-agy live-acceptance case (ADR-130 amendment 2026-10-02), over a fake api port. Pass needs the card's step to pass with a PNG of at least 64 x 64 from antigravity-cli and a generate_image DONE receipt; a degraded card (another default, or not the operator) is unavailable; a missing receipt, a non-PNG or a card that failed is a fail; a render workspace the card did not remove turns the case red, and a workspace outside the card's tag is a cleanup error. The case posts exactly one Lab run for the card and nothing else.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { fakeApi } from '../fixtures/live-acceptance-fake-api';

const requireCjs = createRequire(import.meta.url);
const agy = requireCjs('../../scripts/lib/live-acceptance-storyboard-agy.js');
const TASK = 'sbimg-testlab-live-storyboard-0a1b2c3d';

const passOutput = (over: Record<string, unknown> = {}) => ({
  provider: 'antigravity-cli', model: 'gemini-3.8-flash-low', sourceMimeType: 'image/jpeg', format: 'png', width: 1024, height: 1024, bytes: 2048,
  cliRender: { taskId: TASK, tool: 'generate_image', toolState: 'DONE', locator: 'step-output', sha256: 'f'.repeat(64) },
  cleanup: { taskId: TASK, removed: true }, ...over,
});

function world(step: { state: string; detail?: string; output?: unknown } | null) {
  return fakeApi({
    'POST /api/test-lab/run': ({ body }) => ({ status: 200, json: { results: step ? [{ id: (body as { scenarioId: string }).scenarioId,
      steps: [{ detail: `${step.state} detail`, ...step }] }] : [] } }),
  });
}

describe('storyboard-agy live acceptance', () => {
  it('passes on a real PNG from antigravity-cli with the generate_image DONE receipt and the workspace removed', async () => {
    const api = world({ state: 'pass', output: passOutput() });
    const result = await agy.run({ api: api.api });
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('1024 x 1024 PNG from image/jpeg, model gemini-3.8-flash-low, generate_image DONE (step-output)');
    expect(result.cleanup).toMatchObject({ removed: [`render-workspace ${TASK}`], outstanding: [], errors: [] });
    expect(result.cleanup.kept[0]).toContain(`bot-task-record ${TASK}`);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/test-lab/run']);
    expect(api.calls[0].body).toEqual({ scenarioId: 'storyboard-swarm-default-render' });
  });

  it.each([
    ['no receipt', passOutput({ cliRender: null }), /no receipt shows generate_image reaching DONE/],
    ['a receipt short of DONE', passOutput({ cliRender: { taskId: TASK, tool: 'generate_image', toolState: 'ACTIVE' } }), /no receipt/],
    ['not a PNG', passOutput({ format: null, width: 0, height: 0 }), /not a PNG of at least 64 x 64/],
    ['another rail', passOutput({ provider: 'codex-cli' }), /did not come from antigravity-cli/],
  ])('fails a passing card with %s', async (_label, output, reason) => {
    const result = await agy.run({ api: world({ state: 'pass', output }).api });
    expect(result.state).toBe('fail');
    expect(result.detail).toMatch(reason);
  });

  it('fails a card that failed, and a workspace the card did not remove turns the case red', async () => {
    const failed = await agy.run({ api: world({ state: 'fail', detail: 'The render failed: image turn refused', output: { taskId: TASK, cleanup: { taskId: TASK, removed: true } } }).api });
    expect(failed.state).toBe('fail');
    expect(failed.detail).toContain('image turn refused');
    expect(failed.cleanup.outstanding).toEqual([]);
    const leaked = await agy.run({ api: world({ state: 'pass', output: passOutput({ cleanup: { taskId: TASK, removed: false } }) }).api });
    expect(leaked.state).toBe('fail');
    expect(leaked.detail).toContain(`CLEANUP INCOMPLETE: render-workspace ${TASK} was not removed`);
  });

  it('refuses to account for a workspace outside the card\'s tag', async () => {
    const foreign = await agy.run({ api: world({ state: 'pass', output: passOutput({ cleanup: { taskId: 'sbimg-someone-else', removed: true }, cliRender: { taskId: 'sbimg-someone-else', tool: 'generate_image', toolState: 'DONE', locator: 'step-output' } }) }).api });
    expect(foreign.state).toBe('fail');
    expect(foreign.cleanup.errors[0]).toContain('not its own tag: sbimg-someone-else');
  });

  it('a degraded card (another default rail, or not the operator) is unavailable; an older build is unavailable', async () => {
    const other = await agy.run({ api: world({ state: 'degraded', detail: "The resolved image rail is 'codex-cli' (swarm-default, swarm default openai-codex), not antigravity-cli. Nothing was rendered." }).api });
    expect(other.state).toBe('unavailable');
    expect(other.detail).toContain("'codex-cli'");
    const older = await agy.run({ api: world(null).api });
    expect(older.state).toBe('unavailable');
    expect(older.detail).toContain('the build predates it');
  });

  it('with no api port the case is not runnable and says so', async () => {
    const result = await agy.run({});
    expect(result.state).toBe('unavailable');
    expect(result.detail).toContain('no api port');
  });
});
