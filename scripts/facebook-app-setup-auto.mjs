#!/usr/bin/env node
/**
 * Facebook App Setup Wizard — Auto-launch variant
 * Opens the browser immediately without waiting for ENTER.
 * Redirects to the main wizard script for the interactive steps.
 */

import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
const context = await browser.newContext({ viewport: null });
const page = await context.newPage();

console.log('\n  Opening Facebook Developer Portal...\n');
console.log('  Follow the steps in the browser:');
console.log('  1. Log into Facebook');
console.log('  2. Go to https://developers.facebook.com/apps/');
console.log('  3. Click "Create App" > "Other" > "Business"');
console.log('  4. Name it anything (e.g. "My Page Bot")');
console.log('  5. After creation, go to Settings > Basic');
console.log('  6. Copy the App ID and App Secret');
console.log('  7. Paste them into the login page at:');
console.log('     http://localhost:35457/api/facebook-auth/app\n');

await page.goto('https://developers.facebook.com/apps/');

// Keep browser open until user closes it
await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
await browser.close().catch(() => {});
console.log('\n  Browser closed. Enter your App ID and Secret at:');
console.log('  http://localhost:35457/api/facebook-auth/app\n');
