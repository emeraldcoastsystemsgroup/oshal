/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial Playwright tests for tool management UI
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | BASE_URL fallback follows PLAYWRIGHT_PORT via the shared baseOrigin() helper instead of a hardcoded localhost:3456; BASE_URL env still wins when set (byte-identical under the default env)
 */

import { test, expect } from '@playwright/test';
import { baseOrigin } from './helpers';

/**
 * @description Playwright test suite for Tool Management UI pages.
 * Validates functionality, correctness, and technical implementation
 * of the three admin pages: Catalog, Agent Config, Installation.
 */

const BASE_URL = process.env.BASE_URL || baseOrigin();

// ── Cockpit Tool Management (Glassmorphism UI) ────────────────────────────

test.describe('Cockpit Tool Management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/cockpit/index.html`);
  });

  test('should load the catalog page with correct title', async ({ page }) => {
    await expect(page).toHaveTitle(/Tool Catalog/);
  });

  test('should display navigation header with three links', async ({ page }) => {
    const nav = page.locator('.tools-header__nav');
    await expect(nav).toBeVisible();
    const links = nav.locator('.tools-header__nav-link');
    await expect(links).toHaveCount(3);
    await expect(links.nth(0)).toHaveText('Catalog');
    await expect(links.nth(1)).toHaveText('Agent Config');
    await expect(links.nth(2)).toHaveText('Installation');
  });

  test('should highlight Catalog as active nav link', async ({ page }) => {
    const activeLink = page.locator('.tools-header__nav-link--active');
    await expect(activeLink).toHaveText('Catalog');
  });

  test('should have stats bar with total and showing counts', async ({ page }) => {
    await expect(page.locator('#total-count')).toBeVisible();
    await expect(page.locator('#filtered-count')).toBeVisible();
  });

  test('should have search input', async ({ page }) => {
    const searchInput = page.locator('#search-input');
    await expect(searchInput).toBeVisible();
    await expect(searchInput).toHaveAttribute('placeholder', /Search tools/);
  });

  test('should have filter dropdowns for category, type, auth group, and enabled', async ({ page }) => {
    await expect(page.locator('#filter-category')).toBeVisible();
    await expect(page.locator('#filter-type')).toBeVisible();
    await expect(page.locator('#filter-auth-group')).toBeVisible();
    await expect(page.locator('#filter-enabled')).toBeVisible();
  });

  test('should have category filter with correct options', async ({ page }) => {
    const options = page.locator('#filter-category option');
    await expect(options).toHaveCount(8); // All + 7 categories
  });

  test('should have view toggle buttons for grid and list', async ({ page }) => {
    await expect(page.locator('#view-grid')).toBeVisible();
    await expect(page.locator('#view-list')).toBeVisible();
  });

  test('should have grid view active by default', async ({ page }) => {
    await expect(page.locator('#view-grid')).toHaveClass(/view-toggle__btn--active/);
  });

  test('should have Register Tool button', async ({ page }) => {
    const btn = page.locator('button:has-text("Register Tool")');
    await expect(btn).toBeVisible();
  });

  test('should have tool detail modal (hidden by default)', async ({ page }) => {
    const modal = page.locator('#tool-detail-modal');
    await expect(modal).toBeAttached();
    await expect(modal).not.toHaveClass(/modal-overlay--open/);
  });

  test('should have tool form modal (hidden by default)', async ({ page }) => {
    const modal = page.locator('#tool-form-modal');
    await expect(modal).toBeAttached();
    await expect(modal).not.toHaveClass(/modal-overlay--open/);
  });

  test('should open register form modal when button clicked', async ({ page }) => {
    await page.locator('button:has-text("Register Tool")').click();
    const modal = page.locator('#tool-form-modal');
    await expect(modal).toHaveClass(/modal-overlay--open/);
    await expect(page.locator('#tool-form-title')).toHaveText('Register New Tool');
  });

  test('should close form modal when cancel clicked', async ({ page }) => {
    await page.locator('button:has-text("Register Tool")').click();
    await expect(page.locator('#tool-form-modal')).toHaveClass(/modal-overlay--open/);
    await page.locator('#tool-form-modal button:has-text("Cancel")').click();
    await expect(page.locator('#tool-form-modal')).not.toHaveClass(/modal-overlay--open/);
  });

  test('should have form fields for tool creation', async ({ page }) => {
    await page.locator('button:has-text("Register Tool")').click();
    await expect(page.locator('#form-name')).toBeVisible();
    await expect(page.locator('#form-display-name')).toBeVisible();
    await expect(page.locator('#form-type')).toBeVisible();
    await expect(page.locator('#form-category')).toBeVisible();
    await expect(page.locator('#form-version')).toBeVisible();
    await expect(page.locator('#form-description')).toBeVisible();
    await expect(page.locator('#form-auth-group')).toBeVisible();
    await expect(page.locator('#form-default-auth-mode')).toBeVisible();
    await expect(page.locator('#form-skills')).toBeVisible();
    await expect(page.locator('#form-tags')).toBeVisible();
  });

  test('should load scripts in correct order', async ({ page }) => {
    const scripts = page.locator('script[src]');
    await expect(scripts).toHaveCount(3);
    await expect(scripts.nth(0)).toHaveAttribute('src', 'js/api-client.js');
    await expect(scripts.nth(1)).toHaveAttribute('src', 'js/shared.js');
    await expect(scripts.nth(2)).toHaveAttribute('src', 'js/catalog.js');
  });

  test('should display presentron and rag-ingestion in the tool catalog', async ({ page }) => {
    const presentron = page.locator('.tool-card:has-text("Presentron")');
    const rag = page.locator('.tool-card:has-text("RAG Ingestion")');
    await expect(presentron).toBeVisible();
    await expect(rag).toBeVisible();
    await expect(presentron).toContainText('agent-integration');
    await expect(rag).toContainText('agent-integration');
  });
});

// ── Agent Tool Configuration Page ──────────────────────────────────────────

test.describe('Cockpit Agent Tool Configuration', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/cockpit/index.html#agent-tools`);
  });

  test('should load the agent tools page with correct title', async ({ page }) => {
    await expect(page).toHaveTitle(/Agent Tool Configuration/);
  });

  test('should highlight Agent Config as active nav link', async ({ page }) => {
    const activeLink = page.locator('.tools-header__nav-link--active');
    await expect(activeLink).toHaveText('Agent Config');
  });

  test('should have agent selector dropdown', async ({ page }) => {
    await expect(page.locator('#agent-select')).toBeVisible();
  });

  test('should have bulk operation controls', async ({ page }) => {
    await expect(page.locator('#bulk-auth-group')).toBeVisible();
    await expect(page.locator('#bulk-auth-mode')).toBeVisible();
    await expect(page.locator('button:has-text("Apply Bulk")')).toBeVisible();
  });

  test('should have stats cards for auth mode counts', async ({ page }) => {
    await expect(page.locator('#stats-total')).toBeVisible();
    await expect(page.locator('#stats-auto')).toBeVisible();
    await expect(page.locator('#stats-ask')).toBeVisible();
    await expect(page.locator('#stats-off')).toBeVisible();
  });

  test('should have tools container for assignment table', async ({ page }) => {
    await expect(page.locator('#agent-tools-container')).toBeVisible();
  });

  test('should have selector composition display', async ({ page }) => {
    await expect(page.locator('#selector-display')).toBeVisible();
  });

  test('should have bulk auth group dropdown with correct options', async ({ page }) => {
    const options = page.locator('#bulk-auth-group option');
    await expect(options).toHaveCount(9); // All Groups + 8 groups
  });

  test('should load scripts in correct order', async ({ page }) => {
    const scripts = page.locator('script[src]');
    await expect(scripts).toHaveCount(3);
    await expect(scripts.nth(0)).toHaveAttribute('src', 'js/api-client.js');
    await expect(scripts.nth(1)).toHaveAttribute('src', 'js/shared.js');
    await expect(scripts.nth(2)).toHaveAttribute('src', 'js/agent-tools.js');
  });

  test('should display presentron and rag-ingestion in agent tool assignment table', async ({ page }) => {
    const presentron = page.locator('tr:has-text("Presentron")');
    const rag = page.locator('tr:has-text("RAG Ingestion")');
    await expect(presentron).toBeVisible();
    await expect(rag).toBeVisible();
    await expect(presentron).toContainText('agent-integration');
    await expect(rag).toContainText('agent-integration');
  });
});

// ── Installation Dashboard Page ────────────────────────────────────────────

test.describe('Cockpit Installation Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/cockpit/index.html#installation`);
  });

  test('should load the installation page with correct title', async ({ page }) => {
    await expect(page).toHaveTitle(/Installation Dashboard/);
  });

  test('should highlight Installation as active nav link', async ({ page }) => {
    const activeLink = page.locator('.tools-header__nav-link--active');
    await expect(activeLink).toHaveText('Installation');
  });

  test('should have installation stats cards', async ({ page }) => {
    await expect(page.locator('#stats-total-install')).toBeVisible();
    await expect(page.locator('#stats-installed')).toBeVisible();
    await expect(page.locator('#stats-not-installed')).toBeVisible();
    await expect(page.locator('#stats-errors')).toBeVisible();
  });

  test('should have category filter', async ({ page }) => {
    await expect(page.locator('#filter-install-category')).toBeVisible();
    const options = page.locator('#filter-install-category option');
    await expect(options).toHaveCount(8); // All + 7 categories
  });

  test('should have Verify All button', async ({ page }) => {
    await expect(page.locator('button:has-text("Verify All")')).toBeVisible();
  });

  test('should have installation matrix container', async ({ page }) => {
    await expect(page.locator('#install-matrix-container')).toBeVisible();
  });

  test('should have logs viewer', async ({ page }) => {
    await expect(page.locator('#install-logs')).toBeVisible();
  });

  test('should have Clear Logs button', async ({ page }) => {
    await expect(page.locator('button:has-text("Clear Logs")')).toBeVisible();
  });

  test('should load scripts in correct order', async ({ page }) => {
    const scripts = page.locator('script[src]');
    await expect(scripts).toHaveCount(3);
    await expect(scripts.nth(0)).toHaveAttribute('src', 'js/api-client.js');
    await expect(scripts.nth(1)).toHaveAttribute('src', 'js/shared.js');
    await expect(scripts.nth(2)).toHaveAttribute('src', 'js/installation.js');
  });
});

// ── Cross-Page Navigation ──────────────────────────────────────────────────

test.describe('Cockpit Cross-Page Navigation', () => {
  test('should navigate from Catalog to Agent Config', async ({ page }) => {
    await page.goto(`${BASE_URL}/cockpit/index.html`);
    await page.locator('.tools-header__nav-link:has-text("Agent Config")').click();
    await expect(page).toHaveURL(/#agent-tools/);
  });

  test('should navigate from Catalog to Installation', async ({ page }) => {
    await page.goto(`${BASE_URL}/cockpit/index.html`);
    await page.locator('.tools-header__nav-link:has-text("Installation")').click();
    await expect(page).toHaveURL(/#installation/);
  });

  test('should navigate from Agent Config to Catalog', async ({ page }) => {
    await page.goto(`${BASE_URL}/cockpit/index.html#agent-tools`);
    await page.locator('.tools-header__nav-link:has-text("Catalog")').click();
    await expect(page).toHaveURL(/index\.html$/);
  });
});

// ── Responsive Design ──────────────────────────────────────────────────────

test.describe('Cockpit Responsive Design', () => {
  test('catalog page should be responsive at mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${BASE_URL}/cockpit/index.html`);
    await expect(page.locator('.tools-header')).toBeVisible();
    await expect(page.locator('#search-input')).toBeVisible();
    await expect(page.locator('#tools-container')).toBeVisible();
  });

  test('agent-tools page should be responsive at tablet viewport', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto(`${BASE_URL}/cockpit/index.html#agent-tools`);
    await expect(page.locator('.tools-header')).toBeVisible();
    // Update selector as needed for cockpit agent tools
  });
});
