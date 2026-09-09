/**
 * Guards for the ESPN Fantasy connector.
 *
 * This credential deserves more care than an API key, and the guards reflect that. ESPN publishes
 * no OAuth for fantasy, so the only thing that authenticates a private league is a pair of ACCOUNT
 * SESSION cookies — unscoped, with no per-app revocation. The failure that actually costs something
 * is therefore not "the label is wrong": it is STORING A CREDENTIAL THAT CANNOT READ ANYTHING, or
 * storing half of one, because the user then believes their league is connected when it is not.
 *
 * So every test here is about failing closed: a malformed paste, a paste with either half missing,
 * a rejected cookie pair, and a network error must all return {email: null, id: null}, which is
 * what makes `POST /api/connect/:provider/token` answer "token rejected by provider" instead of
 * persisting it.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the connector is registered as a token connector in the 'media' category, the SWID:espn_s2 split, brace normalisation, both cookies actually sent, and fail-closed on a malformed paste, a rejected pair, and a network error.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The connectors page must offer BOTH fields. The card shipped with only a single token box, because the surface's two-field list is hardcoded and espn-fantasy was not in it — so there was nowhere to enter the SWID, and the pair the connector stores could never be formed from the page. Reported by the operator as the card being unusable.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAccount } from '@/app/routes/connector-account-lookup';
import { CONNECTOR_CATEGORY, PROVIDERS } from '@/app/routes/connector-provider-registry';

/** Replaces global fetch and records what the branch actually sent. */
function stubFetch(impl: (url: string, init?: RequestInit) => unknown): { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return impl(String(url), init);
  });
  return { calls };
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

afterEach(() => { vi.unstubAllGlobals(); });

describe('espn-fantasy connector registration', () => {
  it('is a TOKEN connector, which is what lets the paste route accept it at all', () => {
    // POST /api/connect/:provider/token 404s with "not a token connector" for anything else.
    const def = PROVIDERS['espn-fantasy'];
    expect(def).toBeDefined();
    expect(def.auth).toBe('token');
    expect(def.label).toBe('ESPN Fantasy');
  });

  it('declares no OAuth endpoints, because ESPN publishes none for fantasy', () => {
    const def = PROVIDERS['espn-fantasy'];
    expect(def.authUrl).toBe('');
    expect(def.tokenUrl).toBe('');
    expect(def.scopes).toEqual([]);
  });

  it('is shelved under media, not finance — it reads a league, it does not touch money', () => {
    expect(CONNECTOR_CATEGORY['espn-fantasy']).toBe('media');
  });
});

describe('espn-fantasy credential validation', () => {
  it('sends BOTH cookies — one of them alone authenticates nothing', async () => {
    const { calls } = stubFetch(() => ok({ displayName: 'Roger' }));
    await fetchAccount('espn-fantasy', { access_token: '{ABC-123}:SWID_S2_VALUE' });
    expect(calls).toHaveLength(1);
    const cookie = String((calls[0].init?.headers as Record<string, string>).Cookie);
    expect(cookie).toContain('SWID={ABC-123}');
    expect(cookie).toContain('espn_s2=SWID_S2_VALUE');
  });

  it('labels the connection from the fan profile and keys it by the braced SWID', async () => {
    stubFetch(() => ok({ displayName: 'Roger' }));
    const account = await fetchAccount('espn-fantasy', { access_token: '{ABC-123}:s2value' });
    expect(account).toEqual({ email: 'ESPN Fantasy · Roger', id: '{ABC-123}' });
  });

  it('normalises an UNBRACED SWID, so a paste from either place works', async () => {
    const { calls } = stubFetch(() => ok({ displayName: 'Roger' }));
    const account = await fetchAccount('espn-fantasy', { access_token: 'ABC-123:s2value' });
    expect(account.id).toBe('{ABC-123}');
    expect(String((calls[0].init?.headers as Record<string, string>).Cookie)).toContain('SWID={ABC-123}');
  });

  it('still connects when the profile carries no display name', async () => {
    stubFetch(() => ok({}));
    const account = await fetchAccount('espn-fantasy', { access_token: '{ABC-123}:s2value' });
    expect(account).toEqual({ email: 'ESPN Fantasy', id: '{ABC-123}' });
  });

  it('FAILS CLOSED when ESPN rejects the pair — the real cost is a credential that reads nothing', async () => {
    // An unknown SWID or an expired espn_s2 both answer 404 {"message":"fan not found"} (verified
    // live 2026-09-08). Returning nulls is what makes the paste route refuse to persist it.
    stubFetch(() => ({ ok: false, status: 404, json: async () => ({ message: 'fan not found' }) }));
    expect(await fetchAccount('espn-fantasy', { access_token: '{ABC-123}:stale' })).toEqual({ email: null, id: null });
  });

  it('fails closed on a network error rather than throwing into the paste route', async () => {
    stubFetch(() => { throw new Error('ENOTFOUND'); });
    expect(await fetchAccount('espn-fantasy', { access_token: '{ABC-123}:s2value' })).toEqual({ email: null, id: null });
  });

  it.each([
    ['no separator at all', '{ABC-123}'],
    ['empty espn_s2', '{ABC-123}:'],
    ['empty SWID', ':s2value'],
    ['whitespace-only espn_s2', '{ABC-123}:   '],
    ['empty string', ''],
  ])('refuses a malformed paste (%s) WITHOUT calling ESPN', async (_label, secret) => {
    const { calls } = stubFetch(() => ok({ displayName: 'Roger' }));
    expect(await fetchAccount('espn-fantasy', { access_token: secret })).toEqual({ email: null, id: null });
    expect(calls).toHaveLength(0);
  });

  it('splits on the FIRST colon, so an espn_s2 containing a colon survives intact', async () => {
    const { calls } = stubFetch(() => ok({ displayName: 'Roger' }));
    await fetchAccount('espn-fantasy', { access_token: '{ABC-123}:aaa:bbb:ccc' });
    expect(String((calls[0].init?.headers as Record<string, string>).Cookie)).toContain('espn_s2=aaa:bbb:ccc');
  });
});

describe('the connectors page can actually enter this credential', () => {
  // The surface decides which token connectors get a second field from a HARDCODED list, so a
  // registry entry alone is not enough to make a two-value connector enterable. This reads the
  // shipped page rather than a copy of the list: the bug was that the page and the registry
  // disagreed, and a test written against a re-declared constant would have agreed with itself.
  const page = readFileSync(resolve(__dirname, '../../src/api/utilities.html'), 'utf8');

  it('OFFERS BOTH BOXES — one box means the SWID has nowhere to go and the paste is half a credential', () => {
    const twoField = page.match(/var TWO_FIELD_TOKEN = \{[\s\S]*?\};/)?.[0] ?? '';
    expect(twoField).toContain("'espn-fantasy'");
    expect(twoField).toMatch(/SWID/);
  });

  it('names the two cookies instead of calling them an API token, which ESPN does not issue', () => {
    // A user told to paste a "Personal Access Token" goes looking for an ESPN developer key. There
    // is none, for anyone, ever — so the generic wording sends them somewhere that does not exist.
    expect(page).toMatch(/var TOKEN_FIELD_LABEL = \{[^}]*'espn-fantasy'/);
    expect(page).toContain('espn_s2 cookie value');
  });

  it('says on the card that these are account session cookies with no per-app revocation', () => {
    // The one thing a user cannot discover for themselves, and the reason this connector is not
    // interchangeable with an API key. It belongs where the paste happens, not only in an ADR.
    const note = page.slice(page.indexOf('var TOKEN_NOTE'), page.indexOf('var TOKEN_NOTE') + 1200);
    expect(note).toMatch(/account session cookies/i);
    expect(note).toMatch(/revoke|revocation/i);
  });
});
