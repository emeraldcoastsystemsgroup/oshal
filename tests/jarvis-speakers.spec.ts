/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added isolated browser coverage for the reusable Jarvis Voice & Speakers lifecycle, capability gates, safe profile actions, recording events, and responsive layout.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added enrollment, explicit-recording, verified-member, degraded-result, and 7 MiB limit regressions.
 */

import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'src', 'api', 'jarvis-speakers.js');
const STYLE = path.join(ROOT, 'src', 'api', 'jarvis-speakers.css');

interface ApiState {
  context: Record<string, unknown>;
  speakers: Array<Record<string, unknown>>;
  contextsByTenant?: Record<string, Record<string, unknown>>;
  profileEnvelope?: 'speakers' | 'profiles';
}

interface CapturedRequest {
  method: string;
  path: string;
  body: unknown;
}

const PRIVATE_CONTEXT = {
  voiceProfilesAvailable: true,
  guest: false,
  currentUser: { userSub: 'the operator-sub', displayName: 'oshal maintainers', profileId: 'self-profile' },
  tenantMemberAssignmentAvailable: true,
  selectedTenantId: 'tenant-private',
  organizations: [{ tenantId: 'tenant-private', name: 'Demo Home', kind: 'org' }],
  members: [
    { userSub: 'the operator-sub', displayName: 'oshal maintainers', identityAvailable: true, role: 'admin' },
    { userSub: 'member-sub', displayName: 'Sam Carter', identityAvailable: true, role: 'member' },
  ],
};

const PROFILES = [
  {
    profileId: 'unknown-1', labelKind: 'anonymous', anonymousOrdinal: 1,
    displayLabel: 'Unidentified Person 1', segmentCount: 8, lastSeenAt: '2026-07-09T20:30:00.000Z',
    excerpts: [{ text: 'the operator, please remind me about the dentist.', capturedAt: '2026-07-09T20:30:00.000Z' }], status: 'active',
  },
  {
    profileId: 'unknown-2', labelKind: 'anonymous', anonymousOrdinal: 2,
    segmentCount: 2, excerpts: ['Can somebody close the garage?'], status: 'active',
  },
  {
    profileId: 'self-profile', labelKind: 'self', displayLabel: 'oshal maintainers',
    segmentCount: 31, lastSeenAt: '2026-07-09T20:35:00.000Z', status: 'active',
  },
  {
    profileId: 'unsafe-profile', labelKind: 'custom', displayLabel: '<img src=x onerror=window.pwned=1>',
    customName: '<img src=x onerror=window.pwned=1>', segmentCount: 1, status: 'active',
  },
];

async function mockApp(page: Page, state: ApiState, captured: CapturedRequest[]): Promise<void> {
  await page.route('https://jarvis.test/**', async (route) => routeApi(route, state, captured));
  await page.goto('https://jarvis.test/');
  await page.addStyleTag({ path: STYLE });
  await page.addScriptTag({ path: SCRIPT });
}

async function routeApi(route: Route, state: ApiState, captured: CapturedRequest[]): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === '/') {
    await route.fulfill({ contentType: 'text/html', body: '<button id="opener">Speaker settings</button><div data-ja-speakers></div>' });
    return;
  }
  if (url.pathname.endsWith('/speaker-context')) {
    const selected = url.searchParams.get('tenantId');
    const context = selected && state.contextsByTenant?.[selected] ? state.contextsByTenant[selected] : state.context;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(context) });
    return;
  }
  if (url.pathname.endsWith('/speakers') && request.method() === 'GET') {
    const key = state.profileEnvelope || 'speakers';
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ [key]: state.speakers }) });
    return;
  }
  captured.push({ method: request.method(), path: url.pathname, body: readJsonBody(request.postData()) });
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
}

function readJsonBody(value: string | null): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return value; }
}

async function mountAndOpen(page: Page, settings = { speakerDiarizationEnabled: true, rememberSpeakers: true }): Promise<void> {
  await page.locator('#opener').focus();
  await page.evaluate(async (initialSettings) => {
    const api = (window as unknown as { JarvisSpeakers: { mount: (options: unknown) => { open: () => Promise<unknown> } } }).JarvisSpeakers;
    const panel = api.mount({ mountTarget: document.querySelector('[data-ja-speakers]'), apiBase: '/api/jarvis/ambient', settings: initialSettings });
    (window as unknown as { speakerPanel: unknown }).speakerPanel = panel;
    await panel.open();
  }, settings);
}

test.describe('Jarvis Voice & Speakers panel', () => {
  test('renders safe private profiles, transcript context, disclosure state, and focus lifecycle', async ({ page }) => {
    const state = { context: PRIVATE_CONTEXT, speakers: PROFILES };
    await mockApp(page, state, []);
    await mountAndOpen(page);

    const panel = page.locator('.jarvis-speakers__panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Voice & Speakers' })).toBeVisible();
    await expect(panel).toContainText('Speaker profiles are private and available');
    await expect(panel).toContainText('Voice profiles stay private to you');
    await expect(panel).toContainText('Identification · On');
    await expect(panel).toContainText('Remember voices · On');
    await expect(panel).toContainText('Unidentified Person 1');
    await expect(panel).toContainText('the operator, please remind me about the dentist.');
    await expect(panel).toContainText('<img src=x onerror=window.pwned=1>');
    await expect(panel.locator('img,audio')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();

    await page.evaluate(() => document.dispatchEvent(new CustomEvent('jarvis:ambient-ready', {
      detail: { settings: { speakerDiarizationEnabled: false, rememberSpeakers: false } },
    })));
    await expect(panel).toContainText('Identification · Off');
    await expect(panel).toContainText('Remember voices · Off');

    await panel.getByRole('button', { name: 'Close Voice & Speakers' }).click();
    await expect(panel).toBeHidden();
    await expect(page.locator('#opener')).toBeFocused();
  });

  test('normalizes the nested profile and context shapes returned by the production routes', async ({ page }) => {
    const actualContext = {
      available: true, reason: 'private_org_available', selectedTenantId: 'tenant-private',
      currentUser: { userSub: 'the operator-sub', displayName: 'oshal maintainers', profileId: null },
      organizations: [{ tenantId: 'tenant-private', name: 'Demo Home', role: 'admin' }],
      members: [{ userSub: 'member-sub', displayName: 'Sam Carter', identityAvailable: true, role: 'member' }],
    };
    const actualProfiles = [{
      profileId: 'a1111111-1111-4111-8111-111111111111', ordinal: 7,
      label: 'Unidentified Person 7', assignment: { kind: 'unassigned', customName: null, tenantId: null, memberSub: null },
      sampleCount: 4, firstSeenAt: '2026-07-09T18:00:00.000Z', lastSeenAt: '2026-07-09T18:15:00.000Z',
    }];
    await mockApp(page, { context: actualContext, speakers: actualProfiles, profileEnvelope: 'profiles' }, []);
    await mountAndOpen(page);

    const panel = page.locator('.jarvis-speakers__panel');
    await expect(panel).toContainText('Unidentified Person 7');
    await expect(panel).toContainText('4 voice samples');
    await expect(panel).toContainText('oshal maintainers');
    await expect(panel.getByLabel('Import recording')).toHaveAttribute('accept', /audio\/wav/);
    await expect(panel).toContainText('Google Cloud Speech-to-Text');
    await expect(panel).toContainText('Raw audio is never kept');
  });

  test('lets a multi-organization owner choose and persist the member directory', async ({ page }) => {
    const captured: CapturedRequest[] = [];
    const organizations = [
      { tenantId: 'tenant-one', name: 'First Org', role: 'member' },
      { tenantId: 'tenant-two', name: 'Second Org', role: 'admin' },
    ];
    const context = {
      available: true, reason: 'private_org_available', selectedTenantId: null,
      organizations, members: [],
    };
    const selectedContext = {
      ...context, selectedTenantId: 'tenant-two',
      members: [{ userSub: 'member-sub', displayName: 'Sam Carter', identityAvailable: true, role: 'member' }],
    };
    await mockApp(page, {
      context, speakers: PROFILES, contextsByTenant: { 'tenant-two': selectedContext },
    }, captured);
    await mountAndOpen(page);

    await page.getByLabel('Organization directory').selectOption('tenant-two');
    await expect(page.locator('.jarvis-speakers__panel')).toContainText('Second Org');
    await expect.poll(() => captured.some((item) => item.path.endsWith('/settings'))).toBe(true);
    const saved = captured.find((item) => item.path.endsWith('/settings'));
    expect(saved).toMatchObject({ method: 'PUT', body: { speakerTenantId: 'tenant-two' } });

    await page.locator('[data-profile-id="unknown-1"]').getByRole('button', { name: 'Assign', exact: true }).click();
    await page.getByLabel('A private-organization member').check();
    await expect(page.locator('select[name="memberSub"]')).toContainText('Sam Carter');
  });

  test('assigns as me, a custom name, and a private-organization member with exact DTOs', async ({ page }) => {
    const captured: CapturedRequest[] = [];
    await mockApp(page, { context: PRIVATE_CONTEXT, speakers: PROFILES }, captured);
    await mountAndOpen(page);
    const card = page.locator('[data-profile-id="unknown-1"]');
    const panel = page.locator('.jarvis-speakers__panel');

    await card.getByRole('button', { name: 'Assign', exact: true }).click();
    await expect(panel).toHaveAttribute('aria-hidden', 'true');
    expect(await panel.evaluate((element) => (element as HTMLElement).inert)).toBe(true);
    await expect(page.getByRole('dialog')).toContainText('Changes update the label shown on retained history.');
    await page.getByLabel('Me — oshal maintainers').check();
    await page.getByRole('button', { name: 'Save assignment' }).click();
    await expect.poll(() => captured.length).toBe(1);
    await expect(panel).not.toHaveAttribute('aria-hidden', 'true');
    expect(await panel.evaluate((element) => (element as HTMLElement).inert)).toBe(false);
    expect(captured[0]).toMatchObject({ method: 'PUT', body: { kind: 'self' } });

    await card.getByRole('button', { name: 'Assign', exact: true }).click();
    await page.getByLabel('A private name').check();
    await page.getByLabel('Name', { exact: true }).fill('Kitchen guest');
    await page.getByRole('button', { name: 'Save assignment' }).click();
    await expect.poll(() => captured.length).toBe(2);
    expect(captured[1].body).toEqual({ kind: 'custom', customName: 'Kitchen guest' });

    await card.getByRole('button', { name: 'Assign', exact: true }).click();
    await page.getByLabel('A private-organization member').check();
    await page.locator('select[name="memberSub"]').selectOption('member-sub');
    await page.getByRole('button', { name: 'Save assignment' }).click();
    await expect.poll(() => captured.length).toBe(3);
    expect(captured[2].body).toEqual({ kind: 'tenant_member', tenantId: 'tenant-private', memberSub: 'member-sub' });
  });

  test('never presents organization placeholders as assignable identities', async ({ page }) => {
    const context = {
      ...PRIVATE_CONTEXT,
      members: PRIVATE_CONTEXT.members,
      unavailableMemberCount: 1,
    };
    await mockApp(page, { context, speakers: PROFILES }, []);
    await mountAndOpen(page);

    await page.locator('[data-profile-id="unknown-1"]').getByRole('button', { name: 'Assign', exact: true }).click();
    await page.getByLabel('A private-organization member').check();
    const picker = page.locator('select[name="memberSub"]');
    await expect(picker).toContainText('Sam Carter');
    await expect(picker).not.toContainText('Organization member 3');
    await expect(page.locator('.jarvis-speakers__identity-note')).toContainText('needs to sign in before their name is available');
  });

  test('explains why organization assignment is unavailable when unnamed members were filtered', async ({ page }) => {
    const context = {
      ...PRIVATE_CONTEXT,
      tenantMemberAssignmentAvailable: false,
      members: [PRIVATE_CONTEXT.members[0]],
      unavailableMemberCount: 1,
    };
    await mockApp(page, { context, speakers: PROFILES }, []);
    await mountAndOpen(page);

    const panel = page.locator('.jarvis-speakers__panel');
    await expect(panel).toContainText('needs to sign in before their name is available for assignment');
    await panel.locator('[data-profile-id="unknown-1"]').getByRole('button', { name: 'Assign', exact: true }).click();
    await expect(page.getByLabel('A private-organization member')).toHaveCount(0);
  });

  test('merges, unassigns, and forgets profiles through bounded confirmation flows', async ({ page }) => {
    const captured: CapturedRequest[] = [];
    await mockApp(page, { context: PRIVATE_CONTEXT, speakers: PROFILES }, captured);
    await mountAndOpen(page);

    const unknown = page.locator('[data-profile-id="unknown-1"]');
    await unknown.getByRole('button', { name: 'Merge' }).click();
    await page.getByLabel('Merge into').selectOption('unknown-2');
    await page.getByRole('button', { name: 'Merge voices' }).click();
    await expect.poll(() => captured.length).toBe(1);
    expect(captured[0]).toMatchObject({
      path: '/api/jarvis/ambient/speakers/unknown-2/merge',
      body: { sourceProfileId: 'unknown-1' },
    });

    const known = page.locator('[data-profile-id="self-profile"]');
    await known.getByRole('button', { name: 'Unassign' }).click();
    await page.locator('.jarvis-speakers__action-dialog').getByRole('button', { name: 'Unassign' }).click();
    await expect.poll(() => captured.length).toBe(2);
    expect(captured[1].body).toEqual({ kind: 'unassigned' });

    await unknown.getByRole('button', { name: 'Forget voice' }).click();
    await page.locator('.jarvis-speakers__action-dialog').getByRole('button', { name: 'Forget voice' }).click();
    await expect.poll(() => captured.length).toBe(3);
    expect(captured[2]).toMatchObject({ method: 'DELETE', body: null });
  });

  test('fails closed for guest and public capability states while leaving transient import available', async ({ page }) => {
    const publicContext = {
      available: false, reason: 'public_tenant', selectedTenantId: null,
      organizations: [], members: [{ userSub: 'leak', displayName: 'Must Not Leak', identityAvailable: false, role: 'member' }],
    };
    await mockApp(page, { context: publicContext, speakers: [PROFILES[0]] }, []);
    await mountAndOpen(page, { speakerDiarizationEnabled: true, rememberSpeakers: false });

    const panel = page.locator('.jarvis-speakers__panel');
    await expect(panel).toContainText('Profiles are not remembered in this session');
    await expect(panel).toContainText('Guest and public sessions may process a recording');
    await expect(panel).not.toContainText('Must Not Leak');
    await expect(panel.getByRole('button', { name: /my voice/i })).toBeDisabled();
    await expect(panel.locator('[data-profile-id="unknown-1"] [data-action="assign"]')).toHaveCount(0);
    await expect(panel.getByLabel('Import recording')).toBeVisible();
  });

  test('emits bounded enrollment, capture, and recording-import events with the selected File', async ({ page }) => {
    await mockApp(page, { context: PRIVATE_CONTEXT, speakers: PROFILES }, []);
    await page.evaluate(() => {
      const log: Array<Record<string, unknown>> = [];
      document.addEventListener('jarvis:speakers-enroll-requested', ((event: CustomEvent) => log.push({ type: event.type, ...event.detail })) as EventListener);
      document.addEventListener('jarvis:speakers-capture-requested', ((event: CustomEvent) => log.push({ type: event.type, ...event.detail })) as EventListener);
      document.addEventListener('jarvis:speakers-file-selected', ((event: CustomEvent) => log.push({ type: event.type, purpose: event.detail.purpose, name: event.detail.file.name, size: event.detail.file.size, isFile: event.detail.file instanceof File })) as EventListener);
      (window as unknown as { speakerEvents: Array<Record<string, unknown>> }).speakerEvents = log;
    });
    await mountAndOpen(page);

    await page.getByRole('button', { name: 'Refresh my voice' }).click();
    await page.getByRole('button', { name: 'Record 30 seconds' }).click();
    await page.getByLabel('Import recording').setInputFiles({ name: 'meeting.webm', mimeType: 'audio/webm', buffer: Buffer.from('bounded-audio') });

    const events = await page.evaluate(() => (window as unknown as { speakerEvents: unknown[] }).speakerEvents);
    expect(events).toEqual([
      { type: 'jarvis:speakers-enroll-requested', purpose: 'self_enrollment' },
      { type: 'jarvis:speakers-capture-requested', purpose: 'recording_capture' },
      { type: 'jarvis:speakers-file-selected', purpose: 'recording_import', name: 'meeting.webm', size: 13, isFile: true },
    ]);
    await expect(page.locator('.jarvis-speakers__audio-tools')).toContainText('Maximum 55 seconds and 7 MiB');
    await expect(page.locator('.jarvis-speakers__audio-tools')).toContainText('never kept');
  });

  test('requires remembered private profiles only for enrollment while leaving explicit recordings available', async ({ page }) => {
    const events: string[] = [];
    await mockApp(page, { context: PRIVATE_CONTEXT, speakers: PROFILES }, []);
    await page.evaluate(() => {
      document.addEventListener('jarvis:speakers-capture-requested', () => (window as any).speakerActions.push('capture'));
      (window as any).speakerActions = [];
    });
    await mountAndOpen(page, { speakerDiarizationEnabled: false, rememberSpeakers: false });

    const panel = page.locator('.jarvis-speakers__panel');
    await expect(panel.getByRole('button', { name: /my voice/i })).toBeDisabled();
    await expect(panel).toContainText('Turn on “Remember encrypted voice profiles”');
    await expect(panel.getByRole('button', { name: 'Record 30 seconds' })).toBeEnabled();
    await expect(panel.getByLabel('Import recording')).toBeEnabled();
    await panel.getByRole('button', { name: 'Record 30 seconds' }).click();
    events.push(...await page.evaluate(() => (window as any).speakerActions));
    expect(events).toEqual(['capture']);
  });

  test('reports degraded attribution honestly and rejects imports above the browser cap', async ({ page }) => {
    await mockApp(page, { context: PRIVATE_CONTEXT, speakers: PROFILES }, []);
    await mountAndOpen(page);
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('jarvis:speakers-upload-completed', {
      detail: {
        purpose: 'recording_import', transcriptOutcome: 'audio_persisted',
        result: {
          accepted: 1,
          processing: { status: 'degraded', transcription: 'client_fallback', diarization: 'unavailable' },
          segments: [{ text: 'Fallback text', speakerLabel: 'Speaker unavailable', speakerProfileId: null }],
        },
      },
    })));
    await expect(page.locator('[data-js-status]')).toContainText('speaker attribution was unavailable');
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('jarvis:speakers-refresh-requested')));
    await expect(page.locator('[data-js-status]')).toContainText('speaker attribution was unavailable');

    await page.evaluate(() => document.dispatchEvent(new CustomEvent('jarvis:speakers-upload-completed', {
      detail: {
        purpose: 'recording_import', transcriptOutcome: 'fallback_required', genericFallbackAvailable: false,
        result: {
          accepted: 0,
          processing: { status: 'degraded', transcription: 'unavailable', diarization: 'complete' },
          segments: [],
        },
      },
    })));
    await expect(page.locator('[data-js-status]')).toContainText('Configure a timestamp-capable speech service');
    await expect(page.locator('[data-js-status]')).not.toContainText('browser-recognized text will be saved');

    await page.getByLabel('Import recording').setInputFiles({
      name: 'too-large.webm', mimeType: 'audio/webm', buffer: Buffer.alloc((7 * 1024 * 1024) + 1),
    });
    await expect(page.locator('[data-js-status]')).toContainText('no larger than 7 MiB');
  });

  test('stays within a narrow mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await mockApp(page, { context: PRIVATE_CONTEXT, speakers: PROFILES }, []);
    await mountAndOpen(page);
    const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth);
    const columns = await page.locator('.jarvis-speakers__profile-list').first().evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(1);
  });
});
