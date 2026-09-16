/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-145 D4/D5 guards. getAppStatusPlan resolves ONE name to a plan for an active GROUP or an active APP — the branch that lets an app belonging to no group report at all — and answers null for anything not among the manifests the caller may see (so an invisible or inactive app is indistinguishable from a missing one). composeAppTaskItems pins the D5 fallback: the `<App>: …` title prefix reads exactly as the cockpit Home view reads it, three items per app, age on every line, and a tone that NEVER escalates — nothing in the kernel may assert 'good' on an app's behalf.
 */

import { describe, it, expect } from 'vitest';
import {
  getAppStatusPlan,
  composeAppTaskItems,
  appTaskTitlePrefixes,
  APP_STATUS_FALLBACK_ITEMS,
  APP_STATUS_FALLBACK_TEXT_CHARS,
  type SwarmAppManifest,
} from '@/features/swarm-apps';

const app = (name: string, extra: Record<string, unknown> = {}): SwarmAppManifest => ({
  name,
  displayName: name.toUpperCase(),
  routes: [{ module: `routes/${name}.js`, factory: 'f', mountPath: `/api/${name}`, auth: 'oidc' }],
  ...extra,
} as unknown as SwarmAppManifest);

const withSummary = (name: string) => app(name, {
  summary: { path: `/api/${name}/summary`, tilesPointer: '/tiles', itemsPointer: '/items' },
  ui: { static: [{ toolName: `${name}-home`, label: 'Home', icon: 'i', iframeUrl: `/api/${name}/ui` }] },
});

const withReadiness = (name: string) => app(name, {
  readiness: [{ name: 'connect-inbox', path: `/api/${name}/state`, readyPointer: '/ready', detailPointer: '/detail' }],
});

const group = (members: string[]): SwarmAppManifest => ({
  name: 'g1',
  displayName: 'Group One',
  kind: 'group',
  description: 'The front door',
  dependencies: { apps: members },
  setup: [{ label: 'Connect your inbox', app: members[0], readiness: 'connect-inbox', fix: `${members[0]}-home` }],
  toolbar: [{ app: members[1], surface: `${members[1]}-home` }],
} as unknown as SwarmAppManifest);

describe('getAppStatusPlan — one name resolves to a group OR a plain app (ADR-145 D4)', () => {
  it('resolves a plain app to itself as its only member, with its own summary probe', () => {
    const plan = getAppStatusPlan('solo', [withSummary('solo')]);
    expect(plan).toMatchObject({ name: 'solo', group: 'solo', kind: 'app', members: ['solo'] });
    expect(plan!.summary).toEqual([expect.objectContaining({
      app: 'solo', appDisplayName: 'SOLO', path: '/api/solo/summary',
      tilesPointer: '/tiles', itemsPointer: '/items', surfaces: ['solo-home'],
    })]);
    expect(plan!.firstSurface).toBe('solo-home');
    expect(plan!.undeclared).toEqual([]);
  });

  it('gives a plain app its OWN readiness probes as steps, humanising the slug no group labelled', () => {
    const plan = getAppStatusPlan('solo', [withReadiness('solo')]);
    expect(plan!.steps).toEqual([{
      label: 'Connect inbox',
      app: 'solo',
      appDisplayName: 'SOLO',
      readiness: 'connect-inbox',
      probe: { path: '/api/solo/state', readyPointer: '/ready', detailPointer: '/detail' },
    }]);
    // No group setup[] means no `fix`: the kernel never invents a destination an app did not name.
    expect(plan!.steps[0].fix).toBeUndefined();
  });

  it('resolves a group to its ACTIVE members, borrowing the group label and fix for the step', () => {
    const plan = getAppStatusPlan('g1', [withReadiness('m1'), withSummary('m2'), group(['m1', 'm2'])]);
    expect(plan).toMatchObject({ name: 'g1', kind: 'group', members: ['m1', 'm2'], description: 'The front door' });
    expect(plan!.steps[0]).toMatchObject({ label: 'Connect your inbox', app: 'm1', fix: 'm1-home' });
    expect(plan!.summary.map((probe) => probe.app)).toEqual(['m2']);
    expect(plan!.firstSurface).toBe('m2-home');
  });

  it('skips a group member that is not active, and its step reports unavailable rather than done', () => {
    const plan = getAppStatusPlan('g1', [withSummary('m2'), group(['m1', 'm2'])]);
    expect(plan!.members).toEqual(['m2']);
    expect(plan!.steps[0].probe).toBeUndefined();
    expect(plan!.steps[0].unavailable).toMatch(/m1/);
  });

  it('lists every app with no `summary:` as undeclared — the D5 fallback applies to exactly those', () => {
    const plan = getAppStatusPlan('g1', [withReadiness('m1'), withSummary('m2'), group(['m1', 'm2'])]);
    expect(plan!.undeclared).toEqual([{ name: 'm1', displayName: 'M1' }]);
    expect(getAppStatusPlan('solo', [app('solo')])!.undeclared).toEqual([{ name: 'solo', displayName: 'SOLO' }]);
  });

  it('answers null for a name that is not among the manifests the caller may see', () => {
    expect(getAppStatusPlan('missing', [withSummary('solo')])).toBeNull();
    expect(getAppStatusPlan('solo', [])).toBeNull();
  });

  it('an app that declares nothing still resolves to a plan — with no probes and no steps', () => {
    const plan = getAppStatusPlan('bare', [{ name: 'bare', displayName: 'Bare' } as unknown as SwarmAppManifest]);
    expect(plan).toMatchObject({ name: 'bare', kind: 'app', members: ['bare'] });
    expect(plan!.summary).toEqual([]);
    expect(plan!.steps).toEqual([]);
  });
});

describe('composeAppTaskItems — the D5 fallback, bounded and never escalating', () => {
  const solo = { name: 'solo', displayName: 'Solo App' };
  const row = (title: string, status = 'done', daysAgo = 0) => ({
    title,
    status,
    created_at: new Date(Date.now() - daysAgo * 86400000).toISOString(),
  });

  it('matches the `<App>: …` prefix on display name OR manifest name, case-insensitively', () => {
    expect(appTaskTitlePrefixes(solo)).toEqual(['solo app:', 'solo:']);
    const items = composeAppTaskItems([row('Solo App: pulled the inbox'), row('SOLO: swept the queue')], [solo]);
    expect(items.map((i) => i.text)).toEqual([
      'pulled the inbox — done (today)',
      'swept the queue — done (today)',
    ]);
  });

  it('requires the colon AND whitespace the cockpit Home view requires, so the two agree', () => {
    expect(composeAppTaskItems([row('Solo App:no-space')], [solo])).toEqual([]);
    expect(composeAppTaskItems([row('Solo Application: not this app')], [solo])).toEqual([]);
  });

  it('keeps at most three per app, newest first, and drops rows belonging to no app', () => {
    const rows = [row('Solo App: one'), row('Solo App: two'), row('Solo App: three'), row('Solo App: four'), row('nothing here')];
    const items = composeAppTaskItems(rows, [solo]);
    expect(items).toHaveLength(APP_STATUS_FALLBACK_ITEMS);
    expect(items.map((i) => i.text.split(' —')[0])).toEqual(['one', 'two', 'three']);
  });

  it('gives the longest matching prefix the row — a sibling app never steals it', () => {
    const trends = { name: 'solo-trends', displayName: 'Solo App Trends' };
    const items = composeAppTaskItems([row('Solo App Trends: the weekly roll-up')], [solo, trends]);
    expect(items).toEqual([expect.objectContaining({ app: 'solo-trends' })]);
  });

  it('carries the age so a month-old task never reads like this morning', () => {
    const items = composeAppTaskItems([row('Solo App: a', 'done', 1), row('Solo App: b', 'done', 30)], [solo]);
    expect(items[0].text).toContain('(1 day ago)');
    expect(items[1].text).toContain('(30 days ago)');
  });

  it('warns for a stopped task, stays neutral otherwise, and NEVER asserts good', () => {
    const items = composeAppTaskItems(
      [row('Solo App: failed one', 'error'), row('Solo App: running one', 'queued'), row('Solo App: finished', 'done')],
      [solo],
    );
    expect(items.map((i) => i.tone)).toEqual(['warn', 'neutral', 'neutral']);
    expect(items.map((i) => i.tone)).not.toContain('good');
    expect(items[1].text).toContain('in progress');
    expect(items[0].text).toContain('failed');
  });

  it('clamps a long title to the D2 item bound instead of rejecting it', () => {
    const items = composeAppTaskItems([row(`Solo App: ${'x'.repeat(400)}`)], [solo]);
    expect(items[0].text).toHaveLength(APP_STATUS_FALLBACK_TEXT_CHARS);
    expect(items[0].text.endsWith('…')).toBe(true);
  });

  it('returns nothing rather than throwing when a row is malformed or the app list is empty', () => {
    expect(composeAppTaskItems([{ title: null as unknown as string, status: 'done' }], [solo])).toEqual([]);
    expect(composeAppTaskItems([row('Solo App: a')], [])).toEqual([]);
  });
});
