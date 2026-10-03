/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | OSHAL Node window style (docs/architecture/simple-chat.md): viewMode defaults to the orb for new and existing profiles, OSHAL_VIEW seeds it through the real ConfigStore (only 'chat' and 'orb' are accepted), any other stored or submitted value reads as the orb, and the Full Jarvis window opens /simple only in Simple chat while every other node keeps its configured cockpit path.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => ({ current: '' }));
// The node package resolves its own Electron (packages/oshal-chat/node_modules/electron); the core root has none, so a
// bare 'electron' mock would never reach config.ts. Mock the module the package actually imports.
vi.mock('../../packages/oshal-chat/node_modules/electron/index.js', () => ({ app: { getPath: () => dirs.current }, BrowserWindow: class {} }));

import { ConfigStore, migrateConfig, normalizeViewMode } from '../../packages/oshal-chat/src/main/config';
import { DEFAULT_COCKPIT_PATH, SIMPLE_CHAT_PATH, fullJarvisPath } from '../../packages/oshal-chat/src/main/cockpit-window';

/** A fresh userData folder holding an optional config.json, for one ConfigStore. */
function userData(persisted?: Record<string, unknown>) {
  dirs.current = mkdtempSync(join(tmpdir(), 'oshal-node-view-'));
  if (persisted) writeFileSync(join(dirs.current, 'config.json'), JSON.stringify(persisted));
  return dirs.current;
}

afterEach(() => {
  delete process.env.OSHAL_VIEW;
  if (dirs.current) rmSync(dirs.current, { recursive: true, force: true });
  dirs.current = '';
});

describe('OSHAL Node window style', () => {
  it('keeps the orb for a new profile and for a profile written before the setting existed', () => {
    expect(migrateConfig({}).viewMode).toBe('orb');
    expect(migrateConfig({ configVersion: 2, controlPlaneUrl: 'http://swarm.lan:35457' }).viewMode).toBe('orb');
    userData({ configVersion: 2, controlPlaneUrl: 'http://swarm.lan:35457', fullJarvisEnabled: true });
    expect(new ConfigStore().load().viewMode).toBe('orb');
  });

  it('keeps an explicit Simple chat choice across loads and saves', () => {
    userData({ configVersion: 2, viewMode: 'chat' });
    const store = new ConfigStore();
    expect(store.load().viewMode).toBe('chat');
    expect(store.save({ clientName: 'Desk' }).viewMode).toBe('chat');
    expect(new ConfigStore().load().viewMode).toBe('chat');
  });

  it('reads any other stored, seeded or submitted value as the orb', () => {
    for (const value of ['CHAT', 'simple', '', 42, null]) expect(normalizeViewMode(value), String(value)).toBe('orb');
    expect(migrateConfig({ viewMode: 'simple' as never }).viewMode).toBe('orb');
    userData({ configVersion: 2, viewMode: 'chat' });
    expect(new ConfigStore().save({ viewMode: 'bogus' as never }).viewMode).toBe('orb');
  });

  it('seeds the window from OSHAL_VIEW, and ignores a value it does not know', () => {
    userData({ configVersion: 2 });
    process.env.OSHAL_VIEW = 'chat';
    expect(new ConfigStore().load().viewMode).toBe('chat');
    userData({ configVersion: 2, viewMode: 'chat' });
    process.env.OSHAL_VIEW = 'Simple';
    expect(new ConfigStore().load().viewMode).toBe('chat');
    userData({ configVersion: 2, viewMode: 'chat' });
    process.env.OSHAL_VIEW = 'orb';
    expect(new ConfigStore().load().viewMode).toBe('orb');
  });

  it('opens /simple in the Full Jarvis window only for Simple chat; every other node keeps its cockpit path', () => {
    expect(SIMPLE_CHAT_PATH).toBe('/simple');
    expect(fullJarvisPath({ viewMode: 'chat', cockpitPath: '/cockpit/' })).toBe('/simple');
    expect(fullJarvisPath({ viewMode: 'orb', cockpitPath: '/cockpit/' })).toBe('/cockpit/');
    expect(fullJarvisPath({ viewMode: 'orb', cockpitPath: 'cockpit/?app=finance' })).toBe('/cockpit/?app=finance');
    expect(fullJarvisPath({ cockpitPath: '' })).toBe(DEFAULT_COCKPIT_PATH);
  });
});
