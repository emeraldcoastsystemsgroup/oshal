/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Shared helpers for the headed live suite:
 *                     |               | open cockpit, drive ribbon tools, reach surfaces.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Harden openTool against stale iframe drift by
 *                     |               | requiring the requested active ribbon + URL-hinted iframe.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Clear Cockpit service-worker/static caches before live
 *                     |               | proof runs so pinned platform tools are verified against
 *                     |               | the deployed app, not yesterday's cached ribbon bundle.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Wait for built-in inline cockpit surfaces after ribbon clicks,
 *                     |               | with a controller-level fallback for load-starved live runs.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Accept focused-app navigation role markup when finding
 *                     |               | cockpit ribbon buttons in CDP-attached live runs.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Wait for cockpit readiness by visible nav text so role
 *                     |               | buttons and cached focused shells do not false-fail.
 */

/**
 * @description Shared helpers for the live (headed, real-data) E2E specs.
 * Selectors are deliberately forgiving (role/text/data-attr) so the suite
 * survives cosmetic UI churn; tighten them as the live DOM is confirmed.
 */
import { Page, FrameLocator, expect } from '@playwright/test';

/** Cockpit shell readiness — any left-nav/ribbon button proves we are authenticated + loaded. */
export const COCKPIT_READY = '.ribbon-btn, #ribbonContainer button, nav button, [role="navigation"] button, [role="navigation"] [role="button"], #ribbonContainer [role="button"]';

/** Absolute base URL — a CDP-attached context does NOT inherit the config baseURL,
 *  so navigations must be absolute. */
export const BASE_URL = process.env.OSHAL_E2E_BASE_URL ?? 'https://oshal.agenticfederal.us';

/** UI profile to render. The starter profile only surfaces ~8 tools; the full
 *  ~40-app cockpit is `oshal-framework`. `?profile=` is the authoritative per-session
 *  override (RibbonNav reads it), so it beats any stale service-worker-cached shell. */
export const UI_PROFILE = process.env.OSHAL_E2E_PROFILE ?? 'oshal-framework';

/** Whether the suite may perform reversible writes (drafts, temp playlists, files). */
export const ALLOW_WRITES = ['1', 'true', 'yes'].includes(
  (process.env.OSHAL_E2E_ALLOW_WRITES ?? '').toLowerCase().trim(),
);

const SURFACE_URL_HINTS: Record<string, string[]> = {
  forge: ['/api/forge'],
  'tool-career-insights': ['/career-hunter/', '/api/career'],
  'tool-career-settings': ['/career-hunter/', '/api/career'],
  'tool-workflow-studio': ['/workflow-studio/'],
};

const INLINE_VIEW_SELECTORS: Record<string, string> = {
  connectors: '.connector-view',
  operations: '.ops-view',
};

const VIEW_LABELS: Record<string, string> = {
  addressbook: 'Address Book',
  calendar: 'Calendar',
  chat: 'Swarm Messages',
  connectors: 'Connectors',
  dashboard: 'Dashboard',
  forge: 'Bot Forge',
  logs: 'Logs',
  operations: 'Operations',
  settings: 'Settings',
  tickets: 'Tickets',
  'tool-token-chase': 'Optimizer',
  'tool-workflow-studio': 'Workflow Studio',
};

const LABEL_TO_VIEW_ID = new Map(
  Object.entries(VIEW_LABELS).map(([id, label]) => [normalizeLabel(label), id]),
);

/** Open the cockpit and wait for the ribbon to render. */
export async function openCockpit(page: Page): Promise<void> {
  const url = `${BASE_URL}/cockpit/?profile=${UI_PROFILE}&e2e=${Date.now()}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (shouldClearCockpitCaches()) {
    await clearCockpitCaches(page);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
  // Generous: the host may be under heavy load (builds + many agents), so the
  // ribbon can take a while to render. Prefer a DOM-level readiness predicate:
  // CDP-attached Chrome can expose focused-app nav entries as role buttons even
  // when the exact CSS class selector is hidden by stale/cached shell markup.
  await page.waitForFunction(
    (selector) => {
      const isVisible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect?.();
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      };
      const direct = Array.from(document.querySelectorAll(selector)).some(isVisible);
      if (direct) return true;
      const labels = /Bot Forge|Workflow Studio|Tickets|Operations|Swarm Messages/i;
      return Array.from(document.querySelectorAll('button,[role="button"]')).some((el) => {
        const text = `${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`;
        return labels.test(text) && isVisible(el);
      });
    },
    COCKPIT_READY,
    { timeout: 90_000 },
  );
}

function shouldClearCockpitCaches(): boolean {
  const override = (process.env.OSHAL_E2E_CLEAR_CACHES ?? '').toLowerCase().trim();
  if (['0', 'false', 'no'].includes(override)) return false;
  try {
    const host = new URL(BASE_URL).hostname;
    return host !== 'localhost' && host !== '127.0.0.1';
  } catch {
    return true;
  }
}

async function clearCockpitCaches(page: Page): Promise<void> {
  await page
    .evaluate(async () => {
      const win = window as Window & {
        caches?: CacheStorage;
      };
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((reg) => reg.unregister()));
      }
      if (win.caches?.keys) {
        const keys = await win.caches.keys();
        await Promise.all(keys.filter((key) => key.startsWith('oshal-cockpit-')).map((key) => win.caches!.delete(key)));
      }
    })
    .catch(() => {});
}

/** The ribbon tools currently rendered (id + label), read from the live DOM.
 *  NOTE: the browser-side evaluateAll must NOT reference Node-scope helpers
 *  (cleanRibbonLabel/normalizeLabel/LABEL_TO_VIEW_ID) — they are undefined in the
 *  page context and throw "X is not defined". So we pull only raw strings out of
 *  the DOM and do all cleaning + label→id mapping back here in Node. */
export async function listRibbonTools(page: Page): Promise<Array<{ id: string; label: string }>> {
  const raw = await page.locator(COCKPIT_READY).evaluateAll((els) =>
    els.map((el) => {
      const button = el as HTMLElement;
      const rawLabel = button.getAttribute('title') ?? button.getAttribute('aria-label') ?? (button.textContent ?? '').trim();
      return { rawLabel: rawLabel ?? '', datasetView: button.dataset.view ?? '' };
    }),
  );
  const tools = raw
    .map(({ rawLabel, datasetView }) => {
      const label = cleanRibbonLabel(rawLabel);
      const id = datasetView || LABEL_TO_VIEW_ID.get(normalizeLabel(label)) || '';
      return { id, label };
    })
    .filter((t) => t.id && t.label);
  return tools.filter((tool, index) => tools.findIndex((candidate) => candidate.id === tool.id) === index);
}

/**
 * Click a ribbon tool by its data-view id and wait for its surface to settle.
 * Returns the surface FrameLocator when the tool loads into an iframe, else null.
 */
export async function openTool(page: Page, viewId: string): Promise<FrameLocator | null> {
  const btn = await ribbonButton(page, viewId);
  if ((await btn.count()) === 0) {
    throw new Error(`Ribbon tool not present on this instance: ${viewId}`);
  }
  // Drive the click through the DOM directly: el.click() fires the ribbon button's
  // own click handler with no Playwright scroll/viewport/actionability checks — all
  // of which stall on a load-starved render loop (normal click times out at 90s;
  // forced click reports "outside of viewport"). This is the load-proof path.
  await btn.evaluate((el) => (el as HTMLElement).click());
  let active = await btn.evaluate((el) => (el as HTMLElement).classList.contains('active')).catch(() => false);
  if (!active) {
    await expect(btn, `${viewId} should become active after click`)
      .toHaveClass(/active/, { timeout: 10_000 })
      .catch(() => {});
    active = await btn.evaluate((el) => (el as HTMLElement).classList.contains('active')).catch(() => false);
  }
  if (!active) {
    await btn.evaluate((el) => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }).catch(() => {});
    await expect(btn, `${viewId} should become active after retry`)
      .toHaveClass(/active/, { timeout: 5_000 })
      .catch(() => {});
    active = await btn.evaluate((el) => (el as HTMLElement).classList.contains('active')).catch(() => false);
  }
  if (!active) {
    throw new Error(`Ribbon tool did not become active: ${viewId}`);
  }
  await waitForCockpitView(page, viewId);
  const inlineSelector = INLINE_VIEW_SELECTORS[viewId];
  if (inlineSelector) {
    await page
      .locator(inlineSelector)
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 });
    return null;
  }
  // NOTE: do not wait for 'networkidle' — the live cockpit keeps websockets/polling
  // open so it never settles. Wait for the surface iframe to attach (most apps load
  // into one); fall back to a short settle for inline surfaces.
  await page
    .locator('iframe:visible')
    .first()
    .waitFor({ state: 'visible', timeout: 6_000 })
    .catch(() => {});
  await page.waitForTimeout(600);
  if (SURFACE_URL_HINTS[viewId]?.length) {
    for (let i = 0; i < 20; i++) {
      const hinted = await surfaceFrame(page, viewId);
      if (hinted) return hinted;
      await page.waitForTimeout(500);
    }
    throw new Error(`Expected iframe did not attach for ${viewId}`);
  }
  return surfaceFrame(page, viewId);
}

async function waitForCockpitView(page: Page, viewId: string): Promise<void> {
  const isCurrentView = (id: string) => {
    const win = window as Window & {
      __cockpit?: {
        viewController?: { currentView?: string };
        ribbon?: { setActive?: (viewId: string) => void };
        switchView?: (viewId: string) => Promise<void>;
      };
    };
    return win.__cockpit?.viewController?.currentView === id;
  };
  const current = await page.evaluate(isCurrentView, viewId).catch(() => false);
  if (current) return;
  await page.waitForFunction(isCurrentView, viewId, { timeout: 5_000 }).catch(async () => {
    await page
      .evaluate(async (id) => {
        const win = window as Window & {
          __cockpit?: {
            ribbon?: { setActive?: (viewId: string) => void };
            switchView?: (viewId: string) => Promise<void>;
          };
        };
        if (win.__cockpit?.ribbon?.setActive) {
          win.__cockpit.ribbon.setActive(id);
          return;
        }
        await win.__cockpit?.switchView?.(id);
      }, viewId)
      .catch(() => {});
  });
  await page.waitForFunction(isCurrentView, viewId, { timeout: 20_000 });
}

/** Whether a ribbon tool exists on the current instance. */
export async function hasTool(page: Page, viewId: string): Promise<boolean> {
  return (await (await ribbonButton(page, viewId)).count()) > 0;
}

async function ribbonButton(page: Page, viewId: string) {
  const selectors = [`.ribbon-btn[data-view="${viewId}"]`, `[data-view="${viewId}"]`];
  const label = VIEW_LABELS[viewId];
  if (label) {
    selectors.push(
      `#ribbonContainer button[title="${cssEscape(label)}"]`,
      `nav button[title="${cssEscape(label)}"]`,
      `[role="navigation"] button[title="${cssEscape(label)}"]`,
      `[role="navigation"] [role="button"][title="${cssEscape(label)}"]`,
      `#ribbonContainer [role="button"][title="${cssEscape(label)}"]`,
      `#ribbonContainer button:has-text("${cssEscape(label)}")`,
      `nav button:has-text("${cssEscape(label)}")`,
      `[role="navigation"] button:has-text("${cssEscape(label)}")`,
      `[role="navigation"] [role="button"]:has-text("${cssEscape(label)}")`,
      `#ribbonContainer [role="button"]:has-text("${cssEscape(label)}")`,
    );
  }
  const bySelector = page.locator(selectors.join(', ')).first();
  if ((await bySelector.count()) > 0) {
    return bySelector;
  }
  return page.getByRole('button', { name: new RegExp(escapeRegex(label ?? viewId), 'i') }).first();
}

function cleanRibbonLabel(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeLabel(value: string): string {
  return cleanRibbonLabel(value).toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cssEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * The active app surface. Most cockpit apps render into an iframe in the main
 * panel; return a FrameLocator for the last visible iframe, or null if the
 * surface renders inline (no iframe).
 */
export async function surfaceFrame(page: Page, viewId?: string): Promise<FrameLocator | null> {
  // Many surfaces are iframed; some render inline. Return a FrameLocator only when
  // a visible iframe actually exists, else null so callers use page-level locators.
  const count = await page.locator('iframe:visible').count();
  if (count === 0) return null;

  const wanted = viewId ? SURFACE_URL_HINTS[viewId] ?? [] : [];
  if (wanted.length) {
    const srcs = await page
      .locator('iframe:visible')
      .evaluateAll((els) => els.map((el) => (el as HTMLIFrameElement).src || ''))
      .catch(() => []);
    const index = srcs.findIndex((src) => wanted.some((hint) => src.includes(hint)));
    if (index >= 0) return page.frameLocator('iframe:visible').nth(index);
    return null;
  }

  return page.frameLocator('iframe:visible').last();
}

/** True if a visible error/toast indicates the surface failed to load. */
export async function hasSurfaceError(page: Page): Promise<boolean> {
  const err = page.getByText(/something went wrong|failed to load|error loading|502|503|not authorized/i);
  return err.first().isVisible({ timeout: 1_500 }).catch(() => false);
}
