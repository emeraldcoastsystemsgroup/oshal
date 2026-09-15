/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the ESPN "Log in + push" capture: exactly two cookies are read out of a jar full of them, a half-signed-in jar yields nothing rather than half a credential, the SWID normalises to the braced form the fantasy API expects, the body splits back into the same pair the Sports Edge package reads, the destination is the connector route under the same plain-http rule as a vendor login, and the connector's own success shape classifies as adopted.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pins the sign-in window's entry URL to ESPN's own `/login` page with a returnURL back to the Fantasy home (BACKLOG: the window used to open the Fantasy home, whose first control a user reaches for is dead in the node's window), and holds the package to keeping the live check (`npm run test:espn-login`) that loads that URL in a real window on a fresh profile.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ESPN_TARGET,
  classifyPushResponse,
  espnImportBody,
  isPushableLogin,
  readEspnCookies,
  swarmBaseUrl,
} from '../../packages/oshal-chat/src/main/login-push-core';

/** A realistic jar: ESPN sets dozens of cookies and only two of them are the credential. */
const JAR = [
  { name: 'espnAuth', value: '{"swid":"decoy"}' },
  { name: 's_ecid', value: 'MCMID|123' },
  { name: 'SWID', value: '{1A2B3C4D-0000-4444-8888-9F9F9F9F9F9F}' },
  { name: 'espn_s2', value: 'AEBxyz%2Fabc%3D%3D' },
  { name: 'region', value: 'ccpa' },
];

describe('@oshal/chat ESPN Fantasy cookie capture', () => {
  it('reads exactly the two cookies that are the credential, out of a jar full of decoys', () => {
    expect(readEspnCookies(JAR)).toEqual({
      swid: '{1A2B3C4D-0000-4444-8888-9F9F9F9F9F9F}',
      espnS2: 'AEBxyz%2Fabc%3D%3D',
    });
  });

  it('YIELDS NOTHING UNTIL BOTH HALVES EXIST — half a credential is not a credential', () => {
    // The window polls a jar that fills in over several redirects. Pushing at the first sighting of
    // SWID would store a connection that authenticates nothing and reports itself as connected.
    expect(readEspnCookies([{ name: 'SWID', value: '{abc}' }])).toBeNull();
    expect(readEspnCookies([{ name: 'espn_s2', value: 'AEB' }])).toBeNull();
    expect(readEspnCookies([])).toBeNull();
    expect(readEspnCookies([{ name: 'SWID', value: '   ' }, { name: 'espn_s2', value: 'AEB' }])).toBeNull();
  });

  it('normalises the SWID to the braced form, however the jar spelled it', () => {
    const bare = readEspnCookies([{ name: 'SWID', value: 'ABC-123' }, { name: 'espn_s2', value: 'AEB' }]);
    expect(bare?.swid).toBe('{ABC-123}');
    expect(readEspnCookies([{ name: 'SWID', value: '{ABC-123}' }, { name: 'espn_s2', value: 'AEB' }])?.swid)
      .toBe('{ABC-123}');
  });

  it('the stored secret splits back into the SAME pair the package reads at use', () => {
    const body = espnImportBody(readEspnCookies(JAR)!);
    // The connector route stores `email:token`; sports-edge splits on the FIRST colon. A braced GUID
    // contains none, so this round-trips — the guard is here because a change to either half alone
    // would produce a credential that is stored happily and rejected by ESPN forever after.
    const stored = `${body.email}:${body.token}`;
    const swid = stored.slice(0, stored.indexOf(':'));
    const espnS2 = stored.slice(stored.indexOf(':') + 1);
    expect(swid).toBe('{1A2B3C4D-0000-4444-8888-9F9F9F9F9F9F}');
    expect(espnS2).toBe('AEBxyz%2Fabc%3D%3D');
  });

  it('pushes to the connector route, and stays out of the vendor-login union', () => {
    expect(ESPN_TARGET.importPath).toBe('/api/connect/espn-fantasy/token');
    expect(ESPN_TARGET.cookieDomain).toBe('.espn.com');
    // Not defaultSession: a swarm sign-out clears that jar, which would silently log the machine out
    // of ESPN as a side effect of an unrelated action.
    expect(ESPN_TARGET.partition).toMatch(/^persist:/);
    expect(isPushableLogin(ESPN_TARGET.id)).toBe(false);
  });

  it('obeys the same plain-http rule as a vendor login — a session cookie is no less a credential', () => {
    expect(swarmBaseUrl({ controlPlaneUrl: 'http://oshal.example.com' })).toMatchObject({ ok: false, reason: 'plain_http_public' });
    expect(swarmBaseUrl({ controlPlaneUrl: 'http://192.168.50.20:35457' })).toMatchObject({ ok: true });
  });

  it('classifies the connector route’s own answers, which name the account differently', () => {
    // The vendor import routes answer {email}; the connector token route answers {account}. One
    // classifier serves both, so the success message is not blank on the ESPN path.
    expect(classifyPushResponse(200, { success: true, account: '{1A2B3C4D}' }))
      .toMatchObject({ ok: true, email: '{1A2B3C4D}' });
    expect(classifyPushResponse(400, { error: 'token rejected by provider' }))
      .toMatchObject({ ok: false, reason: 'token rejected by provider' });
    expect(classifyPushResponse(401, {})).toMatchObject({ needsSignIn: true });
    expect(classifyPushResponse(404, { error: 'not a token connector' }))
      .toMatchObject({ ok: false, reason: 'not a token connector' });
  });

  it('OPENS ON ESPN’S OWN SIGN-IN FORM, not on a page whose first control is dead', () => {
    // The window used to open the Fantasy home page. There the person icon's Log In does nothing in
    // the node's window, and the control that works sits in a side card a first-time user has to
    // find. ESPN's /login page puts the MyDisney form up with no click.
    expect(ESPN_TARGET.loginUrl).toBe('https://www.espn.com/login?returnURL=https%3A%2F%2Fwww.espn.com%2Ffantasy%2F');
    const entry = new URL(ESPN_TARGET.loginUrl);
    expect(entry.origin).toBe('https://www.espn.com');
    expect(entry.pathname).toBe('/login');
    // That page sends the window to returnURL after a sign-in and after the form is dismissed. It only
    // honours an absolute http(s) value; anything else is ignored and the window lands on the espn.com
    // front page instead of back on Fantasy.
    const back = new URL(entry.searchParams.get('returnURL') ?? 'about:blank');
    expect(back.href).toBe('https://www.espn.com/fantasy/');
    // The pair is read from the .espn.com jar, so the return must not leave that domain.
    expect(`.${back.hostname}`.endsWith(ESPN_TARGET.cookieDomain)).toBe(true);
  });

  it('keeps the live window check that goes red when ESPN moves the entry', () => {
    // The pin above only proves nobody edited the constant. The runner loads this URL in a real
    // window on a fresh profile and fails unless a visible sign-in form appears — delete it and an
    // ESPN change is back to breaking the button instead of a test.
    const manifest = JSON.parse(readFileSync(resolve(__dirname, '../../packages/oshal-chat/package.json'), 'utf8'));
    expect(manifest.scripts['test:espn-login']).toBe('npm run build && node scripts/start-electron.js dist/main/espn-login-boundary.js');
    expect(existsSync(resolve(__dirname, '../../packages/oshal-chat/src/main/espn-login-boundary.ts'))).toBe(true);
  });
});
