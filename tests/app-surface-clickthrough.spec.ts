/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added priority app click-through proof for
 *                     |               | category-native first actions without
 *                     |               | executing external purchase/ride handoffs.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Test Lab scenario test
 *                     |               | re-fixtured smoke-storage → smoke-workflow-studio
 *                     |               | (kernel-resident, D5) — storage carved to the app
 *                     |               | store (ADR-085 Wave 2).
 */

import { test, expect, type Page } from '@playwright/test';

test.describe('priority app click-through polish', () => {
  test.setTimeout(180_000);

  test('shared glass stylesheet is served as CSS before auth-gated shared aliases', async ({ request }) => {
    const response = await request.get('/shared/ui/css/surface-glass.css', { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toMatch(/text\/css/i);
    expect(await response.text()).toContain('--oshal-glass-bg');
  });

  test('optimizer opens with an actionable no-token demo comparison', async ({ page }) => {
    await page.goto('/api/token-chase/ui');

    await expect(page.getByText('No captured runs yet')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Demo comparison' })).toBeVisible();
    const summary = page.locator('.summary-grid').first();
    await expect(summary).toContainText('Baseline');
    await expect(summary).toContainText('Variant');
    await expect(summary).toContainText('Accuracy');
    await expect(summary).toContainText(/equivalent-cheaper|cheaper/i);
  });

  test('Bot Forge front door reaches the Forge builder chat', async ({ page }) => {
    await page.goto('/api/forge');

    await expect(page.locator('h1')).toContainText(/Bot Forge/i);
    await expect(page.locator('#count')).toContainText(/active/i, { timeout: 20_000 });
    await expect(page.locator('#forgeBuilderCta')).toContainText(/Build a new bot/i);

    await page.locator('#forgeBuilderCta').click();
    await page.waitForURL(/\/swarmbot\/chat\?.*agentId=a0000000-0000-0000-0000-000000000030/i, {
      timeout: 20_000,
    });
  });

  test('utilities connector hub searches and summarizes available accounts', async ({ page }) => {
    await page.goto('/utilities');

    await expect(page.locator('#connectorSummary .summary-tile')).toHaveCount(4, { timeout: 30_000 });
    await expect(page.locator('#list')).not.toContainText(/Could not load connectors/i);
    await page.locator('#connectorSearch').fill('github');
    await expect(page.locator('#list')).toContainText(/GitHub|github/i, { timeout: 10_000 });
    await page.locator('#connectorSearch').fill('zzzz-no-real-connector');
    await expect(page.locator('#list')).toContainText(/No connectors match/i, { timeout: 10_000 });
  });

  test('retired Kid Lens is not exposed in the OSHAL cockpit profile', async ({ request }) => {
    const response = await request.get('/api/ui/profile?name=oshal-framework');
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    const serializedProfile = JSON.stringify(body.profile || body);
    expect(serializedProfile).not.toMatch(/Kid Lens|kidlens|youtube-kids/i);
  });

  test('AI Test Lab runs a scenario and renders the result state', async ({ page }) => {
    // Fixtured on smoke-workflow-studio — a kernel-RESIDENT app (D5): the isolated test
    // server installs no packages, so carved-app smokes (storage, …) can't be asserted here.
    await page.goto('/api/test-lab/app');

    await expect(page.getByRole('heading', { name: 'AI Test Lab' })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#card-smoke-workflow-studio')).toBeVisible({ timeout: 20_000 });

    await page.locator('[data-run-id="smoke-workflow-studio"]').click();

    const badge = page.locator('#badge-smoke-workflow-studio');
    await expect(badge).toHaveText(/pass|degraded|gap|fail/i, { timeout: 45_000 });
    await expect(badge).not.toHaveText(/run/i);
    await expect(page.locator('#steps-smoke-workflow-studio .step-state').first()).toHaveText(/pass|degraded|gap|fail/i);
    await expect(page.locator('#runStatus')).toContainText(/Scenario (complete|failed)/i);
  });

  test('Eval Wall opens with a readable proof summary or empty state', async ({ page }) => {
    await page.goto('/api/eval-wall/app');

    await expect(page.getByRole('heading', { name: /Eval Wall/i })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#tiles .tile')).toHaveCount(5, { timeout: 20_000 });
    await expect(page.locator('#tableWrap')).toContainText(/No runs recorded|pass|degraded|gap|fail|Scenario/i, {
      timeout: 20_000,
    });
  });

  test('cockpit connector marketplace searches and applies operator presets', async ({ page }) => {
    await page.goto('/cockpit/?profile=oshal-framework&e2e=connector-clickthrough', { waitUntil: 'domcontentloaded' });

    await openCockpitConnectors(page);
    await expect(page.locator('.connector-view #connectorSearch')).toBeVisible({ timeout: 40_000 });
    await expect(page.locator('.connector-view .connector-card').first()).toBeVisible({ timeout: 40_000 });

    await page.locator('.connector-view #connectorSearch').fill('github');
    await expect(page.locator('.connector-view #connectorBody')).toContainText(/github/i, { timeout: 10_000 });

    await page.locator('.connector-view [data-connector-preset="high-risk"]').first().click();
    await expect(page.locator('.connector-view #connectorRisk')).toHaveValue('high', { timeout: 10_000 });

    await page.locator('.connector-view [data-connector-preset="clear"]').first().click();
    await expect(page.locator('.connector-view #connectorRisk')).toHaveValue('all', { timeout: 10_000 });
    await expect(page.locator('.connector-view .connector-card').first()).toBeVisible({ timeout: 10_000 });
  });

  // (rides clickthrough removed: the app carved to the store, ADR-085 Wave 2 #3 — the
  //  isolated test server has no installed packages, so /api/rides/app is package-only now.)

  // (eats clickthrough removed: the app carved to the store, ADR-085 Wave 2 #4 — the
  //  isolated test server has no installed packages, so /api/eats/app is package-only now.)

  // (shopping clickthrough removed: purchasing carved to the store, ADR-085 Wave 2 #5 — the
  //  isolated test server has no installed packages, so /api/purchasing/chat is package-only now.)

  test('workflow studio validates and compiles the active workflow', async ({ page }) => {
    await page.goto('/workflow-studio/');

    await expect(page.getByText('Workflow studio ready.')).toBeVisible({ timeout: 30_000 });
    await page.locator('#validateWorkflowButton').click();
    await expect(page.locator('#validationPanel')).toContainText(/Ready|Needs Attention|Clean Canvas|issue/i, {
      timeout: 30_000,
    });

    await page.locator('#compileWorkflowButton').click();
    await expect(page.locator('#compilePanel')).toContainText(/step binding|runtime surface|mode|swarm runtime/i, {
      timeout: 30_000,
    });
  });
});

async function openCockpitConnectors(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as any).__cockpit?.switchView), null, { timeout: 40_000 });
  await page
    .waitForFunction(() => /\d+\s+bots/i.test(document.body.textContent || ''), null, { timeout: 40_000 })
    .catch(() => {});

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.locator('[data-view="connectors"], button[title="Connectors"]').first().click({ timeout: 5_000 }).catch(() => {});
    if (await hasConnectorSearch(page, 3_000)) return;

    await stableEvaluate(page, () => (window as any).__cockpit?.switchView?.('connectors')).catch(() => {});
    if (await hasConnectorSearch(page, 5_000)) return;

    await page.waitForTimeout(750);
  }

  throw new Error('cockpit connectors did not open');
}

async function hasConnectorSearch(page: Page, timeout: number): Promise<boolean> {
  return page
    .locator('.connector-view #connectorSearch')
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
}

async function stableEvaluate<T>(page: Page, fn: () => T): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await page.evaluate(fn);
    } catch (error: any) {
      lastError = error;
      if (!/Execution context was destroyed|navigation|Cannot find context/i.test(String(error?.message || error))) {
        throw error;
      }
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(250);
    }
  }
  throw lastError;
}
