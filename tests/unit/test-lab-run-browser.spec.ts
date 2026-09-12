/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Drive the actual Lab Run, Cancel, stale history and inert output controls against durable HTTP.
 */
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { chromium,type Browser,type BrowserContext,type Page } from 'playwright';
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { join,relative } from 'node:path';
import { tmpdir } from 'node:os';
import { InstalledAppTestCatalog } from '@/features/swarm-apps';
import { createPackageExecutionFixture,ObservedPackageTestSandbox,PACKAGE_TEST_IMAGE } from '../fixtures/package-test-execution';
import { startTestLabRunFixture,TEST_CASE } from '../fixtures/test-lab-runs';

let fixture: Awaited<ReturnType<typeof startTestLabRunFixture>>;
let browser: Browser,context: BrowserContext,page: Page;
beforeAll(async () => { fixture = await startTestLabRunFixture(); browser = await chromium.launch({ headless: true }); },45000);
afterAll(async () => { await browser?.close(); await fixture?.close(); },30000);
beforeEach(async () => {
  fixture.finish(); await fixture.pool.query('TRUNCATE oshal_test_lab_runs');
  Object.assign(fixture.state,{ visible: true,canRun: true,hold: false,starts: 0,test: structuredClone(TEST_CASE) });
  context = await browser.newContext();
  await context.route('**/*',route => new URL(route.request().url()).origin === fixture.base ? route.continue() : route.abort());
  page = await context.newPage(); page.setDefaultTimeout(10000);
  await page.goto(fixture.base+'/api/test-lab/app');
  await expect.poll(() => page.locator('#runStatus').textContent()).toContain('Ready.');
});

describe('Real browser-to-sandbox package repair',() => {
  it('records a real assertion failure, then a fixed source pass, preserving stale history after reload',async () => {
    const root = mkdtempSync(join(tmpdir(),'oshal-lab-page-'));
    const source = createPackageExecutionFixture(root,{ name: 'fixture',broken: true });
    const sandbox = new ObservedPackageTestSandbox();
    const catalog = new InstalledAppTestCatalog({ sandbox,runnerImage: PACKAGE_TEST_IMAGE });
    catalog.register(source.record);
    const selected = catalog.list(new Map([['fixture','Fixture package']]),{ canRunSuites: true }).find(test => test.id === source.caseId)!;
    const actual = await startTestLabRunFixture({ catalog,test: selected });
    const isolated = await browser.newContext(); const screen = await isolated.newPage(); screen.setDefaultTimeout(30000);
    try {
      await isolated.route('**/*',route => new URL(route.request().url()).origin === actual.base ? route.continue() : route.abort());
      await screen.goto(actual.base+'/api/test-lab/app');
      await screen.locator('[data-run-id="' + source.caseId + '"]').click();
      await expect.poll(() => screen.locator('#runHistory').textContent(),{ timeout: 45000 }).toContain('failed');
      await screen.getByRole('button',{ name: 'View result',exact: true }).click();
      await expect.poll(() => screen.locator('#runEvidence').textContent()).toContain('376');
      writeFileSync(source.helperPath,readFileSync(source.helperPath,'utf8').replace('quantity * price + 1','quantity * price'));
      catalog.register(source.record);
      await screen.getByRole('button',{ name: 'Refresh',exact: true }).click();
      await expect.poll(() => screen.locator('#runHistory').textContent()).toContain('Earlier version / stale');
      await screen.locator('[data-run-id="' + source.caseId + '"]').click();
      await expect.poll(() => screen.locator('#runHistory').textContent(),{ timeout: 45000 }).toContain('passed');
      await screen.reload(); await expect.poll(() => screen.locator('[data-history-id]').count()).toBe(2);
      expect(await screen.locator('#runHistory').textContent()).toContain('Earlier version / stale');
      expect(sandbox.calls).toBe(2); expect(sandbox.last?.cleanupVerified).toBe(true);
      const rows = await actual.pool.query('SELECT state,result,test FROM oshal_test_lab_runs ORDER BY created_at');
      expect(rows.rows.map(row => row.state)).toEqual(['failed','passed']);
      expect(rows.rows[0].test.executionRevision).not.toBe(rows.rows[1].test.executionRevision);
      expect(rows.rows[1].result.output).toContain('# pass 2');
    } finally {
      await isolated.close(); await actual.close();
      if (relative(tmpdir(),root).startsWith('oshal-lab-page-')) rmSync(root,{ recursive: true,force: true });
    }
  },120000);
});
afterEach(async () => { await context?.close(); },20000);

describe('Actual package Run interface',() => {
  it('clicks Run, persists the result across reload, renders output as inert text and labels earlier versions',async () => {
    await page.locator('[data-run-id]').click();
    await expect.poll(() => page.locator('#runHistory').textContent(),{ timeout: 10000 }).toContain('passed');
    await page.getByRole('button',{ name: 'View result',exact: true }).click();
    await expect.poll(() => page.locator('#runEvidence').textContent()).toContain('invoice total: 42');
    expect(await page.locator('#runEvidence script').count()).toBe(0);
    expect(await page.locator('#runEvidence > .history-output').textContent()).toContain('<script>private fixture</script>');
    await page.reload(); await expect.poll(() => page.locator('#runHistory').textContent(),{ timeout: 10000 }).toContain('passed');
    fixture.state.test.revision = 'd'.repeat(64); fixture.state.test.executionRevision = 'e'.repeat(64);
    await page.getByRole('button',{ name: 'Refresh',exact: true }).click();
    await expect.poll(() => page.locator('#runHistory').textContent()).toContain('Earlier version / stale');
    expect(fixture.state.starts).toBe(1);
  });

  it('cancels an active run and retains a terminal cancellation without text output',async () => {
    fixture.state.hold = true; await page.locator('[data-run-id]').click();
    await page.getByRole('button',{ name: 'Cancel',exact: true }).click();
    await expect.poll(() => page.locator('#runHistory').textContent(),{ timeout: 10000 }).toContain('cancelled');
    await page.getByRole('button',{ name: 'View result',exact: true }).click();
    await expect.poll(() => page.locator('#runEvidence').textContent()).toContain('No completed output');
    expect(await page.getByRole('button',{ name: 'Cancel',exact: true }).count()).toBe(0);
  });

  it('clears private evidence after access changes and does not show another issuer the same-sub history',async () => {
    await page.locator('[data-run-id]').click();
    await expect.poll(() => page.locator('#runHistory').textContent(),{ timeout: 10000 }).toContain('passed');
    await page.getByRole('button',{ name: 'View result',exact: true }).click();
    await expect.poll(() => page.locator('#runEvidence').textContent()).toContain('invoice total: 42');
    fixture.state.visible = false; await page.getByRole('button',{ name: 'Refresh history',exact: true }).click();
    await expect.poll(() => page.locator('#runHistory').textContent()).toContain('No package runs');
    expect(await page.locator('#runEvidence').textContent()).toBe('');
    fixture.state.visible = true; await context.addCookies([{ name: 'actor',value: 'other',url: fixture.base }]);
    await page.reload(); await expect.poll(() => page.locator('#runHistory').textContent()).toContain('No package runs');
  });
});
