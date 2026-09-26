/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the five places an experience skin must be registered to reach every surface: the shell's switcher, the cockpit theme list, the cockpit stylesheet links, the shared surface-theme bootstrap and its stylesheet imports, plus the palette file itself. A skin missing from any one of them renders as the fallback somewhere, silently.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { COCKPIT_THEMES, EXPERIENCE_THEMES, resolveCockpitTheme } from '../../src/pages/cockpit/js/theme-manager.js';

const read = (path: string) => readFileSync(path, 'utf8');
const switcher = read('src/experience/style-switcher.js');
const EXPERIENCE_SKINS = [...switcher.matchAll(/\{ id: '([a-z-]+)', name: '[^']+', mode: '(dark|light)'/g)].map(m => m[1]);

describe('experience skins are registered everywhere a surface can look them up', () => {
  it('lists the eight experience skins and the twelve cockpit themes in the switcher', () => {
    expect(EXPERIENCE_SKINS.slice(0, 8)).toEqual(['studio', 'jarvis', 'orbit', 'commons', 'nexus', 'family', 'classroom', 'company']);
    expect(EXPERIENCE_SKINS).toHaveLength(20);
  });
  it('keeps the Settings picker and cycle on the twelve canonical themes while accepting the experience skins', () => {
    expect(COCKPIT_THEMES).toHaveLength(12); expect(EXPERIENCE_THEMES).toHaveLength(8); expect(resolveCockpitTheme('not-a-theme')).toBe('midnight');
  });
  it('every switcher skin is accepted by the cockpit, has a palette file, is linked by the cockpit and imported by the shared stylesheet', () => {
    const index = read('src/pages/cockpit/index.html'), shared = read('src/shared/ui/css/surface-themes.css'), bootstrap = read('src/shared/ui/js/surface-theme.js');
    for (const id of EXPERIENCE_SKINS) {
      expect([...COCKPIT_THEMES, ...EXPERIENCE_THEMES], `${id} accepted by the cockpit`).toContain(id);
      expect(resolveCockpitTheme(id), `${id} survives cockpit validation`).toBe(id);
      expect(existsSync(`src/pages/cockpit/css/themes/${id}.css`), `${id}.css exists`).toBe(true);
      expect(read(`src/pages/cockpit/css/themes/${id}.css`), `${id}.css defines its selector`).toMatch(new RegExp(`\\[data-theme="${id}"\\]`));
      expect(index, `cockpit links ${id}.css`).toContain(`href="css/themes/${id}.css"`);
      expect(shared, `surface-themes.css imports ${id}.css`).toContain(`/cockpit/css/themes/${id}.css`);
      expect(bootstrap, `surface-theme.js supports ${id}`).toMatch(new RegExp(`'${id}'`));
    }
  });
  it('the switcher writes the saved cockpit appearance only on an explicit choice', () => {
    const body = switcher.slice(switcher.indexOf('function applySkin'), switcher.indexOf('function buildSelectMarkup'));
    expect(body).toContain("localStorage.setItem('cockpit-theme', def.id)");
    expect(body).toMatch(/if \(save\) \{[\s\S]*cockpit-theme[\s\S]*\}/);
    const init = switcher.slice(switcher.indexOf('function init'));
    expect(init).toContain('applySkin(stored, false)');
    expect(init).toContain('applySkin(defaultSkin(), false)');
  });
});
