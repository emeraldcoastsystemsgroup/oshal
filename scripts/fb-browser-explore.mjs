/**
 * Explore Facebook's developer portal in a live browser.
 * Opens Chromium, navigates to the app creation flow, and
 * logs every step so we can see what Facebook actually requires.
 */

import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: false,
  slowMo: 500,  // slow down so you can see each action
  args: ['--start-maximized'],
});

const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

console.log('\n--- Step 1: Go to Facebook App Creation ---');
await page.goto('https://developers.facebook.com/apps/creation/');
await page.waitForLoadState('networkidle');

// Take a screenshot so we can see what's there
await page.screenshot({ path: '/tmp/fb-step1-app-creation.png', fullPage: true });
console.log('Screenshot saved: /tmp/fb-step1-app-creation.png');
console.log('Current URL:', page.url());
console.log('Page title:', await page.title());

// Log all visible buttons and links
const buttons = await page.$$eval('button, [role="button"], a[href]', els =>
  els.map(el => ({
    tag: el.tagName,
    text: el.textContent?.trim().substring(0, 80),
    href: el.href || null,
  })).filter(e => e.text && e.text.length > 0)
);
console.log('\nVisible buttons/links:');
buttons.slice(0, 30).forEach(b => console.log(`  [${b.tag}] ${b.text}${b.href ? ' -> ' + b.href : ''}`));

// Check if login is required
const needsLogin = page.url().includes('login') || await page.$('input[name="email"]');
if (needsLogin) {
  console.log('\n--- Facebook requires login first ---');
  await page.screenshot({ path: '/tmp/fb-login-required.png' });
  console.log('Screenshot: /tmp/fb-login-required.png');
}

// Wait for user to look at it
console.log('\n--- Browser is open. Waiting 60 seconds for you to look around. ---');
await page.waitForTimeout(60000);

await browser.close();
console.log('Browser closed.');
