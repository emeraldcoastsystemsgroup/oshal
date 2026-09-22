/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for where a Gemini turn RUNS. Two claims are pinned here and they pull in opposite directions, which is why they are one spec: with a pushed sign-in present the turn must resolve to the gemini-cli harness and NOT the hosted HTTP provider (the API key reaches generativelanguage on the free tier, the pushed credential is oauth-personal against cloudcode-pa, so the HTTP lane cannot serve it) — and the ADR-127 carve must decide WHO exactly as it always did, so every negative is enumerated: off demo, a non-operator, an empty sub, a whitespace sub, and a sub that is a case/prefix/suffix variant of an operator sub. The pushed-login probe runs against a real file on a real temp path, never the operator's home.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Entry 1's first claim was wrong and is inverted here: a pushed sign-in does NOT make the turn resolve to the gemini-cli harness, because no bot node holds a runtime for that id, so the resolution was a dispatch the node refuses by name. The pushed-login probe and every carve negative were correct and are untouched - what changed is that the positive control now has to say so explicitly, injecting a node runtime to show the null is the RUNTIME and not the credential. Google also retired individual Code Assist sign-in on 2026-09-22, so the credential half is dormant; it is still exercised here because the probe and the import route are kept and still correct.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cliBrainAvailable, resolveGeminiCliBrain } from '../../src/app/routes/user-brain-resolution';
import { geminiPushedLoginPresent } from '../../src/features/llm-provider';

const OPERATOR = 'operator-sub-1';
const GUEST = 'guest-sub-9';
const OWNED_ENV = ['DEMO_MODE', 'MOCK_OIDC', 'OSHAL_OPERATOR_SUBS', 'GEMINI_OAUTH_CREDS_PATH', 'HOME', 'USERPROFILE'];

const SIGNED_IN = { access_token: 'ya29.pushed', refresh_token: '1//pushed', expiry_date: 1_800_000_000_000 };

let saved: Record<string, string | undefined> = {};
let root = '';

/** A pushed sign-in that really exists on disk, at a path no real user owns. */
function writePushedLogin(contents: unknown): string {
  const file = path.join(root, 'oauth_creds.json');
  fs.writeFileSync(file, JSON.stringify(contents), 'utf8');
  return file;
}

beforeEach(() => {
  saved = Object.fromEntries(OWNED_ENV.map((k) => [k, process.env[k]]));
  for (const k of OWNED_ENV) delete process.env[k];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-gemini-brain-'));
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
  process.env.GEMINI_OAUTH_CREDS_PATH = path.join(root, 'oauth_creds.json');
});

afterEach(() => {
  for (const k of OWNED_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a Gemini turn under a pushed login runs on the CLI harness, not the HTTP provider', () => {
  it('does NOT resolve to gemini-cli even with a pushed sign-in, because no node runs that id', () => {
    process.env.DEMO_MODE = 'true';
    writePushedLogin(SIGNED_IN);
    expect(geminiPushedLoginPresent()).toBe(true);
    // The credential is present and the caller is carved in — and the answer is still null,
    // because HARNESS_BY_ID gives gemini-cli no bot-node runtime. Returning the harness here is
    // what made the operator's every turn fail at reconcileDispatchProviderConfig.
    expect(resolveGeminiCliBrain(OPERATOR)).toBeNull();
    expect(resolveGeminiCliBrain(OPERATOR, { model: 'gemini-3.8-flash' })).toBeNull();
  });

  it('resolves once a node runtime exists, which is what shows the null above is the runtime', () => {
    process.env.DEMO_MODE = 'true';
    writePushedLogin(SIGNED_IN);
    const wired = { canRunProvider: () => true };
    expect(resolveGeminiCliBrain(OPERATOR, wired)).toEqual({ kind: 'cli', providerId: 'gemini-cli' });
    expect(resolveGeminiCliBrain(OPERATOR, { ...wired, model: 'gemini-3.8-flash' }))
      .toEqual({ kind: 'cli', providerId: 'gemini-cli', model: 'gemini-3.8-flash' });
  });

  it('falls back to the hosted lane (null) when no sign-in has been pushed', () => {
    process.env.DEMO_MODE = 'true';
    expect(geminiPushedLoginPresent()).toBe(false);
    expect(resolveGeminiCliBrain(OPERATOR)).toBeNull();
  });

  it('does not treat a Google API KEY as a pushed sign-in — that is the whole point of the rail', () => {
    process.env.DEMO_MODE = 'true';
    process.env.GEMINI_API_KEY = 'AIzaSyFreeTierKey';
    process.env.GOOGLE_API_KEY = 'AIzaSyFreeTierKey';
    try {
      // getGeminiAuthStatus would answer connected:true / method:'api-key' here. The pushed-login
      // probe must not: a key is a different identity on a different endpoint, and it is the one
      // that was measured answering 429 free-tier / 503.
      expect(geminiPushedLoginPresent()).toBe(false);
      expect(resolveGeminiCliBrain(OPERATOR)).toBeNull();
    } finally {
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
    }
  });

  it('treats an access token with no refresh token, and an unreadable file, as no login', () => {
    process.env.DEMO_MODE = 'true';
    writePushedLogin({ access_token: 'ya29.only' });
    expect(geminiPushedLoginPresent()).toBe(false);
    fs.writeFileSync(path.join(root, 'oauth_creds.json'), 'not json at all', 'utf8');
    expect(geminiPushedLoginPresent()).toBe(false);
    expect(resolveGeminiCliBrain(OPERATOR)).toBeNull();
  });
});

describe('the ADR-127 carve still decides WHO, unchanged', () => {
  it('refuses every caller off demo, operator or not, even with a pushed login present', () => {
    writePushedLogin(SIGNED_IN);
    delete process.env.DEMO_MODE;
    expect(cliBrainAvailable(OPERATOR)).toBe(false);
    expect(resolveGeminiCliBrain(OPERATOR)).toBeNull();
    expect(resolveGeminiCliBrain(GUEST)).toBeNull();
  });

  it('does not treat MOCK_OIDC as a demo deployment', () => {
    writePushedLogin(SIGNED_IN);
    process.env.MOCK_OIDC = 'true';
    expect(resolveGeminiCliBrain(OPERATOR)).toBeNull();
  });

  it('refuses a non-operator, an empty sub and a whitespace sub in demo mode', () => {
    process.env.DEMO_MODE = 'true';
    writePushedLogin(SIGNED_IN);
    for (const sub of [GUEST, '', '   ', '\t']) {
      expect(resolveGeminiCliBrain(sub), JSON.stringify(sub)).toBeNull();
    }
  });

  it('refuses a sub that is a case, prefix or suffix variant of an operator sub', () => {
    process.env.DEMO_MODE = 'true';
    writePushedLogin(SIGNED_IN);
    for (const lookalike of [
      OPERATOR.toUpperCase(),
      ` ${OPERATOR}`,
      `${OPERATOR} `,
      `${OPERATOR}x`,
      OPERATOR.slice(0, -1),
      `x${OPERATOR}`,
    ]) {
      expect(resolveGeminiCliBrain(lookalike, { canRunProvider: () => true }), lookalike).toBeNull();
    }
    // …and the exact sub still resolves once the runtime half is supplied, so the negatives
    // above are failing on the SUBJECT and not merely on the missing runtime.
    expect(resolveGeminiCliBrain(OPERATOR, { canRunProvider: () => true }))
      .toEqual({ kind: 'cli', providerId: 'gemini-cli' });
  });

  it('reads the probe through the injected seam, so the carve is checked BEFORE any credential path is touched', () => {
    let probed = 0;
    const probe = () => { probed += 1; return true; };
    const wired = { canRunProvider: () => true, pushedLoginPresent: probe };
    expect(resolveGeminiCliBrain(GUEST, wired)).toBeNull();
    expect(probed).toBe(0);

    process.env.DEMO_MODE = 'true';
    expect(resolveGeminiCliBrain(OPERATOR, wired)).toEqual({ kind: 'cli', providerId: 'gemini-cli' });
    expect(probed).toBe(1);
  });

  it('checks the node runtime before the credential too, so an absent login is never the reason', () => {
    process.env.DEMO_MODE = 'true';
    let probed = 0;
    const probe = () => { probed += 1; return true; };
    expect(resolveGeminiCliBrain(OPERATOR, { pushedLoginPresent: probe })).toBeNull();
    expect(probed).toBe(0);
  });
});
