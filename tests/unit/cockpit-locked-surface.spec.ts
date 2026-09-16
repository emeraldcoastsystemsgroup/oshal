/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-149 locked surface — the CONTENT-AREA half. Locking the rail button covered a click on the tile and nothing else: the landing defaultView, an embedded surface's app-navigate and a handoff all reach switchView, which iframed the tile's surface without looking at `locked` — so a launcher whose default tile belongs to a package this person cannot discover opened straight onto the kernel's role-guidance 403 inside the frame. These cases drive the REAL CockpitViewController through switchView (the shell's own entry point) and assert the choke point: a locked view renders the lock panel with the role-guidance link and NO iframe, the same view without the lock still renders its iframe exactly as before, a guidance link that is not same-origin root-relative is dropped (the rule is stated once, in ribbonTilePresentation), a package name carrying markup is escaped, and an unregistered view still falls through to the existing "no viewer URL" panel.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type View = { id: string; label: string; icon: string; toolUi: { iframeUrl: string; sidebarLabel?: string }; locked?: { app: string; reason: string; roleGuidanceUrl: string } };

const STUDIO: View = { id: 'tool-studio-app', label: 'Studio', icon: 'codicon codicon-paintcan', toolUi: { iframeUrl: '/api/studio/app', sidebarLabel: 'Studio' } };
const lockedWith = (roleGuidanceUrl: string, app = 'studio'): View => ({ ...STUDIO, locked: { app, reason: 'application-role-required', roleGuidanceUrl } });

let container: { innerHTML: string; querySelector: (selector: string) => unknown };

/** The shell's own render target and the browser surface the controller's module graph reads. */
function stubBrowser() {
  container = { innerHTML: '', querySelector: () => ({ src: '', isConnected: false, addEventListener: () => {} }) };
  vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1', href: 'http://127.0.0.1/cockpit/', search: '' }, addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal('document', {
    addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [],
    getElementById: (id: string) => (id === 'mainContent' ? container : null),
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }), body: { appendChild() {} },
  });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
}

/** The real controller, wired to a ribbon holding exactly the views under test. */
async function shell(views: View[]) {
  const module = await import('@/pages/cockpit/js/cockpit-view-controller.js' as string) as {
    CockpitViewController: new (options: Record<string, unknown>) => { switchView(viewId: string): Promise<void> };
    lockedSurfacePanel(view: unknown): string | null;
  };
  const controller = new module.CockpitViewController({
    workspaceFocus: { exit: () => {} },
    getRibbon: () => ({ views }),
  });
  return { controller, lockedSurfacePanel: module.lockedSurfacePanel };
}

beforeEach(() => stubBrowser());
afterEach(() => vi.unstubAllGlobals());

describe('ADR-149 — the cockpit content area refuses a locked surface, on every path into it', () => {
  it('renders the lock panel with the role-guidance link instead of the dead frame', async () => {
    const { controller } = await shell([lockedWith('/users')]);
    await controller.switchView('tool-studio-app');
    expect(container.innerHTML).not.toContain('<iframe');
    expect(container.innerHTML).not.toContain('/api/studio/app');
    expect(container.innerHTML).toContain('locked-surface');
    expect(container.innerHTML).toContain('codicon codicon-lock');
    expect(container.innerHTML).toContain('<strong>studio</strong>');
    expect(container.innerHTML).toContain('href="/users"');
    expect(container.innerHTML).toContain('Studio');
  });

  it('still renders the iframe for the same view once the lock is gone', async () => {
    const { controller } = await shell([STUDIO]);
    await controller.switchView('tool-studio-app');
    expect(container.innerHTML).toContain('<iframe');
    expect(container.innerHTML).toContain('/api/studio/app');
    expect(container.innerHTML).not.toContain('locked-surface');
  });

  it('drops a guidance link that is not same-origin root-relative, and still never frames the surface', async () => {
    for (const url of ['https://evil.example/users', '//evil.example', 'javascript:alert(1)', '/users" onclick="x', '']) {
      stubBrowser();
      const { controller } = await shell([lockedWith(url)]);
      await controller.switchView('tool-studio-app');
      expect(container.innerHTML, url).not.toContain('<iframe');
      expect(container.innerHTML, url).toContain('locked-surface');
      expect(container.innerHTML, url).not.toContain('href=');
      expect(container.innerHTML, url).toContain('Ask an administrator');
    }
  });

  it('escapes the package name it names in the panel', async () => {
    const { controller } = await shell([lockedWith('/access', '<img src=x onerror=alert(1)>')]);
    await controller.switchView('tool-studio-app');
    expect(container.innerHTML).not.toContain('<img');
    expect(container.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(container.innerHTML).toContain('href="/access"');
  });

  it('leaves every unlocked shape exactly as it was: a plain view, an unregistered view, a view with no surface', async () => {
    const { controller, lockedSurfacePanel } = await shell([{ ...STUDIO, toolUi: { iframeUrl: '' } }]);
    expect(lockedSurfacePanel(undefined)).toBeNull();
    expect(lockedSurfacePanel(STUDIO)).toBeNull();
    await controller.switchView('tool-nothing-registered');
    expect(container.innerHTML).toContain('No viewer URL configured');
    expect(container.innerHTML).not.toContain('locked-surface');
    await controller.switchView('tool-studio-app');
    expect(container.innerHTML).toContain('No viewer URL configured');
    expect(container.innerHTML).not.toContain('locked-surface');
  });
});
