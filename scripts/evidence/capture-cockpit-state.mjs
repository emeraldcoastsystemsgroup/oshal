#!/usr/bin/env node
/**
 * Capture the OSHAL cockpit through the real browser path without using the
 * Playwright test-runner webServer wrapper. Useful when headed Playwright tests
 * are wedging but we still need pixel evidence.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const headed = args.has('--headed');
const port = readArg('--port') || '4465';
const outDir = path.resolve(readArg('--out') || path.join('test-results', 'cockpit-foreground-capture'));
const baseURL = `http://localhost:${port}`;

fs.mkdirSync(outDir, { recursive: true });

const server = spawn(process.execPath, [
  path.join(root, 'node_modules', 'ts-node', 'dist', 'bin.js'),
  '--project',
  'tsconfig.json',
  '-r',
  'tsconfig-paths/register',
  'src/app/server.ts',
], {
  cwd: root,
  env: {
    ...process.env,
    PORT: port,
    MOCK_OIDC: process.env.MOCK_OIDC || 'true',
    DISABLE_ONBOARDING_GATE: process.env.DISABLE_ONBOARDING_GATE || 'true',
    DATABASE_URL: process.env.DATABASE_URL || 'postgresql://oshal:oshal@127.0.0.1:55433/oshal',
    REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:16379',
    POSTGRES_HOST: process.env.POSTGRES_HOST || '127.0.0.1',
    POSTGRES_PORT: process.env.POSTGRES_PORT || '55433',
    POSTGRES_DB: process.env.POSTGRES_DB || 'oshal',
    POSTGRES_USER: process.env.POSTGRES_USER || 'oshal',
    POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD || 'oshal',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const serverLog = [];
server.stdout.on('data', (chunk) => serverLog.push(String(chunk)));
server.stderr.on('data', (chunk) => serverLog.push(String(chunk)));

let browser;
let completed = false;
try {
  await waitForHealth();
  browser = await chromium.launch({ headless: !headed });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const profileResponse = await page.request.get(`${baseURL}/api/ui/profile?name=oshal-framework`);
  const profileText = await profileResponse.text();
  if (/Kid Lens|kidlens|youtube-kids/i.test(profileText)) {
    throw new Error('Kid Lens still appears in the OSHAL profile response');
  }

  await page.goto(`${baseURL}/cockpit/?profile=oshal-framework&capture=foreground`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => Boolean(window.__cockpit?.switchView), null, { timeout: 45_000 });
  await page.screenshot({ path: path.join(outDir, '01-cockpit-home.png'), fullPage: false });

  const ribbonText = await page.locator('body').innerText({ timeout: 10_000 });
  if (/Kid Lens|youtube-kids/i.test(ribbonText)) {
    throw new Error('Kid Lens still appears in the rendered cockpit');
  }

  await page.locator('[data-view="connectors"]').first().click();
  await page.locator('.connector-view #connectorSearch').waitFor({ state: 'visible', timeout: 45_000 });
  await page.waitForFunction(() => {
    const body = document.querySelector('.connector-view #connectorBody');
    const text = body?.textContent || '';
    return /Most Common Connectors|\d+\s+of\s+\d+\s+connectors/i.test(text);
  }, null, { timeout: 45_000 });
  await page.screenshot({ path: path.join(outDir, '02-connectors.png'), fullPage: false });

  await page.locator('.connector-view [data-connector-preset="high-risk"]').first().click({ force: true });
  await page.locator('.connector-view #connectorRisk').waitFor({ state: 'visible', timeout: 10_000 });
  const riskValue = await page.locator('.connector-view #connectorRisk').inputValue();
  if (riskValue !== 'high') {
    throw new Error(`Expected high-risk preset to set connectorRisk=high, got ${riskValue}`);
  }
  await page.screenshot({ path: path.join(outDir, '03-connectors-high-risk.png'), fullPage: false });

  const report = {
    generatedAt: new Date().toISOString(),
    baseURL,
    headed,
    kidLensProfileMatches: 0,
    screenshots: [
      path.join(outDir, '01-cockpit-home.png'),
      path.join(outDir, '02-connectors.png'),
      path.join(outDir, '03-connectors-high-risk.png'),
    ],
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  completed = true;
} finally {
  await browser?.close().catch(() => undefined);
  stopServer();
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return '';
  return process.argv[index + 1] || '';
}

async function waitForHealth() {
  const deadline = Date.now() + 60_000;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseURL}/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fs.writeFileSync(path.join(outDir, 'server.log'), serverLog.join(''));
  throw new Error(`Server did not become healthy on ${baseURL}: ${lastError}`);
}

function stopServer() {
  if (!server.killed) {
    server.kill('SIGTERM');
    setTimeout(() => {
      if (!server.killed) server.kill('SIGKILL');
    }, 1500).unref();
  }
  if (!completed || args.has('--keep-log')) {
    fs.writeFileSync(path.join(outDir, 'server.log'), serverLog.join(''));
  }
}
