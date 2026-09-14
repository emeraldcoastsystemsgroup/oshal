/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the embedded-surface theme follow in surface-theme.js: a surface inside a cockpit wears the cockpit's data-theme (a per-app core theme by id; an ADR-085 package-bundled skin by copying #app-package-theme-css and applying only once it loads), keeps following it live through a MutationObserver, and falls back to the SAVED theme on every failure shape — standalone, cross-origin parent, parent without a theme, stylesheet error, storage unavailable. Runs the real bootstrap under a minimal fake DOM (no jsdom in this repo); the fake exposes only what a browser would, so a new DOM dependency in the script fails here first.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Pin the absent-choice Workspace default while preserving saved, invalid and unavailable-storage behavior.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { createContext, runInContext } from 'vm';

const SOURCE = readFileSync('src/shared/ui/js/surface-theme.js', 'utf8');

type Listener = (event: unknown) => void;

interface FakeElement {
  tag: string;
  id?: string;
  rel?: string;
  attrs: Map<string, string>;
  listeners: Record<string, Listener[]>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, fn: Listener): void;
  fire(type: string): void;
}

function element(tag: string): FakeElement {
  const el: FakeElement = {
    tag,
    attrs: new Map(),
    listeners: {},
    setAttribute(name, value) { this.attrs.set(name, String(value)); },
    getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name)! : null; },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    fire(type) { for (const fn of this.listeners[type] ?? []) fn({ type }); },
  };
  Object.defineProperty(el, 'id', { get() { return el.attrs.get('id'); }, set(v: string) { el.attrs.set('id', v); } });
  Object.defineProperty(el, 'rel', { get() { return el.attrs.get('rel'); }, set(v: string) { el.attrs.set('rel', v); } });
  return el;
}

/** A document with the surface area the bootstrap touches: <html>, <head>, getElementById, createElement. */
function fakeDocument() {
  const byId = new Map<string, FakeElement>();
  const documentElement = element('html');
  const head = {
    appended: [] as FakeElement[],
    appendChild(node: FakeElement) { this.appended.push(node); if (node.id) byId.set(node.id, node); return node; },
  };
  return {
    documentElement,
    head,
    byId,
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (tag: string) => element(tag),
    /** Register an element the "cockpit" already holds (its injected package link). */
    hold(node: FakeElement) { byId.set(node.id!, node); return node; },
  };
}

interface Boot {
  document: ReturnType<typeof fakeDocument>;
  parentDocument: ReturnType<typeof fakeDocument> | null;
  observers: Array<{ target: unknown; options: unknown; trigger: () => void }>;
  windowListeners: Record<string, Listener[]>;
  theme(): string | null;
  packageLink(): FakeElement | null;
}

/**
 * Boot the real script in a fresh context. `parent` describes the embedding cockpit: absent =
 * standalone, 'cross-origin' = a parent whose document throws on access, otherwise a fake document.
 */
function boot(opts: { saved?: string | null; storageThrows?: boolean; parent?: 'cross-origin' | ReturnType<typeof fakeDocument> } = {}): Boot {
  const document = fakeDocument();
  const observers: Boot['observers'] = [];
  const windowListeners: Record<string, Listener[]> = {};
  const localStorage = {
    getItem: (key: string) => {
      if (opts.storageThrows) throw new Error('storage unavailable');
      return key === 'cockpit-theme' ? (opts.saved ?? null) : null;
    },
  };
  class MutationObserver {
    private cb: () => void;
    constructor(cb: () => void) { this.cb = cb; }
    observe(target: unknown, options: unknown) { observers.push({ target, options, trigger: () => this.cb() }); }
  }
  const window: Record<string, unknown> = {
    addEventListener: (type: string, fn: Listener) => { (windowListeners[type] ??= []).push(fn); },
    localStorage,
  };
  if (opts.parent === 'cross-origin') {
    window.parent = { get document(): never { throw new Error('SecurityError'); } };
  } else if (opts.parent) {
    window.parent = { document: opts.parent };
  } else {
    window.parent = window;
  }
  const sandbox = { window, document, localStorage, MutationObserver, console };
  runInContext(SOURCE, createContext(sandbox));
  return {
    document,
    parentDocument: opts.parent && opts.parent !== 'cross-origin' ? opts.parent : null,
    observers,
    windowListeners,
    theme: () => document.documentElement.getAttribute('data-theme'),
    packageLink: () => document.getElementById('app-package-theme-css'),
  };
}

/** A cockpit document wearing `id`, with the package link injected when `href` is given. */
function cockpit(id: string | null, href?: string) {
  const doc = fakeDocument();
  if (id) doc.documentElement.setAttribute('data-theme', id);
  if (href) {
    const link = element('link');
    link.id = 'app-package-theme-css';
    link.setAttribute('href', href);
    doc.hold(link);
  }
  return doc;
}

describe('surface-theme.js — standalone (the pre-existing contract)', () => {
  it('keeps saved themes, uses Workspace when absent and retains midnight for an invalid value', () => {
    expect(boot({ saved: 'daylight' }).theme()).toBe('daylight');
    expect(boot({ saved: 'not-a-theme' }).theme()).toBe('midnight');
    expect(boot({ saved: null }).theme()).toBe('workspace');
  });

  it('renders even when storage throws, and registers storage + focus live-follow listeners', () => {
    const b = boot({ storageThrows: true });
    expect(b.theme()).toBe('midnight');
    expect(b.windowListeners.storage).toHaveLength(1);
    expect(b.windowListeners.focus).toHaveLength(1);
    // Standalone: nothing to observe — no parent document is ever touched.
    expect(b.observers).toHaveLength(0);
  });

  it('re-reads the saved theme on a cockpit-theme storage event and ignores other keys', () => {
    let saved = 'daylight';
    const document = fakeDocument();
    const windowListeners: Record<string, Listener[]> = {};
    const window: Record<string, unknown> = { addEventListener: (t: string, fn: Listener) => { (windowListeners[t] ??= []).push(fn); } };
    window.parent = window;
    const localStorage = { getItem: () => saved };
    runInContext(SOURCE, createContext({ window, document, localStorage, console }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('daylight');
    saved = 'ocean';
    windowListeners.storage[0]({ key: 'something-else' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('daylight');
    windowListeners.storage[0]({ key: 'cockpit-theme', newValue: 'ocean' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('ocean');
  });
});

describe('surface-theme.js — embedded in a cockpit', () => {
  it('wears the cockpit\'s per-app CORE theme over the saved one, and observes the parent live', () => {
    const b = boot({ saved: 'midnight', parent: cockpit('graphite') });
    expect(b.theme()).toBe('graphite');
    expect(b.packageLink()).toBeNull();
    expect(b.observers).toHaveLength(1);
    expect(b.observers[0].target).toBe(b.parentDocument!.documentElement);
    expect(b.observers[0].options).toEqual({ attributes: true, attributeFilter: ['data-theme'] });
    // The operator moves to another app: the parent flips, the observer fires, the surface follows.
    b.parentDocument!.documentElement.setAttribute('data-theme', 'sakura');
    b.observers[0].trigger();
    expect(b.theme()).toBe('sakura');
  });

  it('copies a PACKAGE-BUNDLED skin in and applies its id only once the stylesheet has loaded', () => {
    const b = boot({ saved: 'midnight', parent: cockpit('create', '/api/swarm/apps/create/theme.css') });
    // Not yet: applying an id whose tokens have not loaded would paint the surface with no tokens.
    expect(b.theme()).toBeNull();
    const link = b.packageLink();
    expect(link).not.toBeNull();
    expect(link!.rel).toBe('stylesheet');
    expect(link!.getAttribute('href')).toBe('/api/swarm/apps/create/theme.css');
    expect(b.document.head.appended).toEqual([link]);
    link!.fire('load');
    expect(b.theme()).toBe('create');
    // A later re-sync with the same skin applies immediately and injects nothing new.
    b.observers[0].trigger();
    expect(b.theme()).toBe('create');
    expect(b.document.head.appended).toHaveLength(1);
  });

  it('drops to the saved theme when the packaged stylesheet fails to load', () => {
    const b = boot({ saved: 'daylight', parent: cockpit('create', '/api/swarm/apps/create/theme.css') });
    b.packageLink()!.fire('error');
    expect(b.theme()).toBe('daylight');
  });

  it('ignores an unknown parent id with no bundled stylesheet, a malformed id, and a parent without a theme', () => {
    expect(boot({ saved: 'ocean', parent: cockpit('create') }).theme()).toBe('ocean');
    expect(boot({ saved: 'ocean', parent: cockpit('../evil', '/x.css') }).theme()).toBe('ocean');
    expect(boot({ saved: 'ocean', parent: cockpit(null) }).theme()).toBe('ocean');
  });

  it('treats a cross-origin parent exactly like standalone — saved theme, nothing observed, no throw', () => {
    const b = boot({ saved: 'forest', parent: 'cross-origin' });
    expect(b.theme()).toBe('forest');
    expect(b.observers).toHaveLength(0);
    expect(b.windowListeners.storage).toHaveLength(1);
  });

  it('keeps the cockpit\'s theme authoritative when the saved theme changes underneath it', () => {
    const b = boot({ saved: 'midnight', parent: cockpit('amber') });
    b.windowListeners.storage[0]({ key: 'cockpit-theme', newValue: 'daylight' });
    expect(b.theme()).toBe('amber');
    b.windowListeners.focus[0]({});
    expect(b.theme()).toBe('amber');
  });
});

describe('surface-theme.js — contract pins', () => {
  it('is mounted before OIDC, so it must never fetch, and must survive storage throwing', () => {
    expect(SOURCE).not.toMatch(/\bfetch\s*\(/);
    expect(SOURCE).toMatch(/catch \(_\)/);
    expect(SOURCE).toContain("'app-package-theme-css'");
  });
});
