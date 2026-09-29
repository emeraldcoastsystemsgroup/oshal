/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L4 done-when in Chromium on localhost with MOCK_OIDC: the real Settings, Location page over the real /api/location mount and a private PostgreSQL owned by the enforcing runtime role. A group admin adds their own place and a group place through the page, enrols their node (picked from the nodes they own), a camera (to the group) and a TV (by its room), each with a place, and then changes the TV's place; the page shows every assigned place. A member of the group opens the same page: the group camera shows its place view-only with no controls, the admin's node and TV are not there at all, and script on the page (running as the member) cannot change any of the three; the database is unchanged. Synthetic identities and coordinates only.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { addMember, createTenant } from '@/app/routes/connector-tenancy';
import { asSession } from '../helpers/location-postgres-fixture';
import {
  MOCK_ISSUER, MOCK_SUB_HEADER, seedNodeBinding, startLocationBrowserServer, type LocationBrowserServer,
} from '../helpers/location-browser-server';

const ADMIN = 'loc-l4-browser-admin';
const MEMBER = 'loc-l4-browser-member';
let fx: LocationBrowserServer;
let browser: Browser;
let group = '';

async function pageAs(sub: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ extraHTTPHeaders: { [MOCK_SUB_HEADER]: sub } });
  const page = await context.newPage();
  page.on('dialog', (dialog) => { void dialog.accept(); });
  await page.goto(`${fx.base}/cockpit/tools/location.html`);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === '');
  return { context, page };
}

const placedWhere = (page: Page, kind: string) =>
  page.textContent(`[data-testid="placed-row"][data-kind="${kind}"] [data-testid="placed-where"]`);

async function addPlace(page: Page, name: string, lat: string, lon: string, owner: string): Promise<void> {
  await page.fill('[data-testid="place-name"]', name);
  await page.fill('[data-testid="place-lat"]', lat);
  await page.fill('[data-testid="place-lon"]', lon);
  await page.selectOption('[data-testid="place-group"]', { label: owner });
  await page.click('[data-testid="place-add"]');
  await expect.poll(() => page.locator(`[data-testid="place-row"][data-name="${name}"]`).count()).toBe(1);
}

async function enrol(page: Page, kind: string, fields: { ref?: string; node?: string; place: string; room?: string }): Promise<void> {
  await page.selectOption('[data-testid="enrol-kind"]', kind);
  if (fields.node) await page.selectOption('[data-testid="enrol-node"]', fields.node);
  if (fields.ref) await page.fill('[data-testid="enrol-ref"]', fields.ref);
  await page.selectOption('[data-testid="enrol-place"]', { label: fields.place });
  if (fields.room) await page.fill('[data-testid="enrol-room"]', fields.room);
  await page.click('[data-testid="enrol-add"]');
  await expect.poll(() => page.locator(`[data-testid="placed-row"][data-kind="${kind}"]`).count()).toBe(1);
}

beforeAll(async () => {
  fx = await startLocationBrowserServer('location-places-browser');
  group = (await asSession({ sub: ADMIN, issuer: MOCK_ISSUER }, () => createTenant(fx.runtime, { name: 'Household', createdBySub: ADMIN }))).tenant_id;
  await asSession({ sub: ADMIN, issuer: MOCK_ISSUER }, () => addMember(fx.runtime, group, MEMBER, ADMIN));
  await seedNodeBinding(fx, 'node-desk', ADMIN);
  browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await fx?.close();
}, 60_000);

describe('Settings, Location: places and devices at places (Chromium, MOCK_OIDC, localhost)', () => {
  it('the owner adds places, enrols a node, a camera and a TV with places, and changes the TV\'s place', async () => {
    const { context, page } = await pageAs(ADMIN);
    await addPlace(page, 'Home', '-12.3461', '-31.9882', 'Just me');
    await addPlace(page, 'School', '-12.3500', '-31.9900', 'Group Household');
    await enrol(page, 'node', { node: 'node-desk', place: 'Home', room: 'Office' });
    await enrol(page, 'camera', { ref: 'cam-porch', place: 'School (Household)' });
    await enrol(page, 'tv', { ref: 'Den', place: 'Home' });
    expect(await placedWhere(page, 'node')).toBe('at Home · Office');
    expect(await placedWhere(page, 'camera')).toBe('at School');
    expect(await placedWhere(page, 'tv')).toBe('at Home · Den');
    const tvRow = page.locator('[data-testid="placed-row"][data-kind="tv"]');
    await tvRow.locator('[data-testid="placed-place"]').selectOption({ label: 'School (Household)' });
    await tvRow.locator('[data-testid="placed-save"]').click();
    await expect.poll(() => placedWhere(page, 'tv')).toBe('at School · Den');
    const rows = (await fx.db.pool.query(`SELECT d.device_kind, p.name FROM location_devices d JOIN location_places p ON p.place_id = d.place_id
      ORDER BY d.device_kind`)).rows;
    expect(rows).toEqual([{ device_kind: 'camera', name: 'School' }, { device_kind: 'node', name: 'Home' }, { device_kind: 'tv', name: 'School' }]);
    expect(await page.textContent('[data-testid="places"]')).not.toContain('-12.34');
    await context.close();
  }, 120_000);

  it('a member sees the group camera view-only, not the owner\'s node or TV, and cannot change any of them', async () => {
    const before = (await fx.db.pool.query('SELECT device_id, device_kind, place_id, room FROM location_devices ORDER BY device_kind')).rows;
    const { context, page } = await pageAs(MEMBER);
    expect(await page.locator('[data-testid="placed-row"]').count()).toBe(1);
    const camera = page.locator('[data-testid="placed-row"][data-kind="camera"]');
    expect(await camera.locator('[data-testid="placed-where"]').textContent()).toBe('at School');
    expect(await camera.locator('[data-testid="placed-place"]').count()).toBe(0);
    expect(await camera.textContent()).toContain('view only');
    const ids = Object.fromEntries(before.map((r) => [r.device_kind, r.device_id]));
    const outcome = await page.evaluate(async (targets: Record<string, string>) => {
      const out: Record<string, number> = {};
      for (const [kind, id] of Object.entries(targets)) {
        const res = await fetch(`/api/location/devices/${id}/place`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ placeId: null, room: 'moved' }) });
        out[kind] = res.status;
      }
      return out;
    }, ids);
    expect(outcome).toEqual({ camera: 403, node: 404, tv: 404 });
    expect((await fx.db.pool.query('SELECT device_id, device_kind, place_id, room FROM location_devices ORDER BY device_kind')).rows).toEqual(before);
    await context.close();
  }, 90_000);
});
