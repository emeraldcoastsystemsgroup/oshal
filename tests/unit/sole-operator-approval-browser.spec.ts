/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Chromium drives the real Access Administration page, routes and policy service through sole-operator self-approval: a sensitive self-grant stays unappliable until the caller types "approve", then applies with the approval reference bound to that preview; with a second administrator the server refuses and the page says why. The administrator census is an in-memory double here; its real PostgreSQL companion is sole-operator-approval-postgres.spec.ts.
 */
/** Chromium drives the real Access Administration page and shared policy HTTP service on loopback. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { ISSUER, createAuthorizationFixture } from '../fixtures/authorization';
import { createSoleOperatorApprovalVerifier, type SwarmAdministratorIdentity } from '../../src/app/composition/sole-operator-approval';

let browser: Browser, context: BrowserContext, page: Page;
let fixture: Awaited<ReturnType<typeof createAuthorizationFixture>>;
let administrators: SwarmAdministratorIdentity[];
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, 30000);
afterAll(async () => { await browser?.close(); }, 30000);
beforeEach(async () => {
  administrators = [{ sub: 'admin', issuer: ISSUER }];
  fixture = await createAuthorizationFixture(undefined, undefined,
    createSoleOperatorApprovalVerifier({ rootSub: async () => 'admin', administrators: async () => administrators }));
  context = await browser.newContext();
  await context.addCookies([{ name: 'session', value: 'admin', url: fixture.base }]);
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.base ? route.continue() : route.abort());
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(fixture.base + '/access/', { timeout: 30000 });
  await page.locator('#administration').waitFor({ state: 'visible' });
  const panel = page.locator('#advanced-access');
  if (!await panel.evaluate(element => (element as HTMLDetailsElement).open)) await panel.locator('summary').first().click();
  await expect.poll(() => page.locator('#status').textContent()).toContain('Access catalog loaded');
}, 30000);
afterEach(async () => { await context?.close(); await fixture?.close(); }, 30000);

/** Preview granting the signed-in administrator a sensitive role: a change that needs approval. */
async function previewSensitiveSelfGrant(): Promise<void> {
  await page.locator('#manual-target summary').click();
  await page.locator('#manual-issuer').fill(ISSUER); await page.locator('#manual-id').fill('admin');
  await page.locator('#use-manual-target').click();
  await page.locator('#operation').selectOption('grant');
  await page.locator('#role').selectOption('sensitive-reader');
  await page.locator('#reason').fill('Sole-operator self-approval browser proof');
  await page.locator('#preview-button').click();
  await page.locator('#review').waitFor({ state: 'visible' });
}

describe('Sole-operator self-approval in Access Administration', () => {
  it('applies a sensitive self-grant only after the caller types approve, with the reference bound to the preview', async () => {
    await previewSensitiveSelfGrant();
    expect(await page.locator('#self-approval').isVisible()).toBe(true);
    expect(await page.locator('#preview-expiry').textContent()).toContain('separate, verified approval');
    expect(await page.locator('#apply').isDisabled()).toBe(true);
    await page.locator('#self-approval-confirm').fill('approv');
    expect(await page.locator('#apply').isDisabled()).toBe(true);
    await page.locator('#self-approval-confirm').fill('approve');
    expect(await page.locator('#apply').isDisabled()).toBe(false);
    await page.locator('#apply').click();
    await expect.poll(() => page.locator('#status').textContent()).toContain('Change applied');
    const [assignment] = (await fixture.store.read()).assignments;
    expect(assignment).toMatchObject({ targetSub: 'admin', targetIssuer: ISSUER, role: 'sensitive-reader' });
    const event = fixture.store.auditEvents.at(-1)!;
    expect(event.approvalReference).toBe(`sole-operator-self-approval:${event.previewId}`);
  });

  it('shows the refusal and applies nothing once a second administrator exists', async () => {
    administrators = [{ sub: 'admin', issuer: ISSUER }, { sub: 'second-admin', issuer: ISSUER }];
    await previewSensitiveSelfGrant();
    await page.locator('#self-approval-confirm').fill('approve');
    await page.locator('#apply').click();
    await expect.poll(() => page.locator('#status').textContent()).toContain('Self-approval was refused');
    expect((await fixture.store.read()).assignments).toEqual([]);
    expect(fixture.store.auditEvents).toHaveLength(0);
    expect(await page.locator('#self-approval').isVisible()).toBe(false);
  });

  it('shows no confirmation for a change that needs no approval', async () => {
    await page.locator('#manual-target summary').click();
    await page.locator('#manual-issuer').fill(ISSUER); await page.locator('#manual-id').fill('alice');
    await page.locator('#use-manual-target').click();
    await page.locator('#operation').selectOption('grant');
    await page.locator('#reason').fill('Ordinary grant');
    await page.locator('#preview-button').click();
    await page.locator('#review').waitFor({ state: 'visible' });
    expect(await page.locator('#self-approval').isVisible()).toBe(false);
    await page.locator('#apply').click();
    await expect.poll(() => page.locator('#status').textContent()).toContain('Change applied');
    expect(fixture.store.auditEvents.at(-1)!.approvalReference).toBeUndefined();
  });
});
