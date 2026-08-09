/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the guest-tier disclosure boundary. Found live on 2026-08-09: an unauthenticated visitor who clicked "Continue as guest" could open ?app=intelligent-trades and read the DEPLOYMENT'S trading configuration (TRADING_CORE_SYMBOLS / ROTATION_TOPN / RISK_POSTURE, rendered verbatim in the surface's "ENV DEFAULTS" strip) plus a twenty-position book that was not theirs. seedGuestDemoData() plants per-sub demo rows and is itself unit-tested, but NOTHING asserted what a guest actually SEES per app — so a surface reading process.env and an unscoped book passed every gate. This asserts the invariant the seed implies: a freshly minted guest sees only what the seed gave that guest.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * Mints a fresh guest and returns a request context carrying its cookie. Each call is a NEW
 * identity — which is the whole point: a brand-new guest has no history, so anything it can see
 * beyond the seed came from somewhere it should not have.
 */
async function startGuest(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/guest/start', { maxRedirects: 0 });
  expect([302, 303]).toContain(res.status());
  const cookies = res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
  const guestCookie = cookies.map((c) => c.value).find((v) => /guest/i.test(v));
  expect(guestCookie, 'POST /api/guest/start must set a guest cookie').toBeTruthy();
  return guestCookie!.split(';')[0];
}

test.describe('guest tier discloses only what the seed planted', () => {
  test.setTimeout(120_000);

  test('a freshly minted guest holds no book it was not seeded', async ({ request, baseURL }) => {
    const cookie = await startGuest(request);
    // The endpoint the trading surface actually reads its book from — verified against the live
    // deployment. Probing a guessed path is how a guard passes while the bug is still there.
    const res = await request.get('/api/trading/ledger', { headers: { cookie } });

    // A 401/403/404 is a PASS: the boundary held, or the surface is not guest-reachable at all.
    if (!res.ok()) {
      expect([401, 403, 404]).toContain(res.status());
      return;
    }

    const body = await res.json().catch(() => ({})) as {
      positions?: unknown[]; orders?: unknown[]; account?: Record<string, unknown> | null;
    };
    const positions = Array.isArray(body.positions) ? body.positions : [];
    const account = body.account && typeof body.account === 'object' ? body.account : null;

    // seedGuestDemoData() plants finance rows and tickets. It plants NO brokerage account and NO
    // positions — so anything here belongs to whoever actually runs this deployment.
    expect(
      positions.length,
      `a brand-new guest at ${baseURL} was handed ${positions.length} positions`,
    ).toBe(0);
    expect(
      account && (account.equity ?? account.cash ?? account.buyingPower) != null ? 'disclosed' : 'none',
      'a brand-new guest was handed a brokerage account balance',
    ).toBe('none');
  });

  test('no guest-reachable surface hands back the deployment\'s own configuration', async ({ request }) => {
    const cookie = await startGuest(request);

    // Config that describes how THIS deployment is run. None of it is the guest's, none of it is
    // seeded, and all of it was visible in the surface strip that exposed the bug.
    const forbiddenKeys = [
      'coreSymbols', 'core_symbols', 'rotationTopN', 'rotation_topn',
      'riskPosture', 'risk_posture', 'takeProfitPct', 'universeCount',
    ];

    const probes = ['/api/trading/ledger', '/api/trading/status', '/api/trading/strategy-params', '/api/trading/performance'];
    const leaks: string[] = [];

    for (const path of probes) {
      const res = await request.get(path, { headers: { cookie } });
      if (!res.ok()) continue;                       // gated or absent — the boundary held
      const text = await res.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { continue; }
      const flat = JSON.stringify(parsed);
      for (const key of forbiddenKeys) {
        // A key present with a NON-empty value is disclosure; an empty/null field is not.
        const re = new RegExp(`"${key}"\\s*:\\s*(?!null|""|\\[\\]|\\{\\})[^,}\\]]+`);
        if (re.test(flat)) leaks.push(`${path} → ${key}`);
      }
    }

    expect(
      leaks,
      'a guest received deployment configuration; guest tier is a read grant over SEEDED data, '
      + 'never a window onto how the box itself is configured',
    ).toEqual([]);
  });

  test('the app list a guest receives carries no owner identity', async ({ request }) => {
    // Found alongside the trading leak: /api/swarm/apps answers a guest with `ownerSub` populated
    // for the apps that have an owner. That is the account holder's OIDC subject — a stable
    // identifier for a real person, handed to an anonymous visitor. Deliberately NOT a skip-able
    // test: if the endpoint stops answering guests at all, that is the boundary holding, and the
    // early return below records it as a pass rather than pretending the guard ran.
    const cookie = await startGuest(request);
    const res = await request.get('/api/swarm/apps', { headers: { cookie } });
    if (!res.ok()) {
      expect([401, 403, 404]).toContain(res.status());
      return;
    }

    const body = await res.json().catch(() => ({})) as { apps?: Array<Record<string, unknown>> };
    const apps = Array.isArray(body.apps) ? body.apps : [];
    expect(apps.length, 'a guest received no app list to check').toBeGreaterThan(0);

    const leaking = apps.filter((a) => a.ownerSub || a.tenantId).map((a) => String(a.name));
    expect(
      leaking,
      'a guest can read the owning account\'s identity from the app catalog; ownerSub/tenantId '
      + 'must be stripped for callers who are not that owner',
    ).toEqual([]);
  });
});
