/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-149 locked rail tile — the renderer half. The kernel marks a synthesised item `locked` when its target package is not discoverable for this person; these cases run the REAL RibbonNav module: the profile item's lock is forwarded into the view, the button renders in the existing guest-disabled treatment (lock glyph, dimmed, kept in place) with the role-guidance link on it and no aria-disabled, a plain item renders exactly as before, a guest Tier-C block still wins, and only a same-origin root-relative guidance link is ever written into the markup.
 */

import { describe, expect, it } from 'vitest';
import { RibbonNav, ribbonTilePresentation } from '@/pages/cockpit/js/components/RibbonNav.js';

const lock = { app: 'studio', reason: 'application-role-required', roleGuidanceUrl: '/users' };
const plain = { id: 'tool-studio-app', label: 'Studio', icon: 'codicon codicon-paintcan', section: 'top', toolUi: { iframeUrl: '/api/studio/app', sidebarLabel: 'Studio' } };
const locked = { ...plain, locked: lock };

/** The real renderer method, bound to the two instance members it reads. */
function button(view: object, guestBlocked = false): string {
  return (RibbonNav.prototype as unknown as { _btn(view: object): string })._btn
    .call({ activeView: null, _isGuestBlocked: () => guestBlocked }, view);
}

/** The real profile -> view mapping, bound to the profile it reads. */
function views(items: unknown[]): Array<{ id: string; locked?: unknown }> {
  return (RibbonNav.prototype as unknown as { _buildFrameworkViews(): Array<{ id: string; locked?: unknown }> })._buildFrameworkViews
    .call({ profile: { ribbon: { items } } });
}

describe('ribbonTilePresentation — the pure decision', () => {
  it('renders a locked tile in the guest-disabled treatment with the role-guidance link', () => {
    expect(ribbonTilePresentation(locked, false)).toEqual({
      blocked: true, locked: true, icon: 'codicon codicon-lock', roleGuidanceUrl: '/users',
      title: 'Studio — application role required (opens access guidance)',
    });
  });

  it('leaves a plain tile exactly as before', () => {
    expect(ribbonTilePresentation(plain, false)).toEqual({ blocked: false, locked: false, icon: 'codicon codicon-paintcan', roleGuidanceUrl: null, title: 'Studio' });
  });

  it('a guest Tier-C block still wins and carries no link', () => {
    expect(ribbonTilePresentation(locked, true)).toMatchObject({ blocked: true, locked: false, roleGuidanceUrl: null, title: 'Studio — not available in guest mode' });
  });

  it('honours only a same-origin root-relative guidance link; anything else stays locked without one', () => {
    for (const url of ['https://evil.example/users', '//evil.example', '/users" onclick="x', 'javascript:alert(1)', '']) {
      expect(ribbonTilePresentation({ ...plain, locked: { ...lock, roleGuidanceUrl: url } }, false), url)
        .toMatchObject({ blocked: true, locked: true, roleGuidanceUrl: null, title: 'Studio — application role required' });
    }
    expect(ribbonTilePresentation({ ...plain, locked: { ...lock, roleGuidanceUrl: '/access' } }, false).roleGuidanceUrl).toBe('/access');
  });
});

describe('RibbonNav — the lock reaches the markup', () => {
  it('forwards a profile item\'s lock into the view, and null when absent', () => {
    const built = views([locked, plain, 'tickets']);
    expect(built.find(v => v.id === 'tool-studio-app' && v.locked)?.locked).toEqual(lock);
    expect(built.filter(v => v.id === 'tool-studio-app')[1].locked).toBeNull();
  });

  it('renders a locked button dimmed, with the lock glyph, kept in place, carrying the link and still a live control', () => {
    const html = button(locked);
    expect(html).toContain('class="ribbon-btn guest-disabled tile-locked"');
    expect(html).toContain('data-view="tool-studio-app"');
    expect(html).toContain('data-role-guidance="/users"');
    expect(html).toContain('codicon codicon-lock');
    expect(html).toContain('opacity:.35;');
    expect(html).not.toContain('aria-disabled');
    expect(html).not.toContain('cursor:not-allowed');
    expect(html).toContain('title="Studio — application role required (opens access guidance)"');
  });

  it('renders a plain button exactly as before, and a guest block without any link', () => {
    const html = button(plain);
    expect(html).toContain('class="ribbon-btn"');
    expect(html).not.toContain('guest-disabled'); expect(html).not.toContain('data-role-guidance'); expect(html).toContain('codicon codicon-paintcan');
    const guest = button(locked, true);
    expect(guest).toContain('guest-disabled'); expect(guest).toContain('aria-disabled="true"'); expect(guest).not.toContain('data-role-guidance');
  });
});
