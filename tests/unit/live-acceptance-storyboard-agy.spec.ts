/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Judge and ledger of the storyboard-agy live-acceptance case (ADR-130 amendment 2026-10-02, the bot-level rule), over a fake api port. Pass needs the card's step to pass with a PNG of at least 64 x 64 from antigravity-cli, a generate_image DONE receipt, the bot's report that it ran antigravity-cli and a 'match' reconcile (its own setting, never switched); a degraded card (the render bot on another rail, or not the operator) is unavailable; a missing receipt, a non-PNG, another provider, a 'corrected' or unreported reconcile, or a card that failed is a fail; a render workspace the card did not remove turns the case red, and a workspace outside the card's tag is a cleanup error. The case posts exactly one Lab run for the card and nothing else.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The case's one POST /api/test-lab/run carries the render dispatch budget plus the margin as its own `timeoutMs` (480 s by default; STORYBOARD_CLI_IMAGE_TIMEOUT_MS when set; a non-positive or non-numeric value falls back), and names the image-turn framing suite among its regression tests.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-130 amendment 2026-10-03 (operator decision): a 'corrected' reconcile on the render bot's own harness (the card's botHarness; antigravity-cli when the selection named no bot) passes like a 'match'. A correction onto another harness (either way round), an 'absent' or unreported reconcile, and a turn run elsewhere still fail. The pass fixture carries the card's renderBot and botHarness as the card reports them.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Retry and throttle for image renders (operator decision 2026-10-03): the PASS line names the attempt that rendered the frame when the card reports it ("rendered on attempt 2 of 3"), and says nothing of attempts for a card that does not; the case lists the retry and queue suites among its regression tests.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { fakeApi } from '../fixtures/live-acceptance-fake-api';

const requireCjs = createRequire(import.meta.url);
const agy = requireCjs('../../scripts/lib/live-acceptance-storyboard-agy.js');
const TASK = 'sbimg-testlab-live-storyboard-0a1b2c3d';

const passOutput = (over: Record<string, unknown> = {}) => ({
  provider: 'antigravity-cli', renderBot: 'general-bot', botHarness: 'antigravity-cli',
  model: 'gemini-3.8-flash-low', sourceMimeType: 'image/jpeg', format: 'png', width: 1024, height: 1024, bytes: 2048,
  cliRender: { taskId: TASK, tool: 'generate_image', toolState: 'DONE', locator: 'step-output', sha256: 'f'.repeat(64), ranOn: 'antigravity-cli', providerConfigAction: 'match' },
  cleanup: { taskId: TASK, removed: true }, ...over,
});

function world(step: { state: string; detail?: string; output?: unknown } | null) {
  return fakeApi({
    'POST /api/test-lab/run': ({ body }) => ({ status: 200, json: { results: step ? [{ id: (body as { scenarioId: string }).scenarioId,
      steps: [{ detail: `${step.state} detail`, ...step }] }] : [] } }),
  });
}

describe('storyboard-agy live acceptance', () => {
  it('passes on a real PNG from antigravity-cli with the generate_image DONE receipt, a match reconcile and the workspace removed', async () => {
    const api = world({ state: 'pass', output: passOutput() });
    const result = await agy.run({ api: api.api });
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('1024 x 1024 PNG from image/jpeg, model gemini-3.8-flash-low, generate_image DONE (step-output), ran on the bot\'s own antigravity-cli (reconcile match)');
    expect(result.cleanup).toMatchObject({ removed: [`render-workspace ${TASK}`], outstanding: [], errors: [] });
    expect(result.cleanup.kept[0]).toContain(`bot-task-record ${TASK}`);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/test-lab/run']);
    expect(api.calls[0].body).toEqual({ scenarioId: 'storyboard-antigravity-render' });
    // The one call blocks for the whole render: it carries the render budget plus the margin, not the runner's 30 s default.
    expect(api.calls[0].options).toEqual({ timeoutMs: 480_000 });
    expect(result.detail, 'a card that reports no attempt gets no attempt in the PASS line').not.toContain('attempt');
  });

  it('names the attempt that rendered the frame, so a measured run shows what a fresh-turn retry rescued', async () => {
    const retried = passOutput({ cliRender: { ...passOutput().cliRender, taskId: `${TASK}-a2`, attempt: 2 } });
    const result = await agy.run({ api: world({ state: 'pass', output: retried }).api });
    expect(result.state, result.detail).toBe('pass');
    expect(result.detail).toContain('ran on the bot\'s own antigravity-cli (reconcile match), rendered on attempt 2 of 3');
    // The card's cleanup reports its tagged id; the attempt workspaces are removed by the card before it says removed.
    expect(result.cleanup).toMatchObject({ removed: [`render-workspace ${TASK}`], outstanding: [], errors: [] });
    expect(agy.REGRESSION_TESTS.map((t: { path: string }) => t.path)).toEqual(expect.arrayContaining([
      'tests/unit/storyboard-antigravity-render-retry.spec.ts', 'tests/unit/storyboard-image-turn-queue.spec.ts']));
  });

  it('passes a render bot found on a stale default and corrected onto its own harness, as the 2026-10-03 00:24 render was', async () => {
    const corrected = passOutput({ cliRender: { ...passOutput().cliRender, providerConfigAction: 'corrected' } });
    const result = await agy.run({ api: world({ state: 'pass', output: corrected }).api });
    expect(result.state, result.detail).toBe('pass');
    expect(result.detail).toContain('ran on the bot\'s own antigravity-cli (reconcile corrected)');
    // With no render bot in the selection (an explicit STORYBOARD_IMAGE_PROVIDER), the bot's own harness is the rail's.
    const explicit = await agy.run({ api: world({ state: 'pass', output: { ...corrected, renderBot: null, botHarness: null } }).api });
    expect(explicit.state, explicit.detail).toBe('pass');
  });

  it('budgets its one call from the render dispatch budget the api holds the bot to, plus a margin', () => {
    expect(agy.renderCallTimeoutMs({})).toBe(agy.DEFAULT_RENDER_BUDGET_MS + agy.RENDER_CALL_MARGIN_MS);
    expect(agy.renderCallTimeoutMs({})).toBe(480_000);
    expect(agy.renderCallTimeoutMs({ STORYBOARD_CLI_IMAGE_TIMEOUT_MS: '300000' })).toBe(360_000);
    expect(agy.renderCallTimeoutMs({ STORYBOARD_CLI_IMAGE_TIMEOUT_MS: '0' })).toBe(480_000);
    expect(agy.renderCallTimeoutMs({ STORYBOARD_CLI_IMAGE_TIMEOUT_MS: 'soon' })).toBe(480_000);
    expect(agy.REGRESSION_TESTS.map((t: { path: string }) => t.path)).toContain('tests/unit/image-turn-prompt-framing.spec.ts');
  });

  it.each([
    ['no receipt', passOutput({ cliRender: null }), /no receipt shows generate_image reaching DONE/],
    ['a receipt short of DONE', passOutput({ cliRender: { taskId: TASK, tool: 'generate_image', toolState: 'ACTIVE' } }), /no receipt/],
    ['not a PNG', passOutput({ format: null, width: 0, height: 0 }), /not a PNG of at least 64 x 64/],
    ['another rail', passOutput({ provider: 'codex-cli' }), /did not come from antigravity-cli/],
    ['a turn run on another provider', passOutput({ cliRender: { ...passOutput().cliRender, ranOn: 'openai-codex' } }), /does not report that the turn ran on antigravity-cli/],
    ['a correction onto another harness', passOutput({ cliRender: { ...passOutput().cliRender, ranOn: 'openai-codex', providerConfigAction: 'corrected' } }),
      /the bot's reconcile was corrected on openai-codex, not a match on or a correction onto its own antigravity-cli setting/],
    ['a correction onto a harness that is not the bot\'s own', passOutput({ botHarness: 'openai-codex', cliRender: { ...passOutput().cliRender, providerConfigAction: 'corrected' } }),
      /the bot's reconcile was corrected on antigravity-cli, not a match on or a correction onto its own openai-codex setting/],
    ['a reconcile the bot did not run', passOutput({ cliRender: { ...passOutput().cliRender, providerConfigAction: 'absent' } }), /the bot's reconcile was absent on antigravity-cli/],
    ['an unreported reconcile', passOutput({ cliRender: { ...passOutput().cliRender, providerConfigAction: null } }), /the bot's reconcile was not reported on antigravity-cli/],
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

  it('a degraded card (the render bot on another rail, or not the operator) is unavailable; an older build is unavailable', async () => {
    const other = await agy.run({ api: world({ state: 'degraded', detail: "The resolved image rail is 'codex-cli' (render-bot, general-bot on openai-codex), not antigravity-cli. Nothing was rendered." }).api });
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
