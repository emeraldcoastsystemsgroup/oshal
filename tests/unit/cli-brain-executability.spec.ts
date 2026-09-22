/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the rule a settings surface broke: a brain option is offered only when a bot node can actually EXECUTE it. The Gemini option went live the moment a Google login was pushed, PUT admitted it because PUT admits anything whose availability is true, and the resolved selection was then refused BY NAME at reconcileDispatchProviderConfig - so an operator who followed the instructions exactly had every turn afterwards fail. Three claims are pinned here and they are deliberately in one spec because they are one rule seen from three sides: the OPTION is unavailable and says which piece is missing, the PUT refuses it with that same piece, and the RESOLVER never produces it - all three reading the same executability fact off the harness table rather than a constant, so the day a runtime is wired they flip together. The authorization half is asserted unchanged: a non-operator is refused every CLI id whatever the table says.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Router } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { botNodeCanRunProvider } from '../../src/shared/llm-runtime';
import {
  cliBrainAvailable,
  cliBrainOffer,
  isRetryableCliBrainFailure,
  resolveAntigravityCliBrain,
  resolveGeminiCliBrain,
  resolveUserBrain,
  type CliBrainProviderId,
} from '../../src/app/routes/user-brain-resolution';
import { AuthoritativeDispatchConfigError } from '../../src/app/bot-node-dispatch-config';
import { createLlmPreferenceRoutes } from '../../src/app/routes/llm-preference-routes';
import type { AppContext } from '../../src/app/composition/app-context';

const OPERATOR = 'operator-sub-1';
const GUEST = 'guest-sub-9';
const OWNED_ENV = [
  'DEMO_MODE', 'MOCK_OIDC', 'OSHAL_OPERATOR_SUBS',
  'GEMINI_OAUTH_CREDS_PATH', 'ANTIGRAVITY_OAUTH_TOKEN_PATH', 'ANTIGRAVITY_CLI_PATH', 'LOCALAPPDATA', 'HOME', 'USERPROFILE',
];

/** The CLI ids a user can name, and whether a bot node holds a runtime for each one TODAY. */
const CLI_IDS: CliBrainProviderId[] = ['claude-code', 'openai-codex', 'gemini-cli', 'antigravity-cli'];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(OWNED_ENV.map((key) => [key, process.env[key]]));
  for (const key of OWNED_ENV) delete process.env[key];
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
  // No credential path and no binary path: the probes must read absence, never a real home.
  process.env.GEMINI_OAUTH_CREDS_PATH = '/nonexistent-oshal-test/oauth_creds.json';
  process.env.ANTIGRAVITY_OAUTH_TOKEN_PATH = '/nonexistent-oshal-test/antigravity-oauth-token';
  process.env.ANTIGRAVITY_CLI_PATH = '/nonexistent-oshal-test/agy';
});

afterEach(() => {
  for (const key of OWNED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

interface Harness { url: string; close: () => Promise<void> }

/** The REAL preference router over a real HTTP server, with a pool that holds no saved rows. */
async function serve(router: Router): Promise<Harness> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const sub = req.get('x-test-sub');
    if (sub) (req as express.Request & { oidc?: unknown }).oidc = { isAuthenticated: () => true, user: { sub } };
    next();
  });
  app.use('/api/settings/llm-default', router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

function testContext(): AppContext {
  return { pool: { query: async () => ({ rows: [] }) } } as unknown as AppContext;
}

interface OptionRow { id: string; label: string; detail: string; available: boolean }

async function readOptions(harness: Harness, sub: string): Promise<OptionRow[]> {
  const response = await fetch(`${harness.url}/api/settings/llm-default/`, { headers: { 'x-test-sub': sub } });
  const body = await response.json() as { options: OptionRow[] };
  return body.options;
}

describe('the harness table decides what can execute, and nothing keeps a second copy of it', () => {
  it('pins which CLI ids a bot node can run today, so a table change moves every guard below', () => {
    // These are FACTS about this build, read from HARNESS_BY_ID.botNodeRuntime. The bot node
    // builds exactly three runtimes; the two Google CLIs are api-side configuration only.
    expect(botNodeCanRunProvider('openai-codex')).toBe(true);
    expect(botNodeCanRunProvider('codex-cli')).toBe(true);
    expect(botNodeCanRunProvider('claude-code')).toBe(true);
    expect(botNodeCanRunProvider('cline-cli')).toBe(true);
    expect(botNodeCanRunProvider('gemini-cli')).toBe(false);
    expect(botNodeCanRunProvider('antigravity-cli')).toBe(true);
    // An id this build has never heard of is not runnable either — no accidental default-true.
    expect(botNodeCanRunProvider('not-a-provider')).toBe(false);
    expect(botNodeCanRunProvider('')).toBe(false);
    expect(botNodeCanRunProvider(null)).toBe(false);
  });

  it('refuses a CLI brain whose id no node can run, naming that as the missing piece', () => {
    process.env.DEMO_MODE = 'true';
    expect(cliBrainAvailable(OPERATOR)).toBe(true);
    const gemini = cliBrainOffer('gemini-cli', OPERATOR);
    expect(gemini.available).toBe(false);
    expect(gemini.refusal).toBe('no-node-runtime');
    expect(gemini.detail).toContain('gemini-cli');
    const antigravity = cliBrainOffer('antigravity-cli', OPERATOR);
    expect(antigravity.available).toBe(false);
    expect(antigravity.refusal).toBe('node-cannot-run');
    // …and the two that DO have runtimes are offered, so the negatives above are not vacuous.
    for (const id of ['claude-code', 'openai-codex'] as CliBrainProviderId[]) {
      expect(cliBrainOffer(id, OPERATOR).available, id).toBe(true);
    }
  });

  it('reads runnability through the table seam, so the refusal is derived and not hardcoded', () => {
    process.env.DEMO_MODE = 'true';
    // With a runtime present, the Gemini refusal MOVES to the next missing piece rather than
    // staying put — which is what proves the first refusal came from the table.
    const asIfWired = cliBrainOffer('gemini-cli', OPERATOR, { canRunProvider: () => true });
    expect(asIfWired.available).toBe(false);
    expect(asIfWired.refusal).toBe('no-credential');

    const antigravity = cliBrainOffer('antigravity-cli', OPERATOR, { canRunProvider: () => true });
    expect(antigravity.available).toBe(false);
    expect(antigravity.refusal).toBe('node-cannot-run');

    // Every piece present — the only combination that may ever be offered.
    expect(cliBrainOffer('gemini-cli', OPERATOR, {
      canRunProvider: () => true, pushedLoginPresent: () => true,
    })).toEqual({ available: true, refusal: null, detail: '' });
    expect(cliBrainOffer('antigravity-cli', OPERATOR, {
      canRunProvider: () => true, antigravityRunnable: () => ({ runnable: true, detail: '' }),
      antigravityCredentialPresent: () => true,
    })).toEqual({ available: true, refusal: null, detail: '' });
  });
});

describe('the ADR-127 carve still decides WHO, and it is checked first', () => {
  it('refuses every CLI id off demo, and every non-operator on demo, whatever the table says', () => {
    for (const id of CLI_IDS) {
      delete process.env.DEMO_MODE;
      expect(cliBrainOffer(id, OPERATOR).refusal, id).toBe('not-carved');
      process.env.DEMO_MODE = 'true';
      expect(cliBrainOffer(id, GUEST).refusal, id).toBe('not-carved');
      for (const sub of ['', '   ', OPERATOR.toUpperCase(), `${OPERATOR}x`, ` ${OPERATOR}`]) {
        expect(cliBrainOffer(id, sub).available, `${id}/${JSON.stringify(sub)}`).toBe(false);
      }
    }
  });

  it('does not treat MOCK_OIDC as a demo deployment', () => {
    process.env.MOCK_OIDC = 'true';
    for (const id of CLI_IDS) expect(cliBrainOffer(id, OPERATOR).refusal, id).toBe('not-carved');
  });

  it('checks the carve BEFORE any credential path or install is probed', () => {
    let probed = 0;
    const seen = () => { probed += 1; return true; };
    expect(cliBrainOffer('gemini-cli', GUEST, { canRunProvider: () => true, pushedLoginPresent: seen }).available).toBe(false);
    expect(probed).toBe(0);
  });
});

describe('the settings surface offers only what a turn can run on', () => {
  let harness: Harness;

  beforeEach(async () => {
    process.env.DEMO_MODE = 'true';
    harness = await serve(createLlmPreferenceRoutes(testContext()));
  });
  afterEach(async () => { await harness.close(); });

  it('does not offer either Google CLI until its remaining prerequisite exists, and names it', async () => {
    const options = await readOptions(harness, OPERATOR);
    for (const id of ['gemini-cli', 'antigravity-cli']) {
      const option = options.find((entry) => entry.id === id);
      expect(option, id).toBeDefined();
      expect(option?.available, id).toBe(false);
      // The detail must be the CAUSE, not the generic sentence — an operator who pushed a login
      // and saw "runs through the Gemini CLI" believed a thing that was never true.
      expect(option?.detail, id).not.toContain('Runs ');
      expect(option?.detail, id).toContain(id === 'gemini-cli' ? 'No bot node can execute' : 'not installed');
    }
    // The runnable pair stays on offer for the operator, so this is a narrowing and not an outage.
    expect(options.find((entry) => entry.id === 'openai-codex')?.available).toBe(true);
    expect(options.find((entry) => entry.id === 'claude-code')?.available).toBe(true);
  });

  it('refuses both Google CLI ids on PUT until their distinct prerequisites exist', async () => {
    for (const preferred of ['gemini-cli', 'antigravity-cli']) {
      const response = await fetch(`${harness.url}/api/settings/llm-default/`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-test-sub': OPERATOR },
        body: JSON.stringify({ preferred }),
      });
      expect(response.status, preferred).toBe(409);
      const body = await response.json() as { error: string; detail: string };
      expect(body.error, preferred).toContain('not available');
      expect(body.detail, preferred).toContain(preferred === 'gemini-cli' ? 'No bot node can execute' : 'not installed');
    }
  });

  it('still accepts an id that can run, so the refusals above are not a blanket 409', async () => {
    const response = await fetch(`${harness.url}/api/settings/llm-default/`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-sub': OPERATOR },
      body: JSON.stringify({ preferred: 'openai-codex' }),
    });
    expect(response.status).toBe(200);
  });

  it('keeps every CLI option closed to a non-operator', async () => {
    const options = await readOptions(harness, GUEST);
    for (const id of CLI_IDS) {
      expect(options.find((entry) => entry.id === id)?.available, id).toBe(false);
    }
    const response = await fetch(`${harness.url}/api/settings/llm-default/`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-sub': GUEST },
      body: JSON.stringify({ preferred: 'openai-codex' }),
    });
    expect(response.status).toBe(409);
  });

  it('refuses an unauthenticated caller outright', async () => {
    const response = await fetch(`${harness.url}/api/settings/llm-default/`);
    expect(response.status).toBe(401);
  });
});

describe('the resolver never produces a brain the surface would not offer', () => {
  it('keeps Gemini unresolved without a runtime while Antigravity resolves when its binary can run', () => {
    process.env.DEMO_MODE = 'true';
    expect(resolveGeminiCliBrain(OPERATOR, { pushedLoginPresent: () => true })).toBeNull();
    expect(resolveAntigravityCliBrain(OPERATOR, {
      antigravityRunnable: () => ({ runnable: true, detail: '' }),
      antigravityCredentialPresent: () => true,
    })).toEqual({ kind: 'cli', providerId: 'antigravity-cli' });
  });

  it('produces the brain once the node runtime exists, proving the null above is the runtime', () => {
    process.env.DEMO_MODE = 'true';
    expect(resolveGeminiCliBrain(OPERATOR, { canRunProvider: () => true, pushedLoginPresent: () => true }))
      .toEqual({ kind: 'cli', providerId: 'gemini-cli' });
    expect(resolveAntigravityCliBrain(OPERATOR, {
      canRunProvider: () => true,
      antigravityRunnable: () => ({ runnable: true, detail: '' }),
      antigravityCredentialPresent: () => true,
      model: 'gemini-3.8-flash-low',
    })).toEqual({ kind: 'cli', providerId: 'antigravity-cli', model: 'gemini-3.8-flash-low' });
  });

  it('degrades a saved Google preference onto a rung that CAN run, never onto the named harness', async () => {
    process.env.DEMO_MODE = 'true';
    for (const preferred of ['gemini-cli', 'antigravity-cli']) {
      const pool = { query: async (sql: string) => (
        /SELECT preferred_provider/.test(sql) ? { rows: [{ preferred_provider: preferred, preferred_model: null }] } : { rows: [] }
      ) };
      const brain = await resolveUserBrain(pool, OPERATOR);
      expect(brain.kind, preferred).toBe('cli');
      expect(brain.kind === 'cli' && brain.providerId, preferred).toBe('openai-codex');
    }
  });
});

describe('an unresolvable dispatch degrades to a hosted lane instead of reaching the user', () => {
  it('classifies the node refusal as retryable, by error and by code', () => {
    expect(isRetryableCliBrainFailure(new AuthoritativeDispatchConfigError(
      'Authoritative provider config is unavailable for gemini-cli',
    ))).toBe(true);
    // The same fact arriving as a bare coded object — a worker boundary can flatten an Error.
    expect(isRetryableCliBrainFailure({ code: 'AUTHORITATIVE_PROVIDER_UNAVAILABLE', message: 'x' })).toBe(true);
    expect(isRetryableCliBrainFailure({ name: 'AuthoritativeDispatchConfigError', message: 'x' })).toBe(true);
  });

  it('still refuses to replay a failure a second brain would only reproduce', () => {
    // A content or business-rule failure is NOT retryable: the guard must stay a narrow one.
    expect(isRetryableCliBrainFailure(new Error('The requested document could not be summarised'))).toBe(false);
    expect(isRetryableCliBrainFailure(null)).toBe(false);
    expect(isRetryableCliBrainFailure('some string failure')).toBe(false);
  });
});
