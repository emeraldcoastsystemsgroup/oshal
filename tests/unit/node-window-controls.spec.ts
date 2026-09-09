/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the node app's frameless window controls. The operator ended up with the console stacked over the cockpit and could move or close NEITHER: both windows are frame:false, and the cockpit's only drag handle was `header.header-bar` in the SWARM-SERVED page, which `body.zen-mode` sets to display:none — one click on the cockpit's own arrows-out button removed it for good (the state persists in sessionStorage). This spec RUNS the injected control script against a minimal fake DOM (node env, same approach as surface-bridge-relay.spec.ts) rather than string-matching it, because injection failures are swallowed — cockpit-window.ts does executeJavaScript(...).catch(() => undefined), so a syntax error would silently ship a window with no controls at all.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CONTROL_MINIMIZE,
  CONTROL_SHOW_CONSOLE,
  CONTROL_URL_PREFIX,
  SHELL_INTEGRATION_CSS,
  shellControlsJs,
} from '../../packages/oshal-chat/src/main/cockpit-window';

/** The cockpit variant of the pill (Config + minimize + close). */
const SHELL_CONTROLS_JS = shellControlsJs(true);

const SRC = path.join(process.cwd(), 'packages/oshal-chat/src/main');

interface FakeEl {
  id?: string;
  type?: string;
  title?: string;
  textContent?: string;
  style: Record<string, string>;
  children: FakeEl[];
  onclick?: () => void;
  onmouseenter?: () => void;
  onmouseleave?: () => void;
  setAttribute: (k: string, v: string) => void;
  appendChild: (c: FakeEl) => void;
  attrs: Record<string, string>;
}

/** Runs the injected script the way Electron does, over a minimal document/window. */
function runInjection(existing: FakeEl | null = null, script = SHELL_CONTROLS_JS): {
  body: FakeEl; opened: string[]; closes: number[];
} {
  const make = (): FakeEl => {
    const el: FakeEl = {
      style: {}, children: [], attrs: {},
      setAttribute(k, v) { el.attrs[k] = v; },
      appendChild(c) { el.children.push(c); },
    };
    return el;
  };
  const body = make();
  const opened: string[] = [];
  // An array, not a counter: the caller clicks AFTER this returns, so the record has to be
  // something the assertions can still see mutate.
  const closes: number[] = [];
  const document = {
    getElementById: (id: string) => (existing && existing.id === id ? existing : null),
    createElement: () => make(),
    body,
  };
  const windowObj = { open: (u: string) => { opened.push(u); }, close: () => { closes.push(1); } };
  // eslint-disable-next-line no-new-func
  new Function('document', 'window', script)(document, windowObj);
  return { body, opened, closes };
}

describe('@oshal/chat cockpit window — the injected controls actually build', () => {
  it('runs without throwing and appends exactly one control pill', () => {
    // cockpit-window.ts swallows injection errors, so "it parses and runs" is the guard.
    const { body } = runInjection();
    expect(body.children).toHaveLength(1);
    expect(body.children[0].id).toBe('oshal-wincontrols');
  });

  it('makes the pill ITSELF the drag handle, so the window moves with every page chrome hidden', () => {
    // The regression: the drag region lived on the page's own header, and body.zen-mode
    // display:none'd it. A shell-injected handle cannot be removed by page state.
    const pill = runInjection().body.children[0];
    expect(pill.style.WebkitAppRegion).toBe('drag');
    expect(pill.style.position).toBe('fixed');
    expect(SHELL_CONTROLS_JS).not.toContain('header-bar');
  });

  it('offers Config, minimize and close — each clickable rather than part of the drag region', () => {
    const { body, opened, closes } = runInjection();
    const buttons = body.children[0].children;
    expect(buttons).toHaveLength(3);
    for (const b of buttons) expect(b.style.WebkitAppRegion).toBe('no-drag');
    expect(buttons.map((b) => b.title)).toEqual([
      'Show the OSHAL Node console', 'Minimize', 'Close this window',
    ]);
    buttons[0].onclick?.();
    buttons[1].onclick?.();
    buttons[2].onclick?.();
    expect(opened).toEqual([CONTROL_SHOW_CONSOLE, CONTROL_MINIMIZE]);
    expect(closes).toHaveLength(1);
  });

  it('never stacks a second pill when the page navigates and re-injects', () => {
    const present: FakeEl = {
      id: 'oshal-wincontrols', style: {}, children: [], attrs: {},
      setAttribute() {}, appendChild() {},
    };
    expect(runInjection(present).body.children).toHaveLength(0);
  });
});

describe('@oshal/chat cockpit window — wiring the controls need', () => {
  const cockpit = readFileSync(path.join(SRC, 'cockpit-window.ts'), 'utf8');
  const main = readFileSync(path.join(SRC, 'main.ts'), 'utf8');

  it('treats the control URLs as commands and DENIES them, never navigating', () => {
    // They exist so the swarm-served page can reach the main process without being handed a
    // preload; allowing one to navigate would open a window at oshal:console.
    expect(CONTROL_SHOW_CONSOLE.startsWith(CONTROL_URL_PREFIX)).toBe(true);
    expect(CONTROL_MINIMIZE.startsWith(CONTROL_URL_PREFIX)).toBe(true);
    const handler = cockpit.slice(cockpit.indexOf('setWindowOpenHandler'));
    const guarded = handler.slice(0, handler.indexOf("action: 'allow'"));
    expect(guarded).toContain('CONTROL_URL_PREFIX');
    expect(guarded).toContain("action: 'deny'");
  });

  it('keeps the page header draggable with room reserved for the pill', () => {
    expect(SHELL_INTEGRATION_CSS).toMatch(/header\.header-bar \{[^}]*-webkit-app-region: drag/);
    const pad = /header\.header-bar \{[^}]*padding-right: (\d+)px/.exec(SHELL_INTEGRATION_CSS);
    expect(pad, 'header must reserve room or the pill covers its buttons').not.toBeNull();
    expect(Number(pad?.[1])).toBeGreaterThanOrEqual(120);
  });

  it('no longer hides the node console when a cockpit surface opens', () => {
    // The hide/show dance is what made the two windows mutually exclusive while
    // showNodeWindow() could still raise the console back over an open cockpit.
    const hooks = main.slice(main.indexOf('const cockpitHooks'), main.indexOf('const store'));
    expect(hooks).not.toContain('win.hide()');
    expect(hooks).toContain('onShowConsole');
  });

  it('gives the console a title-bar button that raises the cockpit', () => {
    const html = readFileSync(path.join(process.cwd(), 'packages/oshal-chat/src/renderer/index.html'), 'utf8');
    const topbar = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));
    expect(topbar).toContain('id="jarvisTopBtn"');
    const js = readFileSync(path.join(process.cwd(), 'packages/oshal-chat/src/renderer/renderer.js'), 'utf8');
    expect(js).toContain("$('jarvisTopBtn')");
  });
});

describe('@oshal/chat sign-in window — the one that trapped the operator', () => {
  const main = readFileSync(path.join(SRC, 'main.ts'), 'utf8');

  it('gets the control pill too — it is frameless AND modal, so no controls froze the app', () => {
    // parent: win + modal: true means this window blocks input to the console while it is up.
    // Frameless with nothing to click, that reads as "I cannot move or close either window".
    const signIn = main.slice(main.indexOf('async function signIn'), main.indexOf('async function signOut'));
    expect(signIn).toContain('modal: true');
    expect(signIn).toContain('attachFramelessControls(authWin');
    expect(signIn).toContain('withConsoleButton: false');
  });

  it('drops Config but keeps a drag handle, minimize and close', () => {
    const { body, opened, closes } = runInjection(null, shellControlsJs(false));
    const pill = body.children[0];
    expect(pill.style.WebkitAppRegion).toBe('drag');
    const buttons = pill.children;
    expect(buttons.map((b) => b.title)).toEqual(['Minimize', 'Close this window']);
    buttons[0].onclick?.();
    buttons[1].onclick?.();
    expect(opened).toEqual([CONTROL_MINIMIZE]);
    expect(closes).toHaveLength(1);
  });
});
