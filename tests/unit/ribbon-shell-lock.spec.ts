/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The ribbon's shell-lock decision: locked only for a non-operator whose deployment names a landing application; the hub is withheld when locked; the header's Experiences entries carry the attribute the lock hides them by.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeBottomTray, PLATFORM_HUB_ID, resolveShellLock } from '@/pages/cockpit/js/components/RibbonNav.js';

describe('resolveShellLock', () => {
  it('locks only a non-operator on a deployment with a landing application', () => {
    expect(resolveShellLock({ isOperator: false, landingApp: 'intelligent-sales' })).toBe(true);
    expect(resolveShellLock({ isOperator: true, landingApp: 'intelligent-sales' })).toBe(false);
    expect(resolveShellLock({ isOperator: false, landingApp: null })).toBe(false);
    expect(resolveShellLock({ isOperator: false, landingApp: '' })).toBe(false);
    expect(resolveShellLock({ isOperator: false })).toBe(false);
  });

  it('a locked rail keeps the app\'s own bottom tiles and has no platform hub to append', () => {
    const views = [{ id: 'sales-import', section: 'bottom' }, { id: PLATFORM_HUB_ID, section: 'bottom' }, { id: 'settings', section: 'bottom' }];
    // Locked: the hub is never appended, so the tray is the app's own items only.
    expect(computeBottomTray(views.filter(v => v.id !== PLATFORM_HUB_ID), { hidePlatformChrome: true }).map(v => v.id)).toEqual(['sales-import']);
    // Unlocked focused app: the hub is the one door and sits last.
    expect(computeBottomTray(views, { hidePlatformChrome: true }).map(v => v.id)).toEqual(['sales-import', PLATFORM_HUB_ID]);
  });

  it('the cockpit header marks every Experiences entry and its label so the lock can hide them', () => {
    const html = readFileSync(resolve(process.cwd(), 'src/pages/cockpit/index.html'), 'utf8');
    expect(html).toMatch(/data-experiences-label/);
    const entries = html.match(/data-experience="[^"]+"/g) || [];
    expect(entries.length).toBeGreaterThanOrEqual(8);
    const source = readFileSync(resolve(process.cwd(), 'src/pages/cockpit/js/components/RibbonNav.js'), 'utf8');
    expect(source).toMatch(/\[data-experience\], \[data-experiences-label\]/);
    expect(source).toMatch(/if \(this\.hidePlatformChrome && !this\.shellLocked\) this\._appendPlatformHub\(\);/);
  });
});
