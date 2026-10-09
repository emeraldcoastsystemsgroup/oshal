/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the iframe sandbox that hosts app surfaces: without allow-downloads a surface's download is discarded silently, which is what broke the one-click node installer after the route had already rendered and issued the file.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The platform's own pages are framed without a sandbox; package surfaces keep theirs. Every case now drives the REAL CockpitViewController through switchView (the shell's entry point) or its exported surface rule, instead of reading sandbox="..." literals out of the source: /users, /access, /app-loader, /swarm-admin, /config, /cockpit/tools/ and the Bot Forge frame render with no sandbox attribute (allow-scripts with allow-same-origin isolated nothing there and made Chrome warn on every load); a package surface, a look-alike path, a cross-origin URL and a dot-segment walk out of /cockpit/tools/ keep the exact previous allow-list; the assistant bubble keeps its narrower list; and the original two guards (downloads permitted, no blanket top navigation) hold for both lists.
 */

/**
 * Guards for the cockpit's surface iframe sandbox.
 *
 * The sandbox is a security boundary for package-authored surfaces, so its allow-list stays
 * deliberately narrow. For the platform's own same-origin pages it was no boundary at all: a frame
 * holding both allow-scripts and allow-same-origin can reach its parent and lift its own sandbox.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';

/** The package allow-list exactly as it shipped before this change: it must not move. */
const PACKAGE_ALLOW_LIST = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-top-navigation-by-user-activation';
/** The assistant bubble's allow-list exactly as it shipped before this change. */
const ASSISTANT_ALLOW_LIST = 'allow-scripts allow-same-origin allow-forms';
const ORIGIN = 'http://127.0.0.1:38788';

type FakeFrame = { title: string; attributes: Record<string, string>; setAttribute(name: string, value: string): void };
type ControllerModule = {
  CockpitViewController: new (options: Record<string, unknown>) => { switchView(viewId: string): Promise<void> };
  PACKAGE_SURFACE_SANDBOX: string;
  ASSISTANT_SURFACE_SANDBOX: string;
  surfaceSandbox(url: string, allowances?: string): string;
  createAssistantFrame(assistant: { label: string; iframeUrl: string; title?: string }): FakeFrame;
};

let container: { innerHTML: string; querySelector: (selector: string) => unknown };

/** The shell's render target and the browser surface the controller's module graph reads. */
function stubBrowser(): void {
  container = { innerHTML: '', querySelector: () => ({ src: '', isConnected: false, addEventListener: () => {} }) };
  vi.stubGlobal('window', {
    location: { origin: ORIGIN, href: `${ORIGIN}/cockpit/today`, search: '' },
    addEventListener: () => {}, removeEventListener: () => {},
  });
  vi.stubGlobal('document', {
    addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [],
    getElementById: (id: string) => (id === 'mainContent' ? container : null),
    createElement: (): FakeFrame => ({
      title: '', attributes: {}, setAttribute(name: string, value: string) { this.attributes[name] = value; },
    }),
    body: { appendChild() {} },
  });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
}

/** @description The real controller module. @returns its exports. */
const load = async (): Promise<ControllerModule> =>
  await import('@/pages/cockpit/js/cockpit-view-controller.js' as string) as ControllerModule;

/**
 * @description Render one view through the real controller and return its iframe tag.
 * @param viewId the view switchView is asked for.
 * @param iframeUrl the tool view's surface URL (unused for built-in views such as `forge`).
 * @returns the rendered `<iframe ...>` start tag.
 */
async function renderedFrame(viewId: string, iframeUrl = ''): Promise<string> {
  const module = await load();
  const views = [{ id: viewId, label: 'Under test', icon: 'codicon codicon-extensions', toolUi: { iframeUrl } }];
  const controller = new module.CockpitViewController({ workspaceFocus: { exit: () => {} }, getRibbon: () => ({ views }) });
  await controller.switchView(viewId);
  const frame = /<iframe [^>]*>/.exec(container.innerHTML)?.[0];
  expect(frame, container.innerHTML).toBeTruthy();
  return frame as string;
}

beforeEach(() => stubBrowser());
afterEach(() => vi.unstubAllGlobals());

describe('a package-authored surface keeps exactly the sandbox it had', () => {
  it('frames a package surface with the unchanged allow-list', async () => {
    const { PACKAGE_SURFACE_SANDBOX } = await load();
    expect(PACKAGE_SURFACE_SANDBOX).toBe(PACKAGE_ALLOW_LIST);
    expect(await renderedFrame('tool-studio-app', '/api/studio/app')).toContain(`sandbox="${PACKAGE_ALLOW_LIST}"`);
  });

  it('keeps the sandbox for look-alike paths, other origins and dot-segment walks out of a first-party root', async () => {
    for (const url of [
      '/users-export/app', '/api/users/app', '/apps/users', '/accessibility/ui', '/configure', '/api/forge-pack/ui',
      '/cockpit/toolsx/a.html', '/cockpit/tool', 'https://evil.example/users', '//evil.example/cockpit/tools/a.html',
      '/cockpit/tools/../../api/studio/app', '/cockpit/tools/%2e%2e/%2e%2e/api/studio/app',
    ]) {
      stubBrowser();
      expect(await renderedFrame('tool-studio-app', url), url).toContain(`sandbox="${PACKAGE_ALLOW_LIST}"`);
    }
  });

  it('permits downloads, or a surface cannot hand the user a file', async () => {
    // The defect behind entry 1: allow-popups was present and allow-downloads was not. The popup
    // opened, the browser discarded the download, and nothing on either side reported a failure.
    const { PACKAGE_SURFACE_SANDBOX } = await load();
    expect(PACKAGE_SURFACE_SANDBOX.split(' ')).toContain('allow-downloads');
  });

  it('still keeps the boundary narrow — no blanket escape on either allow-list', async () => {
    const { PACKAGE_SURFACE_SANDBOX, ASSISTANT_SURFACE_SANDBOX } = await load();
    for (const list of [PACKAGE_SURFACE_SANDBOX, ASSISTANT_SURFACE_SANDBOX]) {
      expect(list.split(' ')).not.toContain('allow-top-navigation');
      expect(list.split(' ')).not.toContain('allow-top-navigation-to-custom-protocols');
    }
  });
});

describe('the platform\'s own pages are framed without a sandbox', () => {
  it('renders /users, /access, /app-loader, /swarm-admin, /config and /cockpit/tools/ pages with no sandbox attribute', async () => {
    for (const url of [
      '/users', '/users/', '/access', '/app-loader', '/swarm-admin/', '/config', '/config/?tab=models',
      '/cockpit/tools/budgets.html', `${ORIGIN}/cockpit/tools/dlq.html`,
    ]) {
      stubBrowser();
      const frame = await renderedFrame('tool-platform-page', url);
      expect(frame, url).not.toContain('sandbox');
      expect(frame, url).toContain('src="');
    }
  });

  it('renders the Bot Forge front door with no sandbox attribute', async () => {
    const frame = await renderedFrame('forge');
    expect(frame).toContain('src="/api/forge"');
    expect(frame).not.toContain('sandbox');
  });

  it('still leaves the Jarvis voice surface unsandboxed (getUserMedia is refused in any sandboxed frame)', async () => {
    expect(await renderedFrame('tool-jarvis', '/api/jarvis/')).not.toContain('sandbox');
  });

  it('frames every cockpit iframe through the one rule, never with a hand-written sandbox', async () => {
    const source = await fs.readFile('src/pages/cockpit/js/cockpit-view-controller.js', 'utf8');
    const frames = [...source.matchAll(/<iframe [^>]*>/g)].map((m) => m[0]);
    expect(frames.length).toBe(2);
    for (const frame of frames) {
      expect(frame).toMatch(/\$\{sandboxAttr(ibute\([^)]*\))?\}/);
      expect(frame).not.toContain('sandbox="');
    }
  });
});

describe('an app\'s assistant bubble', () => {
  it('keeps its narrower allow-list for a package surface, and none for a platform page', async () => {
    const { createAssistantFrame, ASSISTANT_SURFACE_SANDBOX } = await load();
    expect(ASSISTANT_SURFACE_SANDBOX).toBe(ASSISTANT_ALLOW_LIST);
    const tutor = createAssistantFrame({ label: 'Tutor', iframeUrl: '/api/little-monsters/tutor' });
    expect(tutor.title).toBe('Tutor');
    expect(tutor.attributes).toEqual({ sandbox: ASSISTANT_ALLOW_LIST });
    const platform = createAssistantFrame({ label: 'Help', title: 'Platform help', iframeUrl: '/cockpit/tools/platform.html' });
    expect(platform.title).toBe('Platform help');
    expect(platform.attributes).toEqual({});
  });

  it('is built by app.js through that rule, not with a sandbox of its own', async () => {
    // app.js constructs the whole cockpit on import, so its wiring is read rather than executed.
    const app = await fs.readFile('src/pages/cockpit/js/app.js', 'utf8');
    const body = app.slice(app.indexOf('  renderAppAssistant(assistant) {'), app.indexOf('\n  }\n', app.indexOf('  renderAppAssistant(assistant) {')));
    expect(body).toContain('const frame = createAssistantFrame(assistant);');
    expect(body).not.toContain("setAttribute('sandbox'");
    expect(app).toContain("import { CockpitViewController, createAssistantFrame } from './cockpit-view-controller.js';");
  });
});
