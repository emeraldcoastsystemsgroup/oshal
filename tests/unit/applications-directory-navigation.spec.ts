/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify directory navigation preserves active Home, fences late renders and returns focused applications through ordinary navigation.
 */
import { expect, it, vi } from 'vitest';
import { bindApplicationsDirectory } from '@/pages/cockpit/js/applications-directory-navigation.js';

function fixture(search = '') {
  const view = { openDirectory: vi.fn() };
  const controller = { currentView: 'home', activeViewInstance: view };
  const win = Object.assign(new EventTarget(), {
    location: { search, href: `https://oshal.test/cockpit/${search}`, assign: vi.fn() },
    history: { state: { retained: true }, replaceState: vi.fn() },
  });
  const navigateHome = vi.fn(async () => {}), onError = vi.fn();
  const bridge = bindApplicationsDirectory({ win: win as unknown as Window, getController: () => controller, navigateHome, onError });
  return { win, view, controller, navigateHome, onError, bridge };
}

it('opens the current Home directory without navigating or replacing the active composer', async () => {
  const f = fixture(); f.bridge.homeReady(f.view);
  f.win.dispatchEvent(new Event('oshal:open-applications'));
  await vi.waitFor(() => expect(f.view.openDirectory).toHaveBeenCalledOnce());
  expect(f.navigateHome).not.toHaveBeenCalled();
  expect(f.controller.activeViewInstance).toBe(f.view);
  f.bridge.destroy();
});

it('waits for the actual Home render and consumes directory intent only once', async () => {
  const f = fixture(); f.controller.currentView = 'settings';
  f.navigateHome.mockImplementation(async () => { f.controller.currentView = 'home'; });
  await f.bridge.open();
  expect(f.view.openDirectory).not.toHaveBeenCalled();
  f.bridge.homeReady(f.view); f.bridge.homeReady(f.view);
  expect(f.navigateHome).toHaveBeenCalledOnce();
  expect(f.view.openDirectory).toHaveBeenCalledOnce();
  f.bridge.destroy();
});

it('does not open a late directory over a newer application or on the next Home visit', async () => {
  const f = fixture(); f.controller.currentView = 'settings';
  let finish!: () => void;
  f.navigateHome.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const opening = f.bridge.open();
  f.controller.currentView = 'tool-editor'; f.bridge.homeReady(f.view); finish(); await opening;
  f.controller.currentView = 'home'; f.bridge.homeReady(f.view);
  expect(f.view.openDirectory).not.toHaveBeenCalled();
  f.bridge.destroy();
});

it.each(['?app=finance&record=private', '?profile=create'])('returns a focused application through the canonical global directory URL: %s', async search => {
  const f = fixture(search); f.bridge.homeReady(f.view); await f.bridge.open();
  expect(f.win.location.assign).toHaveBeenCalledWith('/cockpit/?view=home&directory=1');
  expect(f.navigateHome).not.toHaveBeenCalled(); expect(f.view.openDirectory).not.toHaveBeenCalled();
  f.bridge.destroy();
});

it('does not carry an unready Home directory request into a later Home instance', async () => {
  const f = fixture(); await f.bridge.open();
  f.controller.currentView = 'tool-editor';
  const nextHome = { openDirectory: vi.fn() };
  f.controller.activeViewInstance = nextHome; f.controller.currentView = 'home';
  f.bridge.homeReady(nextHome);
  expect(nextHome.openDirectory).not.toHaveBeenCalled();
  expect(f.view.openDirectory).not.toHaveBeenCalled();
  f.bridge.destroy();
});

it('consumes a one-shot directory link while retaining unrelated URL and history state', () => {
  const f = fixture('?view=home&directory=1&filter=retained');
  f.bridge.homeReady(f.view);
  expect(f.view.openDirectory).toHaveBeenCalledOnce();
  expect(f.win.history.replaceState).toHaveBeenCalledWith({ retained: true }, '', '/cockpit/?view=home&filter=retained');
  f.bridge.homeReady(f.view); expect(f.view.openDirectory).toHaveBeenCalledOnce();
  f.bridge.destroy();
});

it('disposal prevents later render callbacks and menu events from reopening the directory', async () => {
  const f = fixture('?directory=1'); f.bridge.destroy(); f.bridge.homeReady(f.view);
  f.win.dispatchEvent(new Event('oshal:open-applications')); await f.bridge.open();
  expect(f.view.openDirectory).not.toHaveBeenCalled(); expect(f.navigateHome).not.toHaveBeenCalled();
});
