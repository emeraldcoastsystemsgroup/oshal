/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression tests for the Content Studio branding work: feeds engine returns real focus-relevant news (Google News), social-signal noise filter, content-studio inline-script syntax (guards the broken-escape bug), and visual confirmation that the Profile & Access modal stacks + the email surface fills/responds. Deterministic — no LLM/bot/DB/auth dependence.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Removed the email-inbox responsive-CSS case: the email surface html carved to the email-summarizer store package (ADR-085 Wave 3) — the surface + its CSS ride the package now, exercised by the package + the live deploy battery. The Content Studio cases (the spec's actual subject) are unchanged.
 */

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// ════════════════════════ 1. FEEDS: real news search ════════════════════════
test('feeds engine returns real focus-relevant news with clickable links', () => {
  const out = execFileSync('node', ['scripts/oshal-research.js'], {
    cwd: ROOT, encoding: 'utf8', timeout: 90_000,
    env: { ...process.env, CONTENT_FOCUS: 'ERP, Cloud, AI', CONTENT_LIMIT: '12' },
  });
  const j = JSON.parse(out) as { count: number; candidates: Array<Record<string, unknown>> };
  // Must return candidates (the bug was 0 for ERP focus)
  expect(j.count).toBeGreaterThan(3);
  // At least one real NEWS search hit — proves we search news, not just grep the HN/AI firehose
  const searchHits = j.candidates.filter((c) => c.fromSearch === true);
  expect(searchHits.length).toBeGreaterThan(0);
  // Broad stream, not a single-source rehash — many distinct publishers
  const sources = new Set(j.candidates.map((c) => String(c.source)));
  expect(sources.size).toBeGreaterThanOrEqual(5);
  // Every candidate links to a REAL publisher — never a news.google.com/bing.com
  // redirect (those are blocked from loading in a frame: ERR_BLOCKED_BY_RESPONSE).
  for (const c of j.candidates) {
    expect(String(c.url)).toMatch(/^https?:\/\//);
    expect(String(c.url)).not.toMatch(/news\.google\.com|bing\.com\/news/);
  }
});

// ═══════════════════════ 2. SIGNALS: noise filter ═══════════════════════════
test('social-signal noise filter drops security/notification-count, keeps real opportunities', () => {
  // Mirrors SIGNAL_NOISE in content-routes; the assertion below guards against drift.
  const SIGNAL_NOISE = /\b(log ?in|logged in|sign-?in|signed in|new device|new login|security|verify|verification|password|confirm your|two-?factor|2fa|unusual activity|suspicious)\b|you have \d+ new notif|\d+ new notifications?$/i;
  const src = readFileSync(path.join(ROOT, 'src/app/routes/content-routes.ts'), 'utf8');
  expect(src).toContain('const SIGNAL_NOISE =');

  for (const drop of [
    'Did you just log in on a new device?',
    '@demouser you have 21 new notifications',
    'Security alert: new sign-in to your account',
    'Verify your account',
  ]) expect(SIGNAL_NOISE.test(drop), `should DROP: ${drop}`).toBeTruthy();

  for (const keep of [
    'demouser, see sunshine_gramma, neildegrassetyson and more in your feed',
    'pennengineering and 7 others recently added to their stories',
    'the operator, congratulate Jane Smith on her work anniversary',
    'John Doe wants to connect on LinkedIn',
  ]) expect(SIGNAL_NOISE.test(keep), `should KEEP: ${keep}`).toBeFalsy();
});

// ═════════════════ 3. PAGE SCRIPT: syntax (the broken-escape bug) ════════════
test('content-studio inline script parses — guards the broken-escape regression', () => {
  const html = readFileSync(path.join(ROOT, 'src/api/content-studio.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n;\n');
  expect(scripts.length).toBeGreaterThan(100);
  // new Function PARSES (does not execute) — throws on the exact SyntaxError we hit.
  expect(() => new Function(scripts)).not.toThrow();
});

// ═══════════ 4. CSS: Profile & Access modal stacks (the layout fix) ══════════
test('Profile & Access modal: status box stacks vertically, buttons do not overlap', async ({ page }) => {
  const css = readFileSync(path.join(ROOT, 'src/pages/cockpit/css/components.css'), 'utf8');
  // Exact DOM the cockpit renders for a signed-in user (cockpit-modals.js).
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head><body>
      <div class="modal-content"><div class="login-status logged-in">
        <p>Signed in as <strong>Demo User</strong> (demo@example.com).</p>
        <p>Global account access lives here. Cockpit settings and chat history stay on the ribbon.</p>
        <div class="modal-actions">
          <button class="btn-secondary" id="setBtn">Open Settings Page</button>
          <button class="btn-primary" id="outBtn">Sign Out</button>
        </div>
      </div></div></body></html>`,
    { waitUntil: 'load' },
  );
  await expect(page.locator('.login-status.logged-in')).toHaveCSS('flex-direction', 'column');
  const a = await page.locator('#setBtn').boundingBox();
  const b = await page.locator('#outBtn').boundingBox();
  expect(a && b).toBeTruthy();
  expect(Math.abs(a!.y - b!.y)).toBeLessThan(8);           // buttons share a row
  expect(b!.x).toBeGreaterThanOrEqual(a!.x + a!.width - 2); // no horizontal overlap
});

// ═══════════════ 5. CSS: email surface fills + responds ══════════════════════
// (Removed at the email-summarizer carve, ADR-085 Wave 3: src/api/email-inbox.html moved to
//  the store package's tools/ — the surface and its responsive CSS ride the package now,
//  exercised by the package + the live deploy battery. Home precedent: the guarded artifact
//  truly left the kernel, so the arm converts to this comment rather than repointing.)
