/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the ticket-detail scroll fix: the pinned header must not consume the scroll area (.td-body is the sole flex/overflow scroll child) and the served src/api mirror must stay byte-identical to src/pages so a rebuild can't revert it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const SOURCE = 'src/pages/cockpit/css/ticket-view.css';
const MIRROR = 'src/api/cockpit/css/ticket-view.css';

/**
 * @description Extract the CSS declaration block for a selector so assertions
 * target a specific rule rather than an incidental match elsewhere in the file.
 * @param css - Full stylesheet text.
 * @param selector - Exact selector text preceding the `{ ... }` block.
 * @returns The declaration body (between the braces), or '' when not found.
 */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return '';
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  if (open === -1 || close === -1) return '';
  return css.slice(open + 1, close);
}

describe('cockpit ticket-view detail scroll structure', () => {
  const css = readFileSync(path.join(root, SOURCE), 'utf8');

  it('bounds the detail pane so the header/tabs pin and cannot become one giant scroll block', () => {
    const pane = ruleBody(css, '.ticket-detail-pane');
    expect(pane).toContain('flex-direction: column');
    expect(pane).toContain('min-height: 0');
    // The pane itself must NOT scroll (that is the bug); overflow is hidden here
    // and the scroll is delegated to .td-body.
    expect(pane).toContain('overflow: hidden');
    expect(pane).not.toContain('overflow-y: auto');
  });

  it('makes .td-body the single independent scroll child that fills remaining height', () => {
    const body = ruleBody(css, '.td-body');
    // The classic flexbox scroll trap: without min-height:0 the child refuses to
    // shrink below its content and the scrollbar never appears.
    expect(body).toContain('flex: 1 1 auto');
    expect(body).toContain('min-height: 0');
    expect(body).toContain('overflow-y: auto');
    // Regression guard: it must not go back to a non-shrinking fixed block.
    expect(body).not.toContain('flex-shrink: 0');
  });

  it('keeps the pinned header rows from stealing the scroll area', () => {
    // Header, actions and tab strip stay put (flex-shrink:0) above the scroll body.
    expect(ruleBody(css, '.td-header')).toContain('flex-shrink: 0');
    expect(ruleBody(css, '.td-actions')).toContain('flex-shrink: 0');
    expect(ruleBody(css, '.td-tabs')).toContain('flex-shrink: 0');
  });

  it('compacts the ticket detail header on phones so the body is reachable', () => {
    const mobileBlock = css.slice(css.indexOf('@media (max-width: 640px)'));
    expect(mobileBlock).toContain('.ticket-view');
    expect(mobileBlock).toContain('flex-direction: column');
    // Non-essential, space-hungry chrome is dropped on narrow viewports.
    expect(mobileBlock).toContain('#tvProjectCustomName');
    // Wide content (tab strip) scrolls inside itself rather than widening the page.
    expect(mobileBlock).toMatch(/\.td-tabs\s*{[^}]*overflow-x:\s*auto/);
  });

  it('scrolls wide code/table content inside the body instead of widening the page', () => {
    expect(css).toMatch(/\.td-body pre,\s*\n?\s*\.td-body table\s*{[^}]*overflow-x:\s*auto/);
  });
});

describe('cockpit ticket-view served mirror parity', () => {
  it('keeps the src/api mirror byte-identical so an image rebuild cannot revert the fix', () => {
    const source = readFileSync(path.join(root, SOURCE), 'utf8');
    const mirror = readFileSync(path.join(root, MIRROR), 'utf8');
    expect(mirror).toBe(source);
  });
});
