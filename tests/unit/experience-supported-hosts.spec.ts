/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise the shipped exact supported-surface helper without changing member profile visibility.
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
const context = { window: {} as { OSHAL_EXPERIENCE_HOSTS: { admits(host: object, item: object): boolean } } };
runInNewContext(readFileSync('src/experience/experience-hosts.js', 'utf8'), context);
const admits = context.window.OSHAL_EXPERIENCE_HOSTS.admits;
describe('package-owned supported member selections', () => {
  it('selects exact original member names from current profile entries', () => {
    expect(admits({ surfaces: ['shop-lists'] }, { id: 'tool-shop-lists', toolUi: { iframeUrl: '/current/member/list' } })).toBe(true);
    expect(admits({ surfaces: ['shop-lists'] }, { id: 'tool-shop-lists-extra' })).toBe(false);
    expect(admits({ surfaces: ['shop-lists'] }, { id: 'tool-other-name', toolUi: { visibilityToolName: 'shop-lists' } })).toBe(true);
  });
  it('an explicit empty selection admits no profile surface while legacy presets retain their behavior', () => {
    expect(admits({ surfaces: [] }, { id: 'tool-shop-lists' })).toBe(false);
    expect(admits({}, { id: 'tool-shop-lists' })).toBe(true);
  });
});
