/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Playwright coverage for the native RAG Center route and cockpit Engineering embed wiring
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added coverage for the RAG Center handoff link into the shared upload workspace
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added real ingest/query coverage for document drill-down and vector-ops inspection panels
 */

import { test, expect } from '@playwright/test';

const COCKPIT_URL = '/cockpit/';

/**
 * @description Navigates to cockpit and opens the Engineering ribbon view.
 * @param page - Playwright page instance.
 * @returns Promise that resolves when engineering panel is ready.
 */
async function gotoEngineering(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(COCKPIT_URL);
  await page.locator('.ribbon-btn[data-view="advanced"]').click();
  await page.waitForTimeout(350);
}

/**
 * @description Seeds a real knowledge document through the ingest API for operator-console coverage.
 * @param request - Playwright API request context.
 * @returns Promise resolving to the seeded title, collection, and unique query token.
 */
async function seedKnowledgeDocument(request: import('@playwright/test').APIRequestContext) {
  const suffix = Date.now();
  const collection = `playwright-rag-center-${suffix}`;
  const title = `Vector console document ${suffix}`;
  const token = `rag-console-token-${suffix}`;

  const response = await request.post('/api/rag/ingest', {
    data: {
      collection,
      content: `# ${title}\n\n${token}\n\nThis document exists to validate the RAG Center operator console.`,
      format: 'markdown',
      metadata: {
        embeddingModelId: 'text-embedding-3-small',
        embeddingProviderId: 'openai',
        fileNames: [`vector-console-${suffix}.md`],
        source: 'playwright-rag-center-spec',
      },
      title,
    },
  });

  expect(response.ok()).toBeTruthy();
  return { collection, title, token };
}

test.describe('RAG Center — Native Surface', () => {
  test('direct route renders native RAG Center surface', async ({ page }) => {
    await page.goto('/rag-center/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toHaveText('RAG Center');
    await expect(page.locator('#metricDocuments')).toBeVisible();
    await expect(page.locator('#metricCollections')).toBeVisible();
    await expect(page.locator('#metricChunks')).toBeVisible();
    await expect(page.locator('[data-testid="rag-center-results"]')).toBeVisible();
    await expect(page.locator('[data-testid="rag-center-collections"]')).toBeVisible();
    await expect(page.locator('[data-testid="rag-center-documents"]')).toBeVisible();
  });

  test('rag center query lab and filters render actionable controls', async ({ page }) => {
    await page.goto('/rag-center/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#refreshButton')).toBeVisible();
    await expect(page.locator('#openKnowledgeWorkspaceLink')).toHaveAttribute('href', /openWorkspace=rag/);
    await expect(page.locator('#queryInput')).toBeVisible();
    await expect(page.locator('#collectionSelect')).toBeVisible();
    await expect(page.locator('#documentSearchInput')).toBeVisible();
    await expect(page.locator('#scopeFilter')).toBeVisible();
    await expect(page.locator('#documentCollectionFilter')).toBeVisible();
    await expect(page.locator('[data-testid="rag-center-signals"]')).toBeVisible();
  });

  test('cockpit engineering embeds rag center as native route', async ({ page }) => {
    await gotoEngineering(page);
    await page.locator('.adv-sub-btn[data-page="rag-center"]').click();
    await page.waitForTimeout(350);

    await expect(page.locator('#advPanel')).toContainText('Native');
    await expect(page.locator('#advPanel')).toContainText('native RAG Center');
    await expect(page.locator('iframe[title="RAG Center"]')).toHaveAttribute('src', '/rag-center/');
  });

  test('rag center inspects seeded knowledge documents and live retrieval hits', async ({ page, request }) => {
    const seeded = await seedKnowledgeDocument(request);

    await page.goto('/rag-center/', { waitUntil: 'domcontentloaded' });
    await page.fill('#documentSearchInput', seeded.title);
    await expect(page.locator('#documentTableBody')).toContainText(seeded.title);

    await page.locator(`[data-document-key]:has-text("${seeded.title}")`).click();
    await expect(page.locator('[data-testid="rag-center-document-detail"]')).toContainText(seeded.collection);
    await expect(page.locator('[data-testid="rag-center-document-detail"]')).toContainText('openai / text-embedding-3-small');

    await page.selectOption('#collectionSelect', seeded.collection);
    await page.fill('#queryInput', seeded.token);
    await page.click('#runQueryButton');
    await expect(page.locator('[data-testid="rag-center-results"]')).toContainText(seeded.collection);

    await page.locator(`[data-result-key]:has-text("${seeded.collection}")`).first().click();
    await expect(page.locator('[data-testid="rag-center-result-detail"]')).toContainText('Confidence');
    await expect(page.locator('[data-testid="rag-center-result-detail"]')).toContainText(seeded.token);
  });
});
