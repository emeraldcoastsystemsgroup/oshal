/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | E2E: the expanded AI Test Lab
 *            | serves each rendered visual kind, runs a visual scenario, and shows the image on the
 *            | surface — proving the "ask for weather, see the image" rich-delivery contract.
 */

import { expect, test } from '@playwright/test';

const BASE = `http://localhost:${process.env.PLAYWRIGHT_PORT ?? '4458'}`;
const KINDS = ['weather', 'priority-email', 'table', 'chart', 'summary', 'timeline', 'diagram', 'gallery', 'map', 'gauge', 'checklist', 'agenda', 'comparison', 'profile', 'image'];

test('every visual kind is served as a real SVG image', async ({ request }) => {
  for (const kind of KINDS) {
    const res = await request.get(`${BASE}/api/test-lab/visual/${kind}.svg`);
    expect(res.status(), kind).toBe(200);
    expect(res.headers()['content-type']).toContain('image/svg+xml');
    const body = await res.text();
    expect(body, kind).toContain('<svg');
    expect(body.length, kind).toBeGreaterThan(400);
  }
  // An unknown kind fails closed, not with a fabricated image.
  const bad = await request.get(`${BASE}/api/test-lab/visual/not-a-kind.svg`);
  expect(bad.status()).toBe(404);
});

test('the catalog exposes the visual + tool groups', async ({ request }) => {
  const res = await request.get(`${BASE}/api/test-lab/catalog`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  const groups = new Set((body.scenarios || []).map((s: any) => s.group));
  expect(groups.has('visual')).toBe(true);
  expect(groups.has('tool')).toBe(true);
  expect(groups.has('jarvis')).toBe(true);
  expect(groups.has('coupled')).toBe(true);
  const visualCount = (body.scenarios || []).filter((s: any) => s.group === 'visual').length;
  expect(visualCount).toBe(KINDS.length);
});

test('running a visual scenario passes and returns a displayable image url', async ({ request }) => {
  const res = await request.post(`${BASE}/api/test-lab/run`, { data: { scenarioId: 'visual-weather' } });
  expect(res.status()).toBe(200);
  const body = await res.json();
  const result = (body.results || [])[0];
  expect(result?.state).toBe('pass');
  const step = (result.steps || [])[0];
  expect(step.state).toBe('pass');
  expect(step.visual?.url).toBe('/api/test-lab/visual/weather.svg');
});

test('the surface renders the weather image on demand', async ({ page }) => {
  await page.goto(`${BASE}/api/test-lab/app`, { waitUntil: 'domcontentloaded' });
  // The Rich-visuals group renders first; its weather card carries a Run button.
  const runButton = page.locator('#card-visual-weather [data-run-id="visual-weather"]');
  await expect(runButton).toBeVisible({ timeout: 15_000 });
  await runButton.click();
  const img = page.locator('#card-visual-weather .step-visual img');
  await expect(img).toBeVisible({ timeout: 15_000 });
  await expect(img).toHaveAttribute('src', '/api/test-lab/visual/weather.svg');
  await expect(page.locator('#badge-visual-weather')).toHaveText('pass');
});
