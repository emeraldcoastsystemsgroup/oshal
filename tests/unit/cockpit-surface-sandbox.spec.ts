/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the iframe sandbox that hosts app surfaces: without allow-downloads a surface's download is discarded silently, which is what broke the one-click node installer after the route had already rendered and issued the file.
 */

/**
 * Guards for the cockpit's app-surface iframe sandbox.
 *
 * The sandbox is a security boundary, so it is deliberately narrow. The failure this file
 * exists for is the opposite of the usual one: a MISSING allowance that fails silently.
 */
import { describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';

const CONTROLLER = 'src/pages/cockpit/js/cockpit-view-controller.js';

const source = () => fs.readFile(CONTROLLER, 'utf8');

/** Every sandbox="..." allow-list the controller hands to an iframe. */
async function sandboxAttributes(): Promise<string[]> {
  const text = await source();
  return [...text.matchAll(/sandbox="([^"]+)"/g)].map((m) => m[1]);
}

describe('the iframe sandbox that hosts an app surface', () => {
  it('permits downloads, or a surface cannot hand the user a file', async () => {
    const sandboxes = await sandboxAttributes();
    expect(sandboxes.length).toBeGreaterThan(0);
    for (const sandbox of sandboxes) {
      // The defect: allow-popups was present and allow-downloads was not. The popup opened,
      // the browser discarded the download, and the user got a blank tab with no file, no
      // console error, and a server log line saying the installer had been issued. Nothing
      // on either side reported a failure.
      expect(sandbox).toContain('allow-downloads');
    }
  });

  it('still keeps the boundary narrow — no blanket escape', async () => {
    // allow-downloads is an addition to a deliberately restrictive list, not permission to
    // widen it. These two would let a surface break out of the frame entirely.
    for (const sandbox of await sandboxAttributes()) {
      expect(sandbox).not.toContain('allow-top-navigation ');
      expect(sandbox).not.toMatch(/allow-top-navigation"/);
      expect(sandbox).not.toContain('allow-same-origin allow-scripts allow-top-navigation"');
    }
  });

  it('scopes each allowance explicitly rather than dropping the attribute', async () => {
    const text = await source();
    // Dropping sandbox= entirely is the tempting "fix" when a surface misbehaves. Only the
    // voice surface is deliberately unsandboxed, and it is gated by an explicit test.
    const unsandboxed = [...text.matchAll(/isVoiceSurface/g)];
    expect(unsandboxed.length).toBeGreaterThan(0);
    expect(text).toMatch(/sandbox="allow-scripts/);
  });
});
