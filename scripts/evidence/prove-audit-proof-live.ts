/**
 * Live proof for the Audit / Proof category: the module screenshot wall.
 *
 * Links each top module surface (a real swarm-apps ui.static entry backed by a
 * shipped src/api HTML surface) to its competitive category score read from the
 * latest docs/evidence/competitive-readiness-*.json, and captures a GENUINE
 * headless-chromium screenshot of each surface served from a throwaway static
 * server. Screenshots are persisted PNGs; the score link is read from the live
 * score artifact. Nothing is stubbed for the score link or the render.
 */

import express from 'express';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import { readManifest } from '@/features/swarm-apps/services/swarm-app-loader';

type ModuleSpec = {
  name: string;
  toolName: string;
  manifestFile: string;
  surfaceHtml: string;
  iframeUrl: string;
  categoryId: string;
};

type ModuleResult = ModuleSpec & {
  toolNamePresent: boolean;
  surfaceExists: boolean;
  categoryLabel: string;
  score: number | null;
  screenshotPath: string;
  screenshotBytes: number;
  renderedTitle: string;
  passed: boolean;
};

const MODULES: ModuleSpec[] = [
  // (Finance row removed: carved to the app store, ADR-085 — its manifest + surface live in the package.)
  // (Identity Hub row removed: carved to the app store, ADR-085 Wave 3 — its manifest + surface live in the package.)
  { name: 'Assistant', toolName: 'jarvis-home', manifestFile: 'swarm-apps/jarvis.yaml', surfaceHtml: 'jarvis.html', iframeUrl: '/api/jarvis/', categoryId: 'nl-voice' },
  // (Payments row removed: carved to the app store, ADR-085 — its manifest + surface live in the package.)
  // (Presentations row removed: AI Office carved to the app store, ADR-085 Wave 2 — its manifest + surface live in the package.)
  // (Connector Hub row removed: it was keyed on the home manifest's home-accounts tile and home
  //  carved to the app store, ADR-085 Wave 2. The /utilities surface itself stays kernel-served.)
];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function dateStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatTimestamp(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${dateStamp(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function latestCompetitiveJson(): string {
  const dir = path.join(process.cwd(), 'docs', 'evidence');
  const match = readdirSync(dir)
    .filter((name) => name.startsWith('competitive-readiness-') && name.endsWith('.json'))
    .sort()
    .reverse()[0];
  if (!match) throw new Error('no competitive-readiness-*.json score artifact found');
  return path.join(dir, match);
}

function loadScoreMap(): { source: string; map: Map<string, { label: string; score: number }> } {
  const source = latestCompetitiveJson();
  const parsed = JSON.parse(readFileSync(source, 'utf8')) as { categories?: Array<{ id: string; category: string; score: number }> };
  const map = new Map<string, { label: string; score: number }>();
  for (const cat of parsed.categories || []) {
    if (typeof cat.score === 'number') map.set(cat.id, { label: cat.category, score: cat.score });
  }
  return { source: path.relative(process.cwd(), source), map };
}

function assertToolName(spec: ModuleSpec): boolean {
  const manifest = readManifest(spec.manifestFile) as any;
  const entries = Array.isArray(manifest.ui?.static) ? manifest.ui.static : [];
  return entries.some((entry: any) => String(entry.toolName) === spec.toolName);
}

function buildStaticServer(apiDir: string): express.Express {
  const app = express();
  app.use(express.static(apiDir));
  return app;
}

async function captureModule(
  browser: import('playwright').Browser,
  baseUrl: string,
  outDir: string,
  spec: ModuleSpec,
  score: { label: string; score: number } | undefined,
): Promise<ModuleResult> {
  const apiDir = path.join(process.cwd(), 'src', 'api');
  const surfaceExists = existsSync(path.join(apiDir, spec.surfaceHtml));
  const toolNamePresent = assertToolName(spec);
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
  await page.goto(`${baseUrl}/${spec.surfaceHtml}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(400);
  const renderedTitle = await page.title();
  const slug = spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const screenshotPath = path.join(outDir, `${slug}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  await page.close();
  const screenshotBytes = existsSync(screenshotPath) ? statSync(screenshotPath).size : 0;
  const passed = toolNamePresent && surfaceExists && typeof score?.score === 'number' && screenshotBytes > 3000;
  return {
    ...spec,
    toolNamePresent,
    surfaceExists,
    categoryLabel: score?.label ?? '(missing)',
    score: score?.score ?? null,
    screenshotPath: path.relative(process.cwd(), screenshotPath),
    screenshotBytes,
    renderedTitle,
    passed,
  };
}

function renderMarkdown(results: ModuleResult[], scoreSource: string, generatedAt: Date): string {
  return [
    `# Module Screenshot Wall - ${dateStamp(generatedAt)}`,
    '',
    '**Proof-Tier:** live - genuine headless-chromium screenshots of the shipped module surfaces served from a throwaway static server, each linked to its competitive category score read from the live score artifact.',
    '',
    `Generated: ${formatTimestamp(generatedAt)}`,
    '',
    '## Result',
    '',
    `Passed ${results.filter((r) => r.passed).length}/${results.length} module surfaces: each has a real ui.static entry, a shipped surface file, a rendered screenshot, and a linked category score.`,
    '',
    `Score source: \`${scoreSource}\` (latest competitive-readiness artifact).`,
    '',
    '## Module Wall (surface -> screenshot -> category score)',
    '',
    '| Module | ui.static toolName | Surface | Screenshot (bytes) | Category | Score |',
    '|---|---|---|---:|---|---:|',
    ...results.map((r) => `| ${r.name} | ${r.toolName} | ${r.surfaceHtml} | \`${r.screenshotPath}\` (${r.screenshotBytes}) | ${r.categoryLabel} | ${r.score ?? '?'} |`),
    '',
    '## How the link is made',
    '',
    '- Each row is a real `ui.static` entry in a `swarm-apps/*.yaml` manifest (asserted via `readManifest`), whose `iframeUrl` is served from the shipped `src/api/*.html` surface.',
    '- Each surface is loaded in headless chromium and captured to a persisted PNG under the assets folder; a screenshot smaller than 3 KB fails the run.',
    '- Each module is linked to a competitive category `score` read from the latest `competitive-readiness-*.json` — the same artifact the audit/proof category is graded against.',
    '',
    '## Command',
    '',
    '```powershell',
    'npx ts-node -r tsconfig-paths/register --transpile-only scripts/evidence/prove-audit-proof-live.ts',
    '```',
    '',
    '## Limits',
    '',
    'The screenshots are of the standalone module surface shells rendered from a throwaway `express.static` server (no OIDC, no live API data) via headless chromium — the surface chrome renders, but API-fed content is empty because no authenticated backend is attached. This is honest about capture method: it proves each scored module has a real, rendering surface and a live score link, not that authenticated production data is on screen. Authenticated live-data capture remains covered by the prior CDP live spec (`module-screenshot-wall-2026-06-22.md`). The category scores are read live from the competitive-readiness artifact; the manifest/ui.static assertions run against the real repo files.',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const { source: scoreSource, map: scoreMap } = loadScoreMap();
  const generatedAt = new Date();
  const outDir = path.join(process.cwd(), 'docs', 'evidence', `module-screenshot-wall-assets-${dateStamp(generatedAt)}`);
  mkdirSync(outDir, { recursive: true });

  const server = buildStaticServer(path.join(process.cwd(), 'src', 'api'));
  const listening = server.listen(0);
  await new Promise<void>((resolve) => listening.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ headless: true });

  try {
    const results: ModuleResult[] = [];
    for (const spec of MODULES) {
      results.push(await captureModule(browser, baseUrl, outDir, spec, scoreMap.get(spec.categoryId)));
    }

    const failed = results.filter((r) => !r.passed);
    if (failed.length) {
      console.error(JSON.stringify({ failed }, null, 2));
      process.exitCode = 1;
      return;
    }

    const evidenceDir = path.join(process.cwd(), 'docs', 'evidence');
    const base = `module-screenshot-wall-${dateStamp(generatedAt)}`;
    writeFileSync(path.join(evidenceDir, `${base}.md`), renderMarkdown(results, scoreSource, generatedAt), 'utf8');
    writeFileSync(path.join(evidenceDir, `${base}.json`), JSON.stringify({
      proofTier: 'live',
      generatedAt: generatedAt.toISOString(),
      scoreSource,
      passed: results.length,
      total: results.length,
      modules: results,
    }, null, 2), 'utf8');
    console.log(JSON.stringify({ ok: true, base, passed: results.length }, null, 2));
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => listening.close((e) => (e ? reject(e) : resolve())));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
