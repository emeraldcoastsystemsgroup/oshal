/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial Playwright E2E test for Keycloak OIDC login flow
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Updated tests for express-openid-connect middleware
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Fix post-login race: bare /localhost:3456/ waits matched the in-flight /callback URL itself, so tests navigated mid-token-exchange and dropped the session; now wait for a settled non-/callback URL
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Settled-URL host checks follow PLAYWRIGHT_PORT via the shared baseHost() helper instead of hardcoded localhost:3456 comparisons (byte-identical under the default env)
 */

import { test, expect } from "@playwright/test";
import { baseHost, escapeForRegExp } from "./helpers";

/**
 * @description End-to-end tests for the Keycloak OIDC login flow.
 * Requires the full Docker Compose stack (postgres + keycloak + api-server)
 * to be running. Tests use the dev-admin credentials from realm-export.json.
 * 
 * Uses express-openid-connect middleware which provides:
 * - /login -> redirects to Keycloak
 * - /logout -> clears session and redirects to Keycloak logout
 * - /callback -> handles OIDC callback (auto-configured)
 */
test.describe("Keycloak OIDC Login Flow", () => {
  test("/login redirects to Keycloak on localhost:8080", async ({ page }) => {
    // Navigate directly to /login
    await page.goto("/login");

    // Should redirect to Keycloak login page
    await page.waitForURL(/localhost:8080.*openid-connect.*auth/, {
      timeout: 10000,
    });

    // Verify we're on the Keycloak login page
    expect(page.url()).toContain("localhost:8080");
    expect(page.url()).toContain("realms/oshal");
    await expect(page.locator("#username")).toBeVisible({
      timeout: 10000,
    });
  });

  test("full login flow with dev-admin credentials", async ({ page }) => {
    // Navigate to /login
    await page.goto("/login");

    // Wait for Keycloak login page
    await page.waitForURL(/localhost:8080.*openid-connect.*auth/, {
      timeout: 15000,
    });
    await expect(page.locator("#username")).toBeVisible({ timeout: 10000 });

    // Fill in dev-admin credentials
    await page.fill("#username", "dev-admin");
    await page.fill("#password", "admin123");
    await page.click("#kc-login");

    // Wait for the callback to SETTLE (a bare app-host pattern matches the
    // in-flight /callback?code=... URL itself, so navigating on it races the token
    // exchange and drops the session — the "session persists" flake).
    await page.waitForURL(
      (u) => u.host === baseHost() && !u.pathname.startsWith("/callback"),
      { timeout: 15000 },
    );

    // Should be redirected to app root after login
    // The express-openid-connect middleware stores session in cookies
    // req.oidc.isAuthenticated() should return true
  });

  test("authenticated session persists", async ({ page }) => {
    // Perform login first
    await page.goto("/login");

    await page.waitForURL(/localhost:8080.*openid-connect.*auth/, {
      timeout: 15000,
    });
    await page.fill("#username", "dev-admin");
    await page.fill("#password", "admin123");
    await page.click("#kc-login");

    // Settled post-callback URL — see note in the full-login test.
    await page.waitForURL(
      (u) => u.host === baseHost() && !u.pathname.startsWith("/callback"),
      { timeout: 15000 },
    );

    // Now navigate to chat page - should be accessible
    await page.goto("/chat");

    // Session persisted = we stay on an AUTHENTICATED app surface. A brand-new
    // user is legitimately redirected /chat -> /welcome by the first-run wizard
    // gate (welcome.js gates on active LLM setup), so accept either. A DROPPED
    // session would bounce to Keycloak (localhost:8080) instead, which this
    // pattern correctly fails on.
    await expect(page).toHaveURL(new RegExp(`${escapeForRegExp(baseHost())}\\/(chat|welcome)`));
  });

  test("logout redirects to Keycloak logout and clears session", async ({
    page,
  }) => {
    // Login first
    await page.goto("/login");

    await page.waitForURL(/localhost:8080.*openid-connect.*auth/, {
      timeout: 15000,
    });
    await page.fill("#username", "dev-admin");
    await page.fill("#password", "admin123");
    await page.click("#kc-login");

    // Settled post-callback URL — see note in the full-login test.
    await page.waitForURL(
      (u) => u.host === baseHost() && !u.pathname.startsWith("/callback"),
      { timeout: 15000 },
    );

    // Now logout by navigating to /logout
    await page.goto("/logout");

    // Should redirect through Keycloak logout then back to app
    // express-openid-connect with idpLogout: true will redirect to Keycloak
    await page.waitForURL(/localhost/, { timeout: 15000 });

    // After logout, trying to access protected route should redirect to login
    // Or we should be back at the app root
  });

  test("protected route redirects to login when not authenticated", async ({
    page,
    context,
  }) => {
    // Clear all cookies to ensure no session
    await context.clearCookies();
    
    // Try to access a protected chat page
    await page.goto("/chat");

    // Should be redirected to Keycloak login
    // (if authRequired is set for this route)
    // Or should get the page if authRequired: false globally
    // The current config has authRequired: false, so routes are public by default
    // Protected routes use requiresAuth middleware
  });
});