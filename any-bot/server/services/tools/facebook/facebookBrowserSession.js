/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Facebook Browser Session Manager
 *
 * Uses Playwright to log into Facebook, save the browser session (cookies),
 * and reuse it for subsequent API-like interactions. No Facebook App
 * registration required — just a regular Facebook login.
 *
 * Sessions are persisted to disk so they survive restarts.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const pino = require('pino');

const logger = pino({ name: 'facebook-browser-session' });

const SESSION_DIR = process.env.FB_SESSION_DIR || path.join(process.cwd(), 'output', 'facebook-session');
const COOKIES_FILE = path.join(SESSION_DIR, 'cookies.json');
const PROFILE_FILE = path.join(SESSION_DIR, 'profile.json');

/**
 * Log into Facebook with email/password using Playwright.
 * Saves cookies to disk for reuse.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{success: boolean, userName?: string, userId?: string, error?: string, needsAction?: boolean, message?: string}>}
 */
async function login(email, password) {
  let browser;
  try {
    const { chromium } = require('playwright');

    // Ensure session directory exists
    if (!fs.existsSync(SESSION_DIR)) {
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    }

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-US',
    });

    const page = await context.newPage();

    // Go to Facebook login
    await page.goto('https://www.facebook.com/login', { waitUntil: 'networkidle' });

    // Accept cookies dialog if present
    try {
      const cookieBtn = await page.$('[data-cookiebanner="accept_button"]');
      if (cookieBtn) await cookieBtn.click();
    } catch {}

    // Fill login form
    await page.fill('#email', email);
    await page.fill('#pass', password);
    await page.click('[name="login"]');

    // Wait for navigation
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    const currentUrl = page.url();

    // Check for 2FA / checkpoint
    if (currentUrl.includes('/checkpoint') || currentUrl.includes('/two_step_verification')) {
      logger.info('Facebook requires additional verification (2FA/checkpoint)');

      // Save what we have so far
      const cookies = await context.cookies();
      fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));

      await browser.close();
      return {
        success: false,
        needsAction: true,
        message: 'Facebook requires two-factor authentication. Complete verification in your browser, then try logging in again.',
      };
    }

    // Check for login failure
    if (currentUrl.includes('/login') || currentUrl.includes('login_attempt')) {
      const errorText = await page.$eval('#error_box, [data-testid="login_error"]', el => el.textContent).catch(() => '');
      await browser.close();
      return {
        success: false,
        error: errorText || 'Login failed — check your email and password',
      };
    }

    // Login succeeded — extract user info
    let userName = '';
    let userId = '';

    try {
      // Try to get the user's name from the page
      await page.goto('https://www.facebook.com/me', { waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);

      // Get name from the profile page title or h1
      userName = await page.title();
      // Facebook title is usually "FirstName LastName | Facebook"
      if (userName.includes('|')) {
        userName = userName.split('|')[0].trim();
      }

      // Get user ID from URL
      const profileUrl = page.url();
      const idMatch = profileUrl.match(/facebook\.com\/(?:profile\.php\?id=)?(\d+)/);
      if (idMatch) userId = idMatch[1];

      // Also try to get from page source
      if (!userId) {
        const content = await page.content();
        const uidMatch = content.match(/"userID":"(\d+)"/);
        if (uidMatch) userId = uidMatch[1];
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'Could not extract user profile info');
    }

    // Try to get pages the user manages
    let pages = [];
    try {
      await page.goto('https://www.facebook.com/pages/?category=your_pages', { waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);
      // Extract page names from the listing
      const pageLinks = await page.$$eval('a[href*="/pages/"]', links =>
        links.map(l => ({ name: l.textContent?.trim(), href: l.href }))
          .filter(l => l.name && l.name.length > 0 && l.name.length < 100)
      );
      pages = pageLinks.slice(0, 10);
    } catch (err) {
      logger.debug({ err: err.message }, 'Could not list pages');
    }

    // Save cookies
    const cookies = await context.cookies();
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));

    // Save profile
    const profile = { userName, userId, pages, loginTime: Date.now(), email };
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2));

    logger.info({ userName, userId, pageCount: pages.length }, 'Facebook login successful');

    await browser.close();

    return {
      success: true,
      userName,
      userId,
      pages,
    };
  } catch (err) {
    logger.error({ err: err.message }, 'Facebook login failed');
    try { if (browser) await browser.close(); } catch {}
    return { success: false, error: err.message };
  }
}

/**
 * Check if we have a saved session.
 *
 * @returns {{connected: boolean, userName?: string, userId?: string, pages?: Array}}
 */
function getSessionStatus() {
  if (!fs.existsSync(COOKIES_FILE) || !fs.existsSync(PROFILE_FILE)) {
    return { connected: false };
  }
  try {
    const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf-8'));
    return {
      connected: true,
      userName: profile.userName,
      userId: profile.userId,
      pages: profile.pages || [],
      loginTime: profile.loginTime,
    };
  } catch {
    return { connected: false };
  }
}

/**
 * Clear saved session.
 */
function clearSession() {
  try { fs.unlinkSync(COOKIES_FILE); } catch {}
  try { fs.unlinkSync(PROFILE_FILE); } catch {}
  logger.info('Facebook session cleared');
}

/**
 * Get saved cookies for reuse in other Playwright contexts.
 *
 * @returns {Array|null}
 */
function getSavedCookies() {
  if (!fs.existsSync(COOKIES_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf-8'));
  } catch { return null; }
}

/**
 * @description Public API of the Facebook browser-session manager. Exposes the
 * cookie-based login flow plus helpers to inspect, clear, and reuse a persisted
 * Facebook session, so callers can drive Facebook without a registered App.
 */
module.exports = { login, getSessionStatus, clearSession, getSavedCookies };
