/**
 * Guards for the Yahoo Mail token connector's registration, connect-time validation and card.
 *
 * The failure that costs something is storing a secret that cannot sign in, or storing something
 * other than the two values the closed schema allows. So the paste route's validation
 * (fetchAccount → probeYahooLogin) must refuse a malformed paste WITHOUT opening a socket, and the
 * connectors page must offer both fields so the pair can be formed at all. The successful LOGIN
 * against a real IMAP responder is covered in imap-mail-reader.spec.ts.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: token connector in the email category with no OAuth endpoints, an app-password help page, fail-closed validation of malformed pastes before any HTTP request, the two-field card, and the Test Lab card's registration.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAccount } from '@/app/routes/connector-account-lookup';
import { CONNECTOR_CATEGORY, PROVIDERS } from '@/app/routes/connector-provider-registry';
import { CONNECTOR_OAUTH_SCENARIOS } from '@/app/routes/test-lab-connector-scenarios';

afterEach(() => { vi.unstubAllGlobals(); });

describe('yahoo connector registration', () => {
  it('is a token connector with no OAuth endpoints, shelved under email', () => {
    const def = PROVIDERS.yahoo;
    expect(def).toBeDefined();
    expect(def.auth).toBe('token');
    expect(def.label).toBe('Yahoo Mail');
    expect([def.authUrl, def.tokenUrl, def.scopes]).toEqual(['', '', []]);
    expect(def.tokenHelpUrl).toBe('https://login.yahoo.com/account/security/app-passwords');
    expect(CONNECTOR_CATEGORY.yahoo).toBe('email');
  });
});

describe('connect-time validation fails closed', () => {
  it('refuses a paste outside address:app-password before any HTTP request (the no-socket proof is the loopback spec)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    for (const secret of ['', 'reader@yahoo.example.com', 'reader@yahoo.example.com:short',
      'imap.evil.example.com:993:abcdefghijklmnop', 'reader@yahoo.example.com:abcdefghijklmnop\r\nA1 LOGOUT']) {
      expect(await fetchAccount('yahoo', { access_token: secret }), secret).toEqual({ email: null, id: null });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the connectors page can enter this credential', () => {
  const page = readFileSync(resolve(__dirname, '../../src/api/utilities.html'), 'utf8');

  it('offers the address box and names the app password', () => {
    const twoField = page.match(/var TWO_FIELD_TOKEN = \{[\s\S]*?\};/)?.[0] ?? '';
    expect(twoField).toMatch(/yahoo: 'Yahoo email address'/);
    expect(page).toMatch(/var TOKEN_FIELD_LABEL = \{[^}]*yahoo: 'Yahoo app password/);
  });

  it('tells the user to use an app password, never the account password', () => {
    const note = page.match(/var TOKEN_NOTE = \{[\s\S]*?\n\};/)?.[0] ?? '';
    expect(note).toMatch(/yahoo: 'Use a Yahoo app password, never your Yahoo password/);
  });
});

describe('the Test Lab card', () => {
  it('registers the Yahoo scenario with suites that exist', () => {
    const scenario = CONNECTOR_OAUTH_SCENARIOS.find((s) => s.id === 'yahoo-mail-connector');
    expect(scenario?.steps.map((step) => step.id)).toEqual(['private-token']);
    const paths = scenario?.regressionTests?.map((t) => t.path) ?? [];
    expect(paths).toEqual(['tests/unit/imap-mail-reader.spec.ts', 'tests/unit/connector-yahoo.spec.ts']);
    for (const suite of paths) expect(existsSync(resolve(__dirname, '../..', suite)), suite).toBe(true);
  });
});
