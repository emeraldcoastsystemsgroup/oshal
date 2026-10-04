/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | The ribbon's shell-lock decision: locked only for a non-operator whose deployment names a landing application; the hub is withheld when locked; the header's Experiences entries carry the attribute the lock hides them by.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Verify the hidden discovery menu, generated lock markers and refusal to load experiences in a locked shell.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Match the actual legacy static entry URLs and prove reintroduced entries are refused.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | The retired-entry matcher is quote-agnostic and href-based (a single-quoted data-experience, or an entry with no data-experience attribute at all, used to pass), and its self-test exercises the very regex asserted on index.html. A refusal locks every non-operator. The header doors are drawn closed in index.html, and the door helpers close and open them by behaviour, not by source text.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeBottomTray, PLATFORM_HUB_ID, resolveShellLock } from '@/pages/cockpit/js/components/RibbonNav.js';
import { closeShellDoors, openShellDoors } from '@/pages/cockpit/js/cockpit-shell-doors.js';

const RETIRED = '(?:portal|studio|jarvis|orbit|commons|homebase|little-monsters)';
/** A retired experience destination, whether it is named by data-experience or by href, in any quoting. */
const retiredExperienceEntry = new RegExp(`(?:data-experience|href)\\s*=\\s*["']?\\/${RETIRED}(?=[/?"'#\\s>]|$)`, 'i');
const html = () => readFileSync(resolve(process.cwd(), 'src/pages/cockpit/index.html'), 'utf8');
/** The opening tag of the element with this id. */
const tagOf = (source: string, id: string) => source.match(new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? '';

describe('resolveShellLock', () => {
  it('locks only a non-operator on a deployment with a landing application', () => {
    expect(resolveShellLock({ isOperator: false, landingApp: 'intelligent-sales' })).toBe(true);
    expect(resolveShellLock({ isOperator: true, landingApp: 'intelligent-sales' })).toBe(false);
    expect(resolveShellLock({ isOperator: false, landingApp: null })).toBe(false);
    expect(resolveShellLock({ isOperator: false, landingApp: '' })).toBe(false);
    expect(resolveShellLock({ isOperator: false })).toBe(false);
  });

  it('a refused or unreadable profile locks every non-operator, focused deployment or not', () => {
    expect(resolveShellLock({ isOperator: false, landingApp: null, refused: true })).toBe(true);
    expect(resolveShellLock({ isOperator: false, refused: true })).toBe(true);
    expect(resolveShellLock({ isOperator: true, landingApp: 'intelligent-sales', refused: true })).toBe(false);
  });

  it('a locked rail keeps the app\'s own bottom tiles and has no platform hub to append', () => {
    const views = [{ id: 'sales-import', section: 'bottom' }, { id: PLATFORM_HUB_ID, section: 'bottom' }, { id: 'settings', section: 'bottom' }];
    // Locked: the hub is never appended, so the tray is the app's own items only.
    const ids = (tray: object[]) => tray.map(v => (v as { id: string }).id);
    expect(ids(computeBottomTray(views.filter(v => v.id !== PLATFORM_HUB_ID), { studentMode: false, hidePlatformChrome: true }))).toEqual(['sales-import']);
    // Unlocked focused app: the hub is the one door and sits last.
    expect(ids(computeBottomTray(views, { studentMode: false, hidePlatformChrome: true }))).toEqual(['sales-import', PLATFORM_HUB_ID]);
  });
});

describe('the cockpit header', () => {
  it('carries no retired experience entry and exactly the two current ones', () => {
    const source = html();
    expect(source).toMatch(/id="experience-menu"[^>]*hidden/);
    expect(source).not.toMatch(retiredExperienceEntry);
    expect(source.match(/data-experience="\/(?:nexus|simple)"/g)).toHaveLength(2);
  });

  it('draws every operator door closed until the ribbon opens it', () => {
    const source = html();
    const logo = tagOf(source, 'cockpitHomeLink');
    expect(logo).toContain('data-shell-door="home"');
    expect(logo).toContain('data-door-href="/cockpit/"');
    expect(logo).not.toMatch(/\shref=/);
    for (const id of ['ragBtn', 'portalSettingsBtn']) expect(tagOf(source, id), id).toMatch(/\sdata-shell-door(?:\s[^>]*)?\shidden[\s>]/);
    const entries = source.match(/<a [^>]*data-experience="\/(?:nexus|simple)"[^>]*>/g) ?? [];
    expect(entries).toHaveLength(2);
    for (const entry of entries) expect(entry).toMatch(/\sdata-shell-door(?:\s[^>]*)?\shidden\s/);
    const css = readFileSync(resolve(process.cwd(), 'src/pages/cockpit/css/layout.css'), 'utf8');
    expect(css).toContain('[data-shell-door][hidden] { display: none !important; }');
  });

  it.each([
    `<a data-experience="/studio">Studio</a>`, `<a data-experience='/studio'>Studio</a>`, `<a data-experience=/studio>Studio</a>`,
    `<a href="/studio" class="header-btn">Studio</a>`, `<a href='/portal'>All</a>`, `<a href="/homebase?preset=family">Home</a>`,
    `<a href="/little-monsters/">Classroom</a>`, `<a class="header-btn" href="/jarvis#top">Jarvis</a>`, `<a href="/Orbit">Orbit</a>`,
  ])('the asserted matcher refuses a reintroduced entry: %s', (entry) => {
    expect(entry).toMatch(retiredExperienceEntry);
  });

  it.each([`<a href="/nexus" data-experience="/nexus">`, `<a href="/simple">`, `<a href="/cockpit/">`, `<a href="/portal-help">`, `<a href="/api/ui/experiences/studio-experience/open">`])(
    'the asserted matcher leaves a current destination alone: %s', (entry) => {
      expect(entry).not.toMatch(retiredExperienceEntry);
    });
});

/** A minimal element: attributes, a dataset view over data-*, and the hidden flag. */
function element(attributes: Record<string, string>, hidden = false) {
  const attrs = new Map(Object.entries(attributes));
  const dataset: Record<string, string> = {};
  for (const [name, value] of attrs) if (name.startsWith('data-')) dataset[name.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = value;
  return { hidden, dataset, getAttribute: (name: string) => attrs.get(name) ?? null, setAttribute: (name: string, value: string) => { attrs.set(name, value); },
    removeAttribute: (name: string) => { attrs.delete(name); }, has: (name: string) => attrs.has(name) };
}

/** The header as index.html draws it: every door closed. */
function header() {
  const logo = element({ 'data-shell-door': 'home', 'data-door-href': '/cockpit/' });
  const doors = [element({ 'data-shell-door': '' }, true), element({ 'data-shell-door': '' }, true)];
  const entries = [element({ 'data-experience': 'home-experience' }), element({ 'data-experiences-label': '' })];
  const root = { querySelectorAll: (selector: string) => (selector === '[data-shell-door]' ? [logo, ...doors] : selector === '[data-experience], [data-experiences-label]' ? entries : []) };
  return { root, logo, doors, entries };
}

describe('the door helpers', () => {
  it('a locked verdict keeps every door closed and points the logo at the landing, or nowhere without one', () => {
    const { root, logo, doors, entries } = header();
    closeShellDoors('intelligent-sales', 'Synthetic Sales', root as never);
    expect(logo.getAttribute('href')).toBe('/cockpit/?app=intelligent-sales');
    expect(logo.getAttribute('aria-label')).toBe('Synthetic Sales — home');
    expect(doors.every(door => door.hidden)).toBe(true);
    expect(entries.every(entry => entry.hidden)).toBe(true);
    const bare = header();
    closeShellDoors(null, undefined, bare.root as never);
    expect(bare.logo.has('href')).toBe(false);
  });

  it('an unlocked verdict opens exactly the doors an operator had before', () => {
    const { root, logo, doors } = header();
    openShellDoors(root as never);
    expect(logo.getAttribute('href')).toBe('/cockpit/');
    expect(doors.every(door => !door.hidden)).toBe(true);
  });
});
