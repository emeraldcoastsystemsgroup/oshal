/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard manifest-driven chat and global-assistant suppression across profile synthesis and browser script load order.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pin disabled-chat boot behavior so immersive apps cannot create an invisible background task.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Cache-version pin advanced v25 → v26 (service-worker bump for the index.html auth-lapse guard now carrying ?returnTo through relogin).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Cache-version pin advanced v26 → v27 to match the current cockpit service worker after the mobile drawer cache bump.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Cache-version pin advanced v27 → v28 so the guard matches the current cockpit service worker after the latest shell-cache bump.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | hideStatusBar rides the same forwarding + omission assertions as hideChatPanel/hideAssistant, and a source pin holds app.js to applyStatusBarPolicy + the data-oshal-status-bar-hidden attribute.
 */

/**
 * Manifest-driven immersive cockpit chrome.
 *
 * Pins both server and browser seams: ribbon.hideAssistant must survive profile
 * synthesis, and the global Jarvis/DEV orb must honor the policy whether the
 * profile or the orb script resolves first.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';
import { describe, expect, it, vi } from 'vitest';
import { SwarmAppService } from '../../src/features/swarm-apps';
import type { SwarmApplicationRecord } from '../../src/features/swarm-apps';

function serviceWithRibbon(ribbon: { hideChatPanel?: boolean; hideAssistant?: boolean; hideStatusBar?: boolean }) {
  const record = {
    appId: 'immersive',
    name: 'immersive',
    displayName: 'Immersive',
    description: '',
    version: '1.0.0',
    status: 'active',
    manifestPath: '/tmp/immersive/oshal-app.yaml',
    agentIds: [],
    toolNames: [],
    manifest: { name: 'immersive', displayName: 'Immersive', ribbon },
    scope: 'public',
    ownerSub: null,
    tenantId: null,
    guestTierApproved: null,
    loadedAt: new Date(),
    updatedAt: new Date(),
  } as SwarmApplicationRecord;
  const repo = { findByName: vi.fn(async () => record) };
  return new SwarmAppService({} as never, repo as never, {} as never);
}

describe('ribbon immersive policy', () => {
  it('forwards chat-panel, global-assistant and status-bar suppression into the cockpit profile', async () => {
    const profile = await serviceWithRibbon({ hideChatPanel: true, hideAssistant: true, hideStatusBar: true })
      .synthesiseProfile('immersive');

    expect(profile).toMatchObject({ hideChatPanel: true, hideAssistant: true, hideStatusBar: true });
  });

  it('does not hide any of the three chrome surfaces unless the manifest explicitly requests it', async () => {
    const profile = await serviceWithRibbon({ hideChatPanel: false, hideAssistant: false, hideStatusBar: false })
      .synthesiseProfile('immersive');

    expect(profile?.hideChatPanel).toBeUndefined();
    expect(profile?.hideAssistant).toBeUndefined();
    expect(profile?.hideStatusBar).toBeUndefined();
  });

  it('app.js applies the status-bar policy on the same durable-attribute contract as the assistant', () => {
    const app = readFileSync(new URL('../../src/pages/cockpit/js/app.js', import.meta.url), 'utf8');
    expect(app).toContain('applyStatusBarPolicy(profile?.hideStatusBar === true)');
    expect(app).toContain("const STATUS_BAR_HIDDEN_ATTR = 'data-oshal-status-bar-hidden'");
  });
});

describe('global assistant load-order contract', () => {
  const source = readFileSync(resolve('src/pages/cockpit/js/jarvis-orb.js'), 'utf8');

  it('does not create the orb when the durable profile attribute was set first', () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const createElement = vi.fn();
    const document = {
      readyState: 'complete',
      documentElement: { getAttribute: (name: string) => name === 'data-oshal-assistant-hidden' ? 'true' : null },
      getElementById: vi.fn(() => null),
      createElement,
      addEventListener: vi.fn(),
    };
    const window = {
      location: { search: '?app=immersive' },
      addEventListener: (name: string, handler: (event: unknown) => void) => listeners.set(name, handler),
    } as Record<string, unknown>;
    window.top = window;
    window.self = window;

    runInNewContext(source, { window, document, URLSearchParams, fetch: vi.fn() });

    expect(createElement).not.toHaveBeenCalled();
    expect(listeners.has('oshal:assistant-visibility')).toBe(true);
  });

  it('removes an already-booted orb when the profile event arrives later', () => {
    let hidden: string | null = null;
    const listeners = new Map<string, (event: unknown) => void>();
    const fab = { remove: vi.fn() };
    const panel = { remove: vi.fn() };
    const nodes = new Map<string, { remove: () => void }>([
      ['jarvisOrbFab', fab],
      ['jarvisOrbPanel', panel],
    ]);
    const document = {
      readyState: 'loading',
      documentElement: { getAttribute: () => hidden },
      getElementById: (id: string) => nodes.get(id) ?? null,
      addEventListener: vi.fn(),
    };
    const window = {
      location: { search: '?app=immersive' },
      addEventListener: (name: string, handler: (event: unknown) => void) => listeners.set(name, handler),
    } as Record<string, unknown>;
    window.top = window;
    window.self = window;

    runInNewContext(source, { window, document, URLSearchParams, fetch: vi.fn() });
    hidden = 'true';
    listeners.get('oshal:assistant-visibility')?.({ detail: { hidden: true } });

    expect(fab.remove).toHaveBeenCalledOnce();
    expect(panel.remove).toHaveBeenCalledOnce();
  });

  it('keeps app.js on the same durable attribute and event contract', () => {
    const app = readFileSync(resolve('src/pages/cockpit/js/app.js'), 'utf8');
    expect(app).toContain("const ASSISTANT_HIDDEN_ATTR = 'data-oshal-assistant-hidden'");
    expect(app).toContain("const ASSISTANT_VISIBILITY_EVENT = 'oshal:assistant-visibility'");
    expect(app).toContain('applyGlobalAssistantPolicy(profile?.hideAssistant === true)');
  });

  it('does not navigate or restore the embedded chat for an immersive profile', () => {
    const app = readFileSync(resolve('src/pages/cockpit/js/app.js'), 'utf8');
    const controller = readFileSync(resolve('src/pages/cockpit/js/embedded-chat-panel-controller.js'), 'utf8');
    const index = readFileSync(resolve('src/pages/cockpit/index.html'), 'utf8');

    expect(index).toContain('src="about:blank"');
    expect(app).toContain('if (!this.chatDisabled) {\n      await this.chatPanel.restoreSession();');
    expect(app).toContain('this.chatPanel.setEnabled?.(!this.chatDisabled)');
    expect(controller).toContain("if (!this.enabled && frame?.getAttribute('src') !== 'about:blank')");
    expect(controller).toContain('if (!this.enabled) return;');
  });

  it('cache-busts both changed cockpit scripts for installed PWAs', () => {
    const index = readFileSync(resolve('src/pages/cockpit/index.html'), 'utf8');
    const worker = readFileSync(resolve('src/pages/cockpit/service-worker.js'), 'utf8');
    expect(index).toContain('js/jarvis-orb.js?v=4');
    expect(worker).toContain("const CACHE_VERSION = 'oshal-cockpit-v34'");
  });

  it('serves cockpit code fresh instead of one deploy behind', () => {
    const worker = readFileSync(resolve('src/pages/cockpit/service-worker.js'), 'utf8');

    // Cockpit JS/CSS used to fall through to the stale-while-revalidate branch, which returns
    // `cached || network`: the user got the PREVIOUS build and the new one was merely warmed for
    // next time. Every deploy therefore needed two page loads to become visible, so a correct
    // deploy was indistinguishable from a failed one from the user's seat.
    expect(worker).toMatch(/alwaysFresh\s*=[\s\S]{0,240}startsWith\('\/cockpit\/'\)/);

    // Navigations must NOT be swallowed here — their own branch redirects a lapsed session to
    // /login rather than serving a cached shell that cannot load its own gated assets.
    expect(worker).toMatch(/alwaysFresh\s*=[\s\S]{0,240}request\.mode\s*!==\s*'navigate'/);

    // The always-fresh branch must actually bypass the HTTP cache. Without `cache: 'reload'` the
    // SW's own fetch can be answered from a stale browser-cached copy and then written into the
    // new version's cache — a bump that evicts the old cache and immediately refills it with the
    // same stale bytes.
    expect(worker).toMatch(/if \(alwaysFresh\) \{[\s\S]{0,200}cache:\s*'reload'/);

    // Offline must still work: the fresh fetch falls back to whatever was cached.
    expect(worker).toMatch(/if \(alwaysFresh\) \{[\s\S]{0,900}catch\(\(\) => caches\.match\(request\)\)/);
  });

  it('expands the assistant panel without re-opening the mobile viewport fix', () => {
    const orb = readFileSync(resolve('src/pages/cockpit/js/jarvis-orb.js'), 'utf8');

    // The expanded state pins its geometry with the safe-area insets, exactly as the phone rule
    // does. A future "just make it bigger" edit that reaches for 100vw/100vh instead would slide
    // the chat input under a phone's URL bar again — the bug change-log entry 2 exists to fix.
    expect(orb).toContain('#jarvisOrbPanel.wide');
    expect(orb).toMatch(/#jarvisOrbPanel\.wide[\s\S]{0,400}env\(safe-area-inset-top/);
    expect(orb).not.toMatch(/#jarvisOrbPanel\.wide[\s\S]{0,400}height:\s*100vh/);

    // The docked panel must keep its dynamic-viewport height.
    expect(orb).toContain('100dvh');

    // Expand is delegated from the panel click handler and toggles aria-pressed, so the control
    // reports its own state to a screen reader rather than being a mystery glyph.
    expect(orb).toContain("e.target.id === 'jarvisOrbExpand'");
    expect(orb).toContain("setAttribute('aria-pressed'");
  });
});
