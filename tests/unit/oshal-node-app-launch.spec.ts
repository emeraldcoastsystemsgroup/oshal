/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for OSHAL Node per-app desktop launch (operator directive: every cockpit app is a real clickable Windows application). Goes red if --app argv parsing stops sanitizing (a hostile shortcut could steer the window off /cockpit/), if the app path ever drifts from the ?app= URL-as-truth contract, or if --make-shortcuts stops de-duplicating/dropping invalid names. Helpers live in app-launch.ts, electron-free by design so this spec needs no Electron runtime.
 */

import { describe, expect, it } from 'vitest';
import {
  buildCockpitAppPath,
  parseLaunchAppArg,
  parseMakeShortcutsArg,
  prettifyAppTitle,
  sanitizeCockpitAppName,
} from '../../packages/oshal-chat/src/main/app-launch';

describe('sanitizeCockpitAppName', () => {
  it('admits kebab manifest names and normalizes case', () => {
    expect(sanitizeCockpitAppName('intelligent-trades')).toBe('intelligent-trades');
    expect(sanitizeCockpitAppName('DND')).toBe('dnd');
    expect(sanitizeCockpitAppName(' little-monsters ')).toBe('little-monsters');
  });

  it('rejects path/query injection shapes and empty values', () => {
    expect(sanitizeCockpitAppName('../cockpit')).toBeUndefined();
    expect(sanitizeCockpitAppName('a&b=c')).toBeUndefined();
    expect(sanitizeCockpitAppName('x y')).toBeUndefined();
    expect(sanitizeCockpitAppName('-leading-dash')).toBeUndefined();
    expect(sanitizeCockpitAppName('')).toBeUndefined();
    expect(sanitizeCockpitAppName(undefined)).toBeUndefined();
    expect(sanitizeCockpitAppName('a'.repeat(70))).toBeUndefined();
  });
});

describe('parseLaunchAppArg', () => {
  it('finds --app= anywhere in argv, last valid one wins', () => {
    expect(parseLaunchAppArg(['exe', '--app=dnd'])).toBe('dnd');
    expect(parseLaunchAppArg(['exe', '--app=dnd', '--app=finance'])).toBe('finance');
    expect(parseLaunchAppArg(['exe', '--app=finance', '--app=../evil'])).toBe('finance');
  });

  it('returns undefined when absent or invalid', () => {
    expect(parseLaunchAppArg(['exe'])).toBeUndefined();
    expect(parseLaunchAppArg(['exe', '--app=bad name'])).toBeUndefined();
  });
});

describe('parseMakeShortcutsArg', () => {
  it('splits, sanitizes, drops invalid entries, and de-duplicates', () => {
    expect(parseMakeShortcutsArg(['exe', '--make-shortcuts=dnd,finance,dnd,../evil'])).toEqual(['dnd', 'finance']);
    expect(parseMakeShortcutsArg(['exe'])).toEqual([]);
  });
});

describe('buildCockpitAppPath', () => {
  it('emits the ?app= URL-as-truth contract path', () => {
    expect(buildCockpitAppPath('intelligent-trades')).toBe('/cockpit/?app=intelligent-trades');
  });
});

describe('prettifyAppTitle', () => {
  it('title-cases kebab names for window titles and .lnk filenames', () => {
    expect(prettifyAppTitle('intelligent-trades')).toBe('Intelligent Trades');
    expect(prettifyAppTitle('little-monsters')).toBe('Little Monsters');
    expect(prettifyAppTitle('dnd')).toBe('Dnd');
  });
});
