/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise the shipped chooser across package identities, discovery order and legacy layouts.
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/experience/shell.js', 'utf8');
const rows = [
  { app: 'business-experience', label: 'Business', skin: 'company' },
  { app: 'classroom-experience', label: 'Classroom', skin: 'classroom' },
  { app: 'home-experience', label: 'Home', skin: 'family' },
];

/** @description Execute the actual browser script over synthetic discovery and body metadata.
 * @param dataset Page identity and historical layout attributes. @param search Legacy query string.
 * @returns The exported shipped chooser after discovery settles. */
async function chooser(dataset: Record<string, string>, search = '') {
  const window: any = { OSHAL_LIVE: { localHref: (href: string) => href }, dispatchEvent() {} };
  runInNewContext(source, { window, document: { body: { dataset }, querySelectorAll: () => [] },
    location: { search }, URLSearchParams, CustomEvent: class {},
    fetch: async () => ({ ok: true, json: async () => ({ experiences: rows }) }) });
  await window.OSHAL_SHELL.readyExperiences;
  return window.OSHAL_SHELL;
}

describe('current installed experience chooser', () => {
  it.each([
    ['home-experience', 'family', 'Home'],
    ['business-experience', 'company', 'Business'],
    ['classroom-experience', 'classroom', 'Classroom'],
  ])('selects %s by package identity despite legacy layout and conflicting query', async (app, layout, label) => {
    const shell = await chooser({ experienceApp: app, layout }, '?preset=company');
    const selected = shell.currentExperience();
    expect(selected.id).toBe(app); expect(selected.label).toBe(label);
    expect(shell.pickerMarkup(selected.id)).toContain(`value="${app}" selected`);
    expect(shell.pickerMarkup(layout)).toContain(`value="${app}" selected`);
    expect(shell.pickerMarkup(layout)).toContain(`value="${app}" selected`);
  });
  it('keeps historical layout and query selection for pages without package identity', async () => {
    expect((await chooser({ layout: 'family' })).currentExperience().id).toBe('home-experience');
    expect((await chooser({ layout: 'family' }, '?preset=company')).currentExperience().id).toBe('business-experience');
  });
  it('does not substitute another experience for an undiscovered package identity', async () => {
    expect((await chooser({ experienceApp: 'unavailable-experience', layout: 'family' })).currentExperience()).toBeNull();
  });
});
