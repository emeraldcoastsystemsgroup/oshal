/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added manifest-driven whole-app surface
 *                     |               | validation for blank pages, hard errors,
 *                     |               | console/page failures, and raw bot JSON leaks.
 */

import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { evaluateSurfaceQuality } from '../scripts/quality/surface-quality-gate';

type SurfaceTarget = {
  app: string;
  label: string;
  url: string;
  source: string;
};

type SurfaceResult = SurfaceTarget & {
  status: number | null;
  visibleTextLength: number;
  visibleElementCount: number;
  failedResponses: string[];
  consoleErrors: string[];
  pageErrors: string[];
  issues: string[];
};

const FRAMEWORK_SURFACES: SurfaceTarget[] = [
  { app: 'framework', label: 'Bot Forge', url: '/api/forge', source: 'built-in' },
  { app: 'framework', label: 'Optimizer', url: '/api/token-chase/ui', source: 'built-in' },
  { app: 'framework', label: 'AI Test Lab', url: '/api/test-lab/app', source: 'built-in' },
  { app: 'framework', label: 'Eval Wall', url: '/api/eval-wall/app', source: 'built-in' },
  { app: 'framework', label: 'Workflow Studio', url: '/workflow-studio/', source: 'built-in' },
];

const SURFACES = discoverSurfaceTargets();

test('all static app surfaces render without hard errors or raw bot JSON leaks', async ({ page }, testInfo) => {
  test.setTimeout(Math.max(180_000, SURFACES.length * 12_000));
  const glassCss = await page.request.get('/shared/ui/css/surface-glass.css', { maxRedirects: 0 });
  expect(glassCss.status(), 'surface-glass.css must not redirect to auth or HTML').toBe(200);
  expect(glassCss.headers()['content-type'], 'surface-glass.css must load as text/css').toMatch(/text\/css/i);
  const context = page.context();
  await page.close().catch(() => {});

  const results: SurfaceResult[] = [];
  for (const [index, surface] of SURFACES.entries()) {
    const surfacePage = await context.newPage();
    await surfacePage.setViewportSize({ width: 1440, height: 900 });
    console.log(`[surface] ${index + 1}/${SURFACES.length} ${surface.app} / ${surface.label} ${surface.url}`);
    const result = await validateSurface(surfacePage, surface, testInfo.outputPath(safeName(surface) + '.png'));
    results.push(result);
    console.log(`[surface] ${surface.app} / ${surface.label}: ${result.issues.length ? result.issues.join('; ') : 'ok'}`);
    await testInfo.attach(`surface-${safeName(surface)}`, {
      path: testInfo.outputPath(safeName(surface) + '.png'),
      contentType: 'image/png',
    }).catch(() => {});
    await surfacePage.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5_000 }).catch(() => {});
    await surfacePage.close().catch(() => {});
  }

  await testInfo.attach('app-surface-validation-report.json', {
    body: JSON.stringify({
      generatedAt: new Date().toISOString(),
      surfaceCount: results.length,
      failures: results.filter((result) => result.issues.length > 0),
      results,
    }, null, 2),
    contentType: 'application/json',
  });

  const failures = results.filter((result) => result.issues.length > 0);
  expect(failures, formatFailures(failures)).toEqual([]);
});

function discoverSurfaceTargets(): SurfaceTarget[] {
  const root = process.cwd();
  const swarmDir = path.join(root, 'swarm-apps');
  const manifestTargets: SurfaceTarget[] = [];
  for (const file of walkYamlFiles(swarmDir)) {
    const parsed = yaml.load(fs.readFileSync(file, 'utf8')) as any;
    if (!parsed || typeof parsed !== 'object') continue;
    if (String(parsed.status || 'active').toLowerCase() !== 'active') continue;
    const statics = Array.isArray(parsed.ui?.static) ? parsed.ui.static : [];
    for (const item of statics) {
      const url = normalizeUrl(item?.iframeUrl);
      if (!url) continue;
      manifestTargets.push({
        app: String(parsed.name || path.basename(file, path.extname(file))),
        label: String(item.label || item.toolName || url),
        url,
        source: path.relative(root, file).replace(/\\/g, '/'),
      });
    }
  }
  return dedupeSurfaces([...FRAMEWORK_SURFACES, ...manifestTargets]);
}

function walkYamlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkYamlFiles(fullPath));
    } else if (/\.ya?ml$/i.test(entry.name)) {
      found.push(fullPath);
    }
  }
  return found;
}

function normalizeUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed)) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function dedupeSurfaces(surfaces: SurfaceTarget[]): SurfaceTarget[] {
  const seen = new Set<string>();
  const out: SurfaceTarget[] = [];
  for (const surface of surfaces) {
    const key = `${surface.app}|${surface.label}|${surface.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(surface);
  }
  return out.sort((a, b) => `${a.app}:${a.label}`.localeCompare(`${b.app}:${b.label}`));
}

async function validateSurface(page: Page, surface: SurfaceTarget, screenshotPath: string): Promise<SurfaceResult> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedResponses: string[] = [];
  const onConsole = (msg: any) => {
    if (msg.type?.() === 'error') consoleErrors.push(clean(msg.text?.() || '').slice(0, 500));
  };
  const onPageError = (err: Error) => pageErrors.push(clean(err.message).slice(0, 500));
  const onResponse = (response: any) => {
    const status = response.status?.();
    const url = response.url?.() || '';
    if (status >= 400 && !/favicon/i.test(url)) {
      failedResponses.push(`${status} ${url}`.slice(0, 700));
    }
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);

  let status: number | null = null;
  let visibleText = '';
  let visibleElementCount = 0;
  let html = '';
  const issues: string[] = [];
  try {
    const response = await page.goto(surface.url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    status = response?.status() ?? null;
    await waitForSettle(page);
    visibleText = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    visibleElementCount = await page.locator('body *:visible').count().catch(() => 0);
    html = await page.content().catch(() => '');
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
  } catch (err: any) {
    issues.push(`navigation failed: ${clean(err?.message || String(err)).slice(0, 500)}`);
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('response', onResponse);
  }

  const normalizedText = clean(visibleText);
  if (status !== null && status >= 400) issues.push(`HTTP ${status}`);
  if (normalizedText.length < 20 && visibleElementCount < 5) issues.push('blank or near-blank surface');
  if (hasVisibleHardError(normalizedText)) issues.push('visible hard-error copy');
  if (leaksBotEnvelope(normalizedText)) issues.push('raw bot JSON envelope visible');
  issues.push(...categoryNativeIssues(surface, normalizedText));
  if (failedResponses.length > 0) issues.push(`failed responses: ${failedResponses.length}`);
  if (pageErrors.length > 0) issues.push(`page errors: ${pageErrors.length}`);
  const materialConsoleErrors = consoleErrors.filter((msg) => !/favicon|ResizeObserver loop/i.test(msg));
  if (materialConsoleErrors.length > 0) issues.push(`console errors: ${materialConsoleErrors.length}`);

  // Product-quality gate (scripts/quality/surface-quality-gate): add the checks this spec does
  // NOT already cover — leaked stack traces and general raw-JSON envelopes (broader than the
  // specific bot-envelope shapes). Overlapping rules (blank/HTTP/console) are left to the
  // existing checks above so nothing is double-counted.
  const quality = evaluateSurfaceQuality({ url: surface.url, html, consoleErrors: materialConsoleErrors, status: status ?? undefined });
  for (const finding of quality.findings) {
    if (finding.severity === 'fail' && (finding.rule === 'error-stack' || finding.rule === 'raw-json-envelope')) {
      issues.push(`quality: ${finding.detail}`);
    }
  }

  return {
    ...surface,
    status,
    visibleTextLength: normalizedText.length,
    visibleElementCount,
    failedResponses,
    consoleErrors: materialConsoleErrors,
    pageErrors,
    issues,
  };
}

async function waitForSettle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(800);
  await page
    .locator('.loading-skeleton:visible, .spinner:visible, .spin:visible, [aria-busy="true"]:visible')
    .first()
    .waitFor({ state: 'hidden', timeout: 2_000 })
    .catch(() => {});
  await page.waitForTimeout(200);
}

function leaksBotEnvelope(text: string): boolean {
  return [
    /\{\s*"say"\s*:/i,
    /\{\s*"pickup"\s*:\s*"/i,
    /\{\s*"dropoff"\s*:\s*"/i,
    /\{\s*"showOptions"\s*:/i,
    /\{\s*"show"\s*:\s*\[/i,
    /\{\s*"add"\s*:\s*\[/i,
  ].some((pattern) => pattern.test(text));
}

function hasVisibleHardError(text: string): boolean {
  return [
    /page not found/i,
    /cannot get \//i,
    /internal server error/i,
    /not authenticated/i,
    /surface-load error/i,
    /failed to load/i,
  ].some((pattern) => pattern.test(text));
}

function categoryNativeIssues(surface: SurfaceTarget, text: string): string[] {
  const url = surface.url.split('?')[0];
  const requirements: Record<string, Array<[string, RegExp]>> = {
  };
  const checks = requirements[url] || [];
  return checks
    .filter(([, pattern]) => !pattern.test(text))
    .map(([label]) => `missing category-native affordance: ${label}`);
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function safeName(surface: SurfaceTarget): string {
  return `${surface.app}-${surface.label}-${surface.url}`
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function formatFailures(failures: SurfaceResult[]): string {
  if (!failures.length) return 'all app surfaces rendered cleanly';
  return failures
    .map((failure) => `${failure.app} / ${failure.label} (${failure.url}): ${failure.issues.join('; ')}`)
    .join('\n');
}
