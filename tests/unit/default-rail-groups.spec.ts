/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Named guard for the default cockpit rail's hand-maintained bands. config-seed/profiles/oshal-framework.json has no linkage to install state, manifest suites, or anything else that could notice a tile drifting between groups — a one-word edit silently restrands a surface and nothing goes red. This crosses the boundary the operator actually sees: the real UIProfileService reads the real file from disk and the real createUiProfileRoutes router serves it over HTTP, and the assertions run on the served body. Circuit Lab must stay in Engineering; Animatronics and Pumpkin must stay together in the Animatronics band, Pumpkin directly under Animatronics.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUiProfileRoutes } from '@/app/routes/ui-profile-routes';
import { UIProfileService } from '@/features/ui-profile';

/** The profile the deployed cockpit runs on (`UI_PROFILE` in the operator .env). */
const PROFILE_NAME = 'oshal-framework';

/** One ribbon tile as the profile JSON declares it and the route serves it. */
interface ServedItem {
  id: string;
  label?: string;
  section?: string;
  group?: string;
}

let server: Server;
let origin: string;
let served: ServedItem[];
let savedUiProfile: string | undefined;

/**
 * @description Groups the served `top` tiles the way the cockpit rail draws them —
 * `RibbonNav#_renderGroups` buckets by the `group` string and orders the bands by each
 * group's FIRST appearance in the item list, which is why a band stays contiguous on
 * screen even when its members are not adjacent in the file.
 * @param items - The tiles as served by GET /api/ui/profile.
 * @returns Band labels in render order, each with its tile labels in render order.
 */
function bands(items: ServedItem[]): Array<{ group: string; labels: string[] }> {
  const order: string[] = [];
  const byGroup = new Map<string, string[]>();
  for (const item of items) {
    if (item.section === 'bottom' || item.section === 'home') continue;
    const group = item.group || '';
    if (!byGroup.has(group)) { byGroup.set(group, []); order.push(group); }
    byGroup.get(group)!.push(item.label || item.id);
  }
  return order.map(group => ({ group, labels: byGroup.get(group)! }));
}

/**
 * @description Finds one band by its heading.
 * @param group - The band heading as the rail prints it.
 * @returns The band's tile labels, or undefined when no tile declares that group.
 */
function band(group: string): string[] | undefined {
  return bands(served).find(entry => entry.group === group)?.labels;
}

beforeAll(async () => {
  savedUiProfile = process.env.UI_PROFILE;
  process.env.UI_PROFILE = PROFILE_NAME;
  const app = express();
  // The real service (real fs read of config-seed/profiles) behind the real router. No
  // SwarmAppService is passed for the same reason the deployed route never synthesises this
  // profile: there is no swarm-app manifest named oshal-framework, so the live answer is
  // `source: "disk"` and the served body is the file verbatim.
  app.use('/api/ui', createUiProfileRoutes(new UIProfileService()));
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const response = await fetch(`${origin}/api/ui/profile`);
  expect(response.status).toBe(200);
  const body = await response.json() as { source: string; profile: { ribbon: { items: ServedItem[] } } };
  expect(body.source).toBe('disk');
  served = body.profile.ribbon.items;
});

afterAll(async () => {
  if (savedUiProfile === undefined) delete process.env.UI_PROFILE; else process.env.UI_PROFILE = savedUiProfile;
  await new Promise<void>(resolve => server?.close(() => resolve()));
});

describe('default cockpit rail bands', () => {
  it('serves the deployed profile from disk with tiles that carry bands', () => {
    expect(served.length).toBeGreaterThan(0);
    expect(bands(served).filter(entry => entry.group).length).toBeGreaterThan(0);
  });

  it('keeps Circuit Lab in the Engineering band', () => {
    const tile = served.find(item => item.id === 'tool-circuit-lab');
    expect(tile, 'tool-circuit-lab disappeared from the default rail').toBeDefined();
    expect(tile!.group).toBe('Engineering');
    expect(band('Engineering')).toContain('Circuit Lab');
  });

  it('keeps Pumpkin in the Animatronics band, directly under Animatronics', () => {
    const animatronics = served.find(item => item.id === 'tool-animatronics');
    const pumpkin = served.find(item => item.id === 'tool-pumpkin');
    expect(animatronics, 'tool-animatronics disappeared from the default rail').toBeDefined();
    expect(pumpkin, 'tool-pumpkin disappeared from the default rail').toBeDefined();
    expect(animatronics!.group).toBe('Animatronics');
    expect(pumpkin!.group).toBe('Animatronics');
    // The operator asked for Pumpkin "under animatronics". The rail has no nesting, so the
    // only shape that says it is: one band headed Animatronics, Pumpkin drawn next after it.
    expect(band('Animatronics')).toEqual(['Animatronics', 'Pumpkin']);
  });

  it('leaves Pumpkin out of every other band', () => {
    const elsewhere = bands(served)
      .filter(entry => entry.group !== 'Animatronics' && entry.labels.includes('Pumpkin'))
      .map(entry => entry.group);
    expect(elsewhere).toEqual([]);
    expect(band('Tools')).not.toContain('Pumpkin');
  });
});
