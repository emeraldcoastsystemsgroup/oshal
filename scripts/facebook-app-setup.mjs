#!/usr/bin/env node
/**
 * Facebook App Setup Wizard
 *
 * Walks the user through creating a Facebook App using a real browser.
 * Opens developers.facebook.com, guides each step, extracts the App ID
 * and Secret, and saves them into the framework's config.
 *
 * Usage:
 *   node scripts/facebook-app-setup.mjs
 *   # or via npm:
 *   npm run setup:facebook
 */

import { chromium } from 'playwright';
import { createInterface } from 'readline';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const API_BASE = process.env.API_BASE || 'http://localhost:35457';

// ── Helpers ──────────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });
function ask(q) { return new Promise(r => rl.question(q, r)); }
function log(msg) { console.log(`\n  \x1b[36m>\x1b[0m ${msg}`); }
function success(msg) { console.log(`\n  \x1b[32m✓\x1b[0m ${msg}`); }
function warn(msg) { console.log(`\n  \x1b[33m!\x1b[0m ${msg}`); }
function banner(msg) { console.log(`\n  \x1b[1m\x1b[35m${msg}\x1b[0m\n`); }

async function pause(msg = 'Press ENTER when ready...') {
  await ask(`  \x1b[33m⏸\x1b[0m  ${msg}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  banner('Facebook App Setup Wizard');
  console.log('  This wizard opens a browser and walks you through creating');
  console.log('  a Facebook App so the facebook-bot can manage your pages.');
  console.log('  It takes about 2 minutes.\n');

  await pause('Press ENTER to open the browser...');

  // Launch a visible browser — the user needs to see and interact with it
  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized'],
  });
  const context = await browser.newContext({
    viewport: null,  // use full window
  });
  const page = await context.newPage();

  try {
    // ── Step 1: Log into Facebook ──────────────────────────────────────
    banner('Step 1 of 5 — Log into Facebook');
    log('Opening Facebook login...');
    await page.goto('https://www.facebook.com/login');

    log('Log into your Facebook account in the browser window.');
    log('The wizard will detect when you\'re logged in.');

    // Wait for login — detect by URL change away from /login
    await page.waitForURL((url) => {
      const path = new URL(url).pathname;
      return !path.includes('/login') && !path.includes('/checkpoint');
    }, { timeout: 300000 }); // 5 minutes to log in

    success('Logged into Facebook!');

    // ── Step 2: Go to Developer Portal ─────────────────────────────────
    banner('Step 2 of 5 — Open Developer Portal');
    log('Navigating to developers.facebook.com...');
    await page.goto('https://developers.facebook.com/apps/');
    await page.waitForLoadState('networkidle');

    // Check if they need to register as a developer first
    const needsRegistration = await page.$('text=Register Now') || await page.$('text=Get Started');
    if (needsRegistration) {
      log('You need to register as a Facebook Developer first.');
      log('Click "Get Started" or "Register Now" in the browser.');
      await pause('Press ENTER after you\'ve completed developer registration...');
      await page.goto('https://developers.facebook.com/apps/');
      await page.waitForLoadState('networkidle');
    }

    success('Developer portal is open.');

    // ── Step 3: Create the App ─────────────────────────────────────────
    banner('Step 3 of 5 — Create a Facebook App');

    // Look for "Create App" button
    const createBtn = await page.$('text=Create App') || await page.$('[data-testid="create-app-button"]');
    if (createBtn) {
      log('Clicking "Create App"...');
      await createBtn.click();
      await page.waitForTimeout(2000);
    } else {
      log('Click "Create App" in the browser.');
      await pause('Press ENTER after clicking "Create App"...');
    }

    // Try to guide through the app creation flow
    log('In the browser:');
    log('  1. Select app type: "Other" (or "Business" if shown)');
    log('  2. Select "Business" for the app type');
    log('  3. App name: enter anything (e.g. "My Page Bot")');
    log('  4. Click "Create App"');
    log('');
    log('The browser is yours — complete the app creation flow.');

    await pause('Press ENTER once the app is created and you see the App Dashboard...');

    // ── Step 4: Add Facebook Login product ─────────────────────────────
    banner('Step 4 of 5 — Configure the App');

    // Navigate to Settings > Basic to get App ID and Secret
    log('Going to App Settings...');

    // Try to find the settings link
    const settingsLink = await page.$('a[href*="/settings/basic"]') || await page.$('text=Settings');
    if (settingsLink) {
      await settingsLink.click();
      await page.waitForTimeout(2000);
    }

    // Try sub-nav to Basic
    const basicLink = await page.$('a[href*="/settings/basic"]') || await page.$('text=Basic');
    if (basicLink) {
      await basicLink.click();
      await page.waitForTimeout(2000);
    }

    // If we couldn't auto-navigate, tell the user
    const currentUrl = page.url();
    if (!currentUrl.includes('/settings/basic')) {
      log('In the left sidebar, click: Settings > Basic');
      await pause('Press ENTER when you\'re on the Basic Settings page...');
    }

    // ── Step 5: Extract App ID and Secret ──────────────────────────────
    banner('Step 5 of 5 — Get App ID and Secret');

    // Try to read App ID from the page
    let appId = '';
    let appSecret = '';

    // App ID is usually in a visible field
    try {
      // Try common selectors for the App ID field
      const appIdInput = await page.$('input[value][readonly]') ||
                         await page.$('#app_id') ||
                         await page.$('[data-testid="app-id"]');
      if (appIdInput) {
        appId = await appIdInput.getAttribute('value') || '';
      }
    } catch {}

    // Also try to read it from the URL (apps/{appId}/settings)
    if (!appId) {
      const urlMatch = page.url().match(/\/apps\/(\d+)/);
      if (urlMatch) appId = urlMatch[1];
    }

    if (appId) {
      success(`Found App ID: ${appId}`);
    } else {
      log('Could not auto-detect the App ID.');
      appId = await ask('  Enter your App ID (shown at the top of the page): ');
    }

    // App Secret requires clicking "Show"
    log('For the App Secret:');
    log('  1. Find "App Secret" on the page');
    log('  2. Click "Show" next to it');
    log('  3. Facebook will ask for your password — enter it');
    log('  4. Copy the secret value');

    // Try to click Show button
    const showBtn = await page.$('text=Show') || await page.$('button:has-text("Show")');
    if (showBtn) {
      log('Clicking "Show" for App Secret...');
      await showBtn.click();
      await page.waitForTimeout(3000);

      // Check if password prompt appeared
      const passwordInput = await page.$('input[type="password"]');
      if (passwordInput) {
        log('Enter your Facebook password in the browser to reveal the secret.');
        await pause('Press ENTER after the secret is revealed...');
      }

      // Try to read the secret
      try {
        const secretInputs = await page.$$('input[type="text"]');
        for (const input of secretInputs) {
          const val = await input.getAttribute('value') || '';
          if (val && val.length > 20 && val !== appId) {
            appSecret = val;
            break;
          }
        }
      } catch {}
    }

    if (appSecret) {
      success(`Found App Secret: ${appSecret.substring(0, 6)}...`);
    } else {
      appSecret = await ask('  Paste your App Secret here: ');
    }

    // Validate
    if (!appId || !appSecret) {
      warn('Missing App ID or Secret. Cannot save.');
      await browser.close();
      rl.close();
      process.exit(1);
    }

    // ── Save to framework config ───────────────────────────────────────
    banner('Saving Configuration');
    log(`App ID:     ${appId}`);
    log(`App Secret: ${appSecret.substring(0, 6)}...`);

    try {
      const res = await fetch(`${API_BASE}/api/facebook-auth/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, appSecret }),
      });
      if (res.ok) {
        success('Credentials saved to the framework!');
      } else {
        warn('Could not save to API — saving locally instead.');
        saveLocally(appId, appSecret);
      }
    } catch {
      warn('API not reachable — saving locally.');
      saveLocally(appId, appSecret);
    }

    // ── Optional: Set up OAuth redirect ──────────────────────────────
    banner('Almost Done — One More Setting');
    log('For the login button to work, you need to add the OAuth redirect URL.');
    log('In the browser:');
    log('  1. In the left sidebar, click "Facebook Login" (add it if not there)');
    log('     Click "Add Product" > find "Facebook Login" > click "Set Up"');
    log('  2. Go to Facebook Login > Settings');
    log('  3. In "Valid OAuth Redirect URIs" add:');
    log(`     \x1b[1mhttp://localhost:35457/api/facebook-auth/callback\x1b[0m`);
    log('  4. Click "Save Changes"');

    await pause('Press ENTER when done (or skip for later)...');

    // ── Done ─────────────────────────────────────────────────────────
    banner('Setup Complete!');
    success(`App ID ${appId} is configured.`);
    success('Go to http://localhost:35457/api/facebook-auth/app to log in.');
    log('');
    log('The "Login with Facebook" button should now work.');
    log('');

    await ask('  Press ENTER to close the browser...');
    await browser.close();

  } catch (err) {
    console.error('\n  Error:', err.message);
    try { await browser.close(); } catch {}
  }

  rl.close();
}

function saveLocally(appId, appSecret) {
  const outputDir = join(process.cwd(), 'output');
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const secretsPath = join(outputDir, 'secrets.json');
  let secrets = {};
  try { secrets = JSON.parse(readFileSync(secretsPath, 'utf-8')); } catch {}
  secrets.facebookAppId = appId;
  secrets.facebookAppSecret = appSecret;
  writeFileSync(secretsPath, JSON.stringify(secrets, null, 2));
  success(`Saved to ${secretsPath}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
