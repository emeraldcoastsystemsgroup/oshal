/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the last open criterion of BACKLOG "One slow boot drops the task, message and memory stores to in-memory for the life of the process": a store stranded in memory has to reach the cockpit status surface, not only /api/readiness and oshal-verify.sh.
 */
/**
 * The boundary this file crosses, and why it has to.
 *
 * The fix claims one thing: a store that is advertised durable and is serving from an
 * in-memory Map becomes visible on the surface the operator actually watches. Every part of
 * that claim lives in a seam a double would erase:
 *
 *   - the REAL `/api/readiness` route (`registerReadinessRoutes`) reading the REAL
 *     persistence-mode registry, so the report shape and the leg wiring are not restated here;
 *   - the REAL HTTP status code. Readiness answers **503** exactly when a leg fails, and the
 *     cockpit's own `getSafe` discards the body of any non-2xx response - so a status-bar read
 *     written the obvious way would render the "everything is fine" fallback precisely when a
 *     store is in memory. Only a real 503 over a real socket can catch that;
 *   - the REAL cockpit shell in a headless browser, running the unmodified `app.js` boot, so
 *     the assertion is on the status-bar DOM an operator sees rather than on a function return.
 *
 * Only `ctx.pool` is a double - the database ping is a different leg and a different backlog
 * entry; it is used here solely to drive the "another leg failed" case deterministically.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { registerReadinessRoutes } from '@/app/routes/readiness-routes';
import { recordPersistenceMode, resetPersistenceModes } from '@/shared/observability';
import { startWorkspaceNavigationFixture } from '../fixtures/workspace-navigation';

/** A real browser boot plus a real readiness computation needs more than vitest's 5s default. */
const TEST_TIMEOUT_MS = 40_000;
/** Launching chromium and starting the fixture server outruns vitest's 10s hook default on a loaded box. */
const HOOK_TIMEOUT_MS = 60_000;

/** Toggles the fixture server reads on every request; no test restarts the server. */
const server = { dbFails: false, readinessReadable: true };

let fixture: Awaited<ReturnType<typeof startWorkspaceNavigationFixture>>;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let errors: string[];

beforeAll(async () => {
  fixture = await startWorkspaceNavigationFixture(app => {
    // Stands in front of the real route ONLY for the "could not look" case; when the flag is
    // off it falls through to the real registration below.
    app.get('/api/readiness', (_req, res, next) => {
      if (server.readinessReadable) { next(); return; }
      res.status(500).json({ ready: false, error: 'readiness computation failed' });
    });
    registerReadinessRoutes(app as unknown as express.Express, {
      pool: {
        query: async () => {
          if (server.dbFails) throw new Error('synthetic postgres ping failure');
          return { rows: [] };
        },
      },
    } as never);
  });
  browser = await chromium.launch({ headless: true });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await browser?.close();
  await fixture?.close();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  resetPersistenceModes();
  server.dbFails = false;
  server.readinessReadable = true;
  errors = [];
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  await context?.close();
}, HOOK_TIMEOUT_MS);

/** @description The status-bar durable-storage indicator, after the shell's boot read. */
async function bootAndReadIndicator(): Promise<{ hidden: boolean; text: string; title: string; state: string | null }> {
  await page.goto(`${fixture.origin}/cockpit/`);
  const item = page.locator('#statusPersistenceItem');
  await item.waitFor({ state: 'attached' });
  // The boot read is async; wait for the shell to have written a verdict into the element.
  await page.waitForFunction(() => {
    const el = document.getElementById('statusPersistenceItem');
    return !!el && el.dataset.persistenceState !== 'unread';
  });
  return {
    hidden: await item.evaluate(el => el.classList.contains('hidden')),
    text: (await item.textContent() ?? '').trim(),
    title: await item.getAttribute('title') ?? '',
    state: await item.getAttribute('data-persistence-state'),
  };
}

it('names a store stranded in memory on the status bar, through the real 503 readiness answer', async () => {
  recordPersistenceMode({
    store: 'task-store', mode: 'memory', attempts: 3,
    detail: 'Connection terminated due to connection timeout',
  });
  recordPersistenceMode({ store: 'message-store', mode: 'persistent', attempts: 1 });

  // The readiness contract itself: degraded persistence is a 503, and the body still carries
  // the report. A status-bar read routed through the cockpit's getSafe would drop this body.
  const response = await fetch(`${fixture.origin}/api/readiness`);
  expect(response.status).toBe(503);
  expect((await response.json()).legs.persistence.state).toBe('fail');

  const indicator = await bootAndReadIndicator();
  expect(indicator.hidden).toBe(false);
  expect(indicator.state).toBe('degraded');
  expect(indicator.text).toContain('Storage: IN MEMORY');
  expect(indicator.title).toContain('task-store');
  expect(indicator.title).toContain('3 attempt(s)');
  expect(errors).toEqual([]);
}, TEST_TIMEOUT_MS);

it('stays silent when persistence is healthy even though another leg has failed the report', async () => {
  // The whole report is 503 (the db ping is down) while persistence itself is fine. The
  // indicator must read its own leg, not the report's `ready` flag - otherwise every unrelated
  // readiness failure would tell the operator their storage is gone.
  server.dbFails = true;
  recordPersistenceMode({ store: 'task-store', mode: 'persistent', attempts: 1 });

  const report = await (await fetch(`${fixture.origin}/api/readiness`)).json();
  expect(report.ready).toBe(false);
  expect(report.legs.db.state).toBe('fail');
  expect(report.legs.persistence.state).toBe('ok');

  const indicator = await bootAndReadIndicator();
  expect(indicator.hidden).toBe(true);
  expect(indicator.state).toBe('ok');
  expect(errors).toEqual([]);
}, TEST_TIMEOUT_MS);

it('says the storage state is unknown when readiness cannot be read at all', async () => {
  // "Could not look" is not "looked and found nothing wrong". An unreadable readiness endpoint
  // must never leave the operator with a status bar that implies durable storage is fine.
  server.readinessReadable = false;
  recordPersistenceMode({ store: 'task-store', mode: 'memory', attempts: 2, detail: 'unreachable' });

  const indicator = await bootAndReadIndicator();
  expect(indicator.hidden).toBe(false);
  expect(indicator.state).toBe('unknown');
  expect(indicator.text).toContain('Storage: unknown');
  expect(indicator.title).toContain('unverified');
  expect(errors).toEqual([]);
}, TEST_TIMEOUT_MS);
