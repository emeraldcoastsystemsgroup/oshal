/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Split verbatim out of tests/jarvis-rich-response-integration.spec.ts at the 1000-code-line cap: the phone-width, 200%-zoom reflow, keyboard-operation, focus-trap, and reduced-motion acceptance group for the Jarvis rich-response surface.
 */

import { expect, test } from '@playwright/test';
import {
  ARTIFACT_ID,
  ARTIFACT_URL,
  fulfillJarvis,
  installSpeechStub,
  json,
} from './helpers/jarvis-rich-response-fixtures';

test('keeps the orb halo, state label, and controls separated on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installSpeechStub(page);
  await page.route('**/*', fulfillJarvis);
  await page.goto('http://jarvis.test/api/jarvis/');

  const layout = await page.evaluate(() => {
    const state = document.querySelector('.jarvis-ambient__state')!.getBoundingClientRect();
    const status = document.getElementById('status')!.getBoundingClientRect();
    const settings = document.querySelector('.jarvis-ambient__settings-button')!.getBoundingClientRect();
    const chips = document.getElementById('chips')!.getBoundingClientRect();
    return {
      noStateOverlap: state.bottom <= status.top,
      settingsWidth: settings.width,
      settingsHeight: settings.height,
      chipsBottom: chips.bottom,
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  expect(layout.noStateOverlap).toBe(true);
  expect(layout.settingsWidth).toBeGreaterThanOrEqual(44);
  expect(layout.settingsHeight).toBeGreaterThanOrEqual(44);
  expect(layout.chipsBottom).toBeLessThanOrEqual(844);
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
});

test('wraps a complete mobile text reply without horizontal clipping', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await installSpeechStub(page);
  const hardToken = `mobile-wrap-${'W'.repeat(190)}`;
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).pathname === '/api/jarvis/ask/result') {
      return json(route, { status: 'done', answer: `Here is the compact reply ${hardToken}` });
    }
    return fulfillJarvis(route);
  });
  await page.goto('http://jarvis.test/api/jarvis/');
  await expect(page.locator('#chips .chip')).toHaveCount(3);
  await page.locator('#typeToggle').click();

  await page.locator('#typein').fill('Give me a compact mobile answer.');
  await page.locator('#typer button[type="submit"]').click();
  await expect(page.locator('#resultContent')).toContainText(hardToken);

  const duringReply = await page.evaluate(() => {
    const result = document.getElementById('resultContent')!;
    const panel = document.getElementById('resultPanel')!.getBoundingClientRect();
    return {
      resultClientWidth: result.clientWidth,
      resultScrollWidth: result.scrollWidth,
      panelLeft: panel.left,
      panelRight: panel.right,
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });

  expect(duringReply.resultScrollWidth).toBeLessThanOrEqual(duringReply.resultClientWidth);
  expect(duringReply.panelLeft).toBeGreaterThanOrEqual(0);
  expect(duringReply.panelRight).toBeLessThanOrEqual(duringReply.viewportWidth);
  expect(duringReply.documentWidth).toBeLessThanOrEqual(duringReply.viewportWidth);
});

test('hard-wraps a generated visual caption inside a 320px response stage', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await installSpeechStub(page);
  const hardCaption = `Forecast-${'Z'.repeat(210)}`;
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).pathname === '/api/jarvis/ask/result') {
      return json(route, {
        status: 'done',
        answer: hardCaption,
        visual: {
          artifactId: ARTIFACT_ID, type: 'image', kind: 'weather', url: ARTIFACT_URL,
          mimeType: 'image/svg+xml', alt: 'Generated forecast visual', width: 960, height: 540,
        },
      });
    }
    return fulfillJarvis(route);
  });
  await page.goto('http://jarvis.test/api/jarvis/');
  await page.locator('#typeToggle').click();
  await page.locator('#typein').fill('Show me the forecast.');
  await page.locator('#typer button[type="submit"]').click();
  await expect(page.locator('#responseStage')).toHaveAttribute('data-state', 'speaking', { timeout: 6_000 });

  const caption = await page.evaluate(() => {
    const element = document.getElementById('responseStageCaption')!;
    const bounds = element.getBoundingClientRect();
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      left: bounds.left,
      right: bounds.right,
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });

  expect(caption.scrollWidth).toBeLessThanOrEqual(caption.clientWidth);
  expect(caption.left).toBeGreaterThanOrEqual(0);
  expect(caption.right).toBeLessThanOrEqual(caption.viewportWidth);
  expect(caption.documentWidth).toBeLessThanOrEqual(caption.viewportWidth);
});

test('opens Discussion from the active visual plane and restores modal focus safely', async ({ page }) => {
  await installSpeechStub(page);
  await page.route('**/*', fulfillJarvis);
  await page.goto('http://jarvis.test/api/jarvis/');
  await page.locator('#typeToggle').click();
  await page.locator('#typein').fill("What's the weather today?");
  await page.locator('#typer button[type="submit"]').click();
  await expect(page.locator('#responseDiscussionBtn')).toBeVisible({ timeout: 6_000 });
  await expect(page.locator('#responseStopBtn')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#responseDiscussionBtn')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#discussionDrawer')).toHaveClass(/open/);
  await expect(page.locator('#discussionDrawer')).toHaveAttribute('role', 'dialog');
  await expect(page.locator('#responseStage')).toHaveAttribute('inert', '');
  await expect(page.locator('#discussionClose')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Rematerialize visual' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#discussionClose')).toBeFocused();
  await page.locator('#discussionClose').click();
  await expect(page.locator('#discussionDrawer')).not.toHaveClass(/open/);
  await expect(page.locator('#responseDiscussionBtn')).toBeFocused();
});

test('lets keyboard users activate the orb', async ({ page }) => {
  await installSpeechStub(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => Promise.reject(new DOMException('blocked', 'NotAllowedError')) },
    });
  });
  await page.route('**/*', fulfillJarvis);
  await page.goto('http://jarvis.test/api/jarvis/');
  await page.locator('#orb').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#typer')).toHaveClass(/show/);
});

test('opens and closes ambient settings by keyboard while containing and restoring focus', async ({ page }) => {
  await installSpeechStub(page);
  await page.route('**/*', fulfillJarvis);
  await page.goto('http://jarvis.test/api/jarvis/');

  const settings = page.getByRole('button', { name: 'Ambient listening settings' });
  await settings.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Always ready, on your terms' });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close settings' })).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(dialog.locator('footer')).toBeVisible();
  const focusedInsideDialog = await page.evaluate(() => Boolean(document.activeElement?.closest('.jarvis-ambient__panel')));
  expect(focusedInsideDialog).toBe(true);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(settings).toBeFocused();
});

test('honors reduced motion and keeps Stop and Discussion immediately operable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installSpeechStub(page);
  await page.route('**/*', fulfillJarvis);
  await page.goto('http://jarvis.test/api/jarvis/');
  await page.evaluate(() => (window as any).JarvisAmbient.getInstance().setState('armed'));

  const reducedStyles = await page.evaluate(() => {
    const halo = document.querySelector('.jarvis-ambient__bar')!;
    const image = document.getElementById('responseStageImage')!;
    return {
      mediaMatches: matchMedia('(prefers-reduced-motion: reduce)').matches,
      haloAnimation: getComputedStyle(halo, '::before').animationName,
      imageTransitionSeconds: getComputedStyle(image).transitionDuration
        .split(',').map((value) => Number.parseFloat(value) || 0),
    };
  });
  expect(reducedStyles.mediaMatches).toBe(true);
  expect(reducedStyles.haloAnimation).toBe('none');
  expect(Math.max(...reducedStyles.imageTransitionSeconds)).toBeLessThanOrEqual(0.001);

  await page.locator('#typeToggle').click();
  await page.locator('#typein').fill("What's the weather today?");
  await page.locator('#typer button[type="submit"]').click();
  await expect(page.locator('#responseStage')).toHaveAttribute('data-state', 'speaking', { timeout: 2_000 });
  await expect(page.locator('#responseStopBtn')).toBeVisible();
  await expect(page.locator('#responseDiscussionBtn')).toBeVisible();
  await expect(page.locator('#responseStopBtn')).toBeFocused();
});

test('keeps the authoritative text and saved image alt equivalent, and keyboard Stop restores the surface', async ({ page }) => {
  await installSpeechStub(page);
  await page.route('**/*', fulfillJarvis);
  await page.goto('http://jarvis.test/api/jarvis/');
  await page.locator('#typeToggle').click();
  await page.locator('#typein').fill("What's the weather today?");
  await page.locator('#typer button[type="submit"]').click();

  await expect(page.locator('#responseStage')).toHaveAttribute('data-state', 'speaking', { timeout: 6_000 });
  const activeAlt = await page.locator('#responseStageImage').getAttribute('alt');
  expect(activeAlt).toBe('Sunny weather, 72 degrees');
  await expect(page.locator('#convo')).toContainText('Today is sunny with a high of 72 degrees.');
  for (const fact of ['sunny', '72']) {
    expect(activeAlt?.toLowerCase()).toContain(fact);
    expect((await page.locator('#convo').innerText()).toLowerCase()).toContain(fact);
  }

  await page.keyboard.press('Enter');
  await expect(page.locator('#responseStage')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('body')).not.toHaveClass(/jarvis-response-active/);
  await expect(page.locator('body > .scroll')).not.toHaveAttribute('inert', '');
  await expect(page.locator('#responseStageActions')).toBeHidden();
  // Focus returns to the control that submitted the answer, not to the now-removed Stop action.
  await expect(page.locator('#typer button[type="submit"]')).toBeFocused();

  await page.locator('#discussionBtn').click();
  const savedImage = page.locator('#discussionDrawer .discussion-visual-thumb');
  await expect(savedImage).toHaveAttribute('alt', activeAlt || '');
  await expect(page.locator('#discussionDrawer')).toContainText('Today is sunny with a high of 72 degrees.');
});

test('reflows visual controls at 200% text size and a half-width viewport without clipping', async ({ page }) => {
  // A 640px layout viewport is the reflow pressure of a 1280px desktop viewed at 200%; the doubled
  // root font additionally exercises browser text-only zoom for labels and dialog content.
  await page.setViewportSize({ width: 640, height: 800 });
  await installSpeechStub(page);
  await page.route('**/*', fulfillJarvis);
  await page.goto('http://jarvis.test/api/jarvis/');
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.locator('#typeToggle').click();
  await page.locator('#typein').fill("What's the weather today?");
  await page.locator('#typer button[type="submit"]').click();
  await expect(page.locator('#responseStage')).toHaveAttribute('data-state', 'speaking', { timeout: 6_000 });

  const layout = await page.evaluate(() => {
    const stop = document.getElementById('responseStopBtn')!.getBoundingClientRect();
    const discussion = document.getElementById('responseDiscussionBtn')!.getBoundingClientRect();
    const image = document.getElementById('responseStageImage')!.getBoundingClientRect();
    return {
      stop: { left: stop.left, right: stop.right, top: stop.top, bottom: stop.bottom, width: stop.width, height: stop.height },
      discussion: { left: discussion.left, right: discussion.right, top: discussion.top, bottom: discussion.bottom, width: discussion.width, height: discussion.height },
      image: { left: image.left, right: image.right, top: image.top, bottom: image.bottom },
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  for (const control of [layout.stop, layout.discussion]) {
    expect(control.left).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(layout.viewport.width);
    expect(control.top).toBeGreaterThanOrEqual(0);
    expect(control.bottom).toBeLessThanOrEqual(layout.viewport.height);
    expect(control.width).toBeGreaterThanOrEqual(44);
    expect(control.height).toBeGreaterThanOrEqual(44);
  }
  expect(layout.stop.right).toBeLessThanOrEqual(layout.discussion.left);
  expect(layout.image.left).toBeGreaterThanOrEqual(0);
  expect(layout.image.right).toBeLessThanOrEqual(layout.viewport.width);
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport.width);

  await page.locator('#responseDiscussionBtn').click();
  const drawer = page.locator('#discussionDrawer');
  await expect(drawer).toHaveClass(/open/);
  await expect.poll(async () => {
    const bounds = await drawer.boundingBox();
    return bounds ? {
      leftIsVisible: bounds.x >= 0,
      rightEdge: Math.round(bounds.x + bounds.width),
    } : null;
  }).toEqual({ leftIsVisible: true, rightEdge: 640 });
});
