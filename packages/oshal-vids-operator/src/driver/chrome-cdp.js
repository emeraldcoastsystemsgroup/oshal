'use strict';
/**
 * @description CDP-attach driver for Google Vids / Veo.
 *
 * Attaches to a Chrome the operator launched themselves with
 * --remote-debugging-port (see scripts/launch-chrome.js) instead of letting
 * Playwright launch a fresh browser. Why: Google blocks logins from
 * Playwright-launched browsers AND the operator is already signed in. So we
 * connect over CDP and drive the EXISTING signed-in session — no login step.
 *
 * Clicks are driven through the DOM via el.click() inside evaluate(): this fires
 * the element's own handler with no Playwright scroll/viewport/actionability
 * checks, all of which stall on a busy render loop. This mirrors the proven
 * pattern in tests/live/helpers.ts (openTool).
 */
const { chromium } = require('playwright');

// 127.0.0.1, not localhost: Chrome's debug port binds IPv4, but `localhost` can
// resolve to IPv6 (::1) first and ECONNREFUSED before trying IPv4.
const CDP_URL = process.env.VIDS_CDP_URL || 'http://127.0.0.1:9222';
/** A tab is "the Vids project" if its URL looks like the Google Vids editor. */
const VIDS_URL_HINT = /docs\.google\.com\/(videos|presentation)/i;

/** Close nothing — but list targets so we can find the operator's Vids tab. */
async function listTargets(cdpUrl) {
  try {
    const res = await fetch(`${cdpUrl}/json/list`);
    return (await res.json()) || [];
  } catch {
    return [];
  }
}

class VidsDriver {
  constructor(opts = {}) {
    this.cdpUrl = opts.cdpUrl || CDP_URL;
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  /** Attach to the operator's Chrome and bind to their open Vids tab. */
  async connect() {
    try {
      this.browser = await chromium.connectOverCDP(this.cdpUrl, { timeout: 60_000 });
    } catch (err) {
      throw new Error(
        `Could not attach to Chrome at ${this.cdpUrl}. Launch it first:\n` +
          `  npx oshal-vids chrome   (or: node scripts/launch-chrome.js)\n` +
          `then open your Google Vids project in that window.\nOriginal: ${String(err)}`,
      );
    }
    this.context = this.browser.contexts()[0];
    if (!this.context) {
      throw new Error('Attached to Chrome but found no context. Open a tab in that Chrome first.');
    }
    await this.bindVidsTab();
    return this.page;
  }

  /** Find the already-open Vids editor tab; never hijack an unrelated tab. */
  async bindVidsTab() {
    // Prefer a page Playwright already sees.
    for (const p of this.context.pages()) {
      const url = p.url() || '';
      if (VIDS_URL_HINT.test(url)) {
        this.page = p;
        return p;
      }
    }
    // Fall back to the raw CDP target list (a tab Playwright hasn't adopted yet).
    const targets = await listTargets(this.cdpUrl);
    const vids = targets.find((t) => t.type === 'page' && VIDS_URL_HINT.test(t.url || ''));
    if (vids) {
      // Re-scan pages after a beat; connectOverCDP adopts targets lazily.
      await new Promise((r) => setTimeout(r, 500));
      for (const p of this.context.pages()) {
        if (VIDS_URL_HINT.test(p.url() || '')) {
          this.page = p;
          return p;
        }
      }
    }
    throw new Error(
      'No Google Vids tab found in your Chrome. Open your Vids project ' +
        '(docs.google.com/videos/...) in the debug Chrome, then retry.',
    );
  }

  ensurePage() {
    if (!this.page) throw new Error('Driver not connected. Call connect() first.');
    return this.page;
  }

  /**
   * Resolve a target to a Playwright Locator using forgiving, text/role-first
   * selectors so the recipe survives cosmetic DOM churn. `target` may be:
   *   { text } | { role, name } | { selector } | { placeholder } | { testid }
   * Returns the first match (may be count 0 — caller checks).
   */
  locator(target) {
    const page = this.ensurePage();
    if (typeof target === 'string') target = { text: target };
    if (target.selector) return page.locator(target.selector).first();
    if (target.testid) return page.getByTestId(target.testid).first();
    if (target.placeholder) return page.getByPlaceholder(target.placeholder, { exact: false }).first();
    if (target.role) return page.getByRole(target.role, { name: new RegExp(escapeRegex(target.name || ''), 'i') }).first();
    if (target.text) {
      // Try a clickable role first, then any element containing the text.
      const re = new RegExp(escapeRegex(target.text), 'i');
      return page
        .getByRole('button', { name: re })
        .or(page.getByText(re, { exact: false }))
        .first();
    }
    throw new Error(`Unrecognized target: ${JSON.stringify(target)}`);
  }

  /** Whether a target is present + visible right now. */
  async exists(target, timeoutMs = 1500) {
    try {
      const loc = this.locator(target);
      await loc.waitFor({ state: 'visible', timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  /** Click via the DOM — load-proof (no actionability stalls), with retries. */
  async click(target, { timeoutMs = 15_000 } = {}) {
    const loc = this.locator(target);
    await loc.waitFor({ state: 'attached', timeout: timeoutMs });
    await loc.evaluate((el) => el.click());
    // Synthetic-event fallback for handlers that ignore el.click().
    await loc
      .evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })))
      .catch(() => {});
  }

  /** Type into a target (clears first). */
  async type(target, value, { timeoutMs = 15_000 } = {}) {
    const loc = this.locator(target);
    await loc.waitFor({ state: 'visible', timeout: timeoutMs });
    await loc.click().catch(() => loc.evaluate((el) => el.click?.()));
    await loc.fill('').catch(() => {});
    await loc.fill(String(value)).catch(async () => {
      // contenteditable / non-input prompt boxes: type char by char.
      await loc.evaluate((el, v) => {
        el.focus?.();
        if ('value' in el) el.value = v;
        else el.textContent = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, String(value));
    });
  }

  /** Attach a local file to the nearest file input (Ingredients / Uploads). */
  async uploadFile(target, filePath) {
    const page = this.ensurePage();
    // Vids opens a chooser on click; intercept it.
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15_000 }),
      this.click(target),
    ]);
    await chooser.setFiles(filePath);
  }

  /** Wait until a predicate is true. `pred` is a target (visible) or a DOM fn string. */
  async waitFor(pred, { timeoutMs = 120_000, pollMs = 1000 } = {}) {
    const page = this.ensurePage();
    if (typeof pred === 'object' && (pred.text || pred.role || pred.selector || pred.testid || pred.placeholder)) {
      await this.locator(pred).waitFor({ state: 'visible', timeout: timeoutMs });
      return true;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await page.evaluate(pred).catch(() => false);
      if (ok) return true;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error('waitFor timed out');
  }

  /**
   * Visible clickable/typeable labels on the page — the cheap "text-vision"
   * signal the bot's fallback uses to choose a target without needing image
   * support. Returns [{ kind, label }] deduped, capped.
   */
  async listClickables(limit = 60) {
    const page = this.ensurePage();
    return page
      .evaluate((max) => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0;
        };
        const out = [];
        const seen = new Set();
        const sel = 'button,[role="button"],a,input,textarea,[role="textbox"],[contenteditable="true"],[role="combobox"]';
        for (const el of Array.from(document.querySelectorAll(sel))) {
          if (!visible(el)) continue;
          const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.textContent || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 60);
          if (!label || seen.has(label)) continue;
          seen.add(label);
          const tag = el.tagName.toLowerCase();
          const kind = tag === 'input' || tag === 'textarea' || el.getAttribute('role') === 'textbox' || el.isContentEditable ? 'input' : 'button';
          out.push({ kind, label });
          if (out.length >= max) break;
        }
        return out;
      }, limit)
      .catch(() => []);
  }

  /** Full-page PNG as a base64 data URL — for the panel + the vision fallback. */
  async screenshot() {
    const page = this.ensurePage();
    const buf = await page.screenshot({ type: 'png' }).catch(() => null);
    return buf ? `data:image/png;base64,${buf.toString('base64')}` : null;
  }

  /** Raw PNG buffer (vision fallback writes this to a temp file for Codex). */
  async screenshotBuffer() {
    return this.ensurePage().screenshot({ type: 'png' });
  }

  async disconnect() {
    // Disconnect the CDP session only — never close the operator's Chrome.
    try {
      await this.browser?.close();
    } catch {
      /* ignore */
    }
    this.browser = null;
    this.context = null;
    this.page = null;
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { VidsDriver, CDP_URL, VIDS_URL_HINT };
