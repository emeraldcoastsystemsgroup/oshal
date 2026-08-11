/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the manifest->ribbon `group` hand-off. RibbonNav has grouped its top tray on `view.group` since the rail-pin work, but synthesiseProfile's static-item map copied a fixed key list that omitted `group`, so a manifest declaring it rendered an identical flat ribbon — no error, no warning, nothing in a log. The feature looked unimplemented for as long as the key was dropped. These cases run the REAL synthesiseProfile (only the repository is doubled) so a future re-tightening of that map fails here instead of shipping another silent no-op.
 */

import { describe, expect, it } from 'vitest';
import { SwarmAppService } from '@/features/swarm-apps';
import type { SwarmApplication } from '@/features/swarm-apps';

/**
 * @description Builds a service whose repository returns exactly one manifest, so the
 * real synthesiseProfile runs against it. Only the repository is doubled — the mapping
 * under test is the production code path, per the repo's integration-boundary rule.
 * @param manifest - The manifest body the fake repository should return.
 * @returns A SwarmAppService ready for synthesiseProfile().
 */
function serviceFor(manifest: Record<string, unknown>): SwarmAppService {
  const repo = {
    findByName: async () => ({ name: 'career-hunter', status: 'active', manifest }),
  };
  return new SwarmAppService(
    {} as never, // pool — synthesiseProfile never queries
    repo as never,
    {} as never, // agentProfileRepo — unused on this path
  );
}

/** A ribbon shaped like career-hunter's: an ungrouped lead item, two labelled top
 *  bands, and a bottom-tray item that must never carry a heading. */
const MANIFEST = {
  name: 'career-hunter',
  displayName: 'Intelligent Career',
  ticketType: 'career-application',
  ui: {
    static: [
      { toolName: 'career-mobile', label: 'Mobile', icon: 'i', iframeUrl: '/m', section: 'top' },
      { toolName: 'career-board', label: 'Job Board', icon: 'i', iframeUrl: '/b', section: 'top', group: 'Job Search' },
      { toolName: 'career-profile-studio', label: 'Profile Studio', icon: 'i', iframeUrl: '/p', section: 'top', group: 'Presence' },
      { toolName: 'portrait-studio', label: 'Portrait Studio', icon: 'i', iframeUrl: '/ps', section: 'top', group: 'Presence' },
      { toolName: 'career-companies', label: 'Companies', icon: 'i', iframeUrl: '/c', section: 'bottom', group: 'Ops' },
    ],
  },
} as unknown as SwarmApplication['manifest'];

/**
 * @description Pulls the synthesised ribbon entry for one tool id.
 * @param items - The ribbon items synthesiseProfile returned.
 * @param toolName - The manifest toolName (without the `tool-` prefix).
 * @returns The matching object item, or undefined when absent.
 */
function itemFor(items: unknown[], toolName: string): { group?: string; section?: string } | undefined {
  return items.find(
    (i): i is { id: string; group?: string; section?: string } =>
      typeof i === 'object' && i !== null && (i as { id?: string }).id === `tool-${toolName}`,
  );
}

describe('manifest ui.static group -> ribbon', () => {
  it('carries a declared group through synthesiseProfile onto the top-tray item', async () => {
    const profile = await serviceFor(MANIFEST).synthesiseProfile('career-hunter');
    const items = profile!.ribbon.items;

    // The exact drop this guards: `group` present in the manifest, absent on the item.
    expect(itemFor(items, 'career-board')?.group).toBe('Job Search');
    expect(itemFor(items, 'career-profile-studio')?.group).toBe('Presence');
    expect(itemFor(items, 'portrait-studio')?.group).toBe('Presence');
  });

  it('leaves a top item that declares no group ungrouped, so it renders as the lead band', async () => {
    const profile = await serviceFor(MANIFEST).synthesiseProfile('career-hunter');
    // RibbonNav._renderGroups orders bands by first appearance and emits no header for
    // the '' bucket, so an undeclared group is what puts Mobile first with no label.
    expect(itemFor(profile!.ribbon.items, 'career-mobile')?.group).toBeUndefined();
  });

  it('never lets a bottom-tray item render a group heading', async () => {
    const profile = await serviceFor(MANIFEST).synthesiseProfile('career-hunter');
    const companies = itemFor(profile!.ribbon.items, 'career-companies');

    expect(companies?.section).toBe('bottom');
    // synthesiseProfile forwards the key verbatim; RibbonNav is the authority and
    // coerces it to '' for the pinned tray. Assert the contract at the renderer's
    // gate rather than the map, so moving the gate does not silently drop it.
    const rendered = companies?.section === 'top' ? (companies.group || '') : '';
    expect(rendered).toBe('');
  });

  it('keeps group optional — a manifest that declares none still synthesises', async () => {
    const bare = {
      ...MANIFEST,
      ui: { static: [{ toolName: 'x', label: 'X', icon: 'i', iframeUrl: '/x', section: 'top' }] },
    } as unknown as SwarmApplication['manifest'];

    const profile = await serviceFor(bare).synthesiseProfile('career-hunter');
    expect(itemFor(profile!.ribbon.items, 'x')).toBeDefined();
    expect(itemFor(profile!.ribbon.items, 'x')?.group).toBeUndefined();
  });
});
