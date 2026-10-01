/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Simple chat kit and /simple's Jarvis adapter as plain modules (docs/architecture/simple-chat.md): escape-first markdown, the link guard (same-origin paths and https only), the placeholder-collision guard, and the adapter's history mapping, session roll, answer links, failure wording, the slow-reply progress note and the poll limit.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const kit = require('../../src/shared/ui/js/simple-chat.js') as {
  renderMarkdown: (text: string, origin?: string) => string;
  safeHref: (href: string, origin?: string) => { href: string; external: boolean } | null;
};
const page = require('../../src/experience/simple.js') as {
  createAdapter: (env: Record<string, unknown>) => {
    history: () => Promise<{ ok: boolean; turns?: Array<Record<string, unknown>>; error?: string }>;
    send: (text: string, ui?: { progress: (label: string) => void }) => Promise<Record<string, unknown>>;
  };
};

const ORIGIN = 'https://swarm.example';
const md = (text: string) => kit.renderMarkdown(text, ORIGIN);

describe('simple chat kit: rendering', () => {
  it('escapes before it formats, so reply text cannot become markup', () => {
    expect(md('<script>alert(1)</script> & "q"')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;</p>');
    expect(md('**bold** and *soft* and `<b>code</b>`')).toBe('<p><strong>bold</strong> and <em>soft</em> and <code>&lt;b&gt;code&lt;/b&gt;</code></p>');
    expect(md('2*3*4 stays arithmetic')).toBe('<p>2*3*4 stays arithmetic</p>');
  });

  it('draws paragraphs, line breaks, lists, headings and fenced code', () => {
    expect(md('one\ntwo\n\nthree')).toBe('<p>one<br>two</p><p>three</p>');
    expect(md('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(md('1. first\n2) second')).toBe('<ol><li>first</li><li>second</li></ol>');
    expect(md('## Plan')).toBe('<p class="sc-h"><strong>Plan</strong></p>');
    expect(md('```\n<raw> **not bold**\n```')).toBe('<pre><code>&lt;raw&gt; **not bold**</code></pre>');
    expect(md('')).toBe('');
  });

  it('links only to this origin or to https, and an absolute link opens in a new tab', () => {
    expect(md('[Ledger](/cockpit/?app=ledger&view=a)')).toBe('<p><a href="/cockpit/?app=ledger&amp;view=a">Ledger</a></p>');
    expect(md('[Docs](https://docs.example/a)')).toBe('<p><a href="https://docs.example/a" target="_blank" rel="noopener noreferrer">Docs</a></p>');
    expect(md('see https://docs.example/page.')).toBe('<p>see <a href="https://docs.example/page" target="_blank" rel="noopener noreferrer">https://docs.example/page</a>.</p>');
    for (const bad of ['javascript:alert(1)', '//evil.test/x', '/\\evil.test', 'http://plain.test', 'data:text/html,x']) {
      expect(kit.safeHref(bad, ORIGIN), bad).toBeNull();
      expect(md(`[x](${bad})`), bad).not.toContain('<a ');
    }
    expect(kit.safeHref('/a/../b?c=1#d', ORIGIN)).toEqual({ href: '/b?c=1#d', external: false });
  });

  it('reply text cannot reach a saved link through the placeholder byte', () => {
    const html = md('[a](/x) \u00000\u0000 \u00009\u0000');
    expect(html).toBe('<p><a href="/x">a</a> 0 9</p>');
  });
});

/** A scripted fetch: each call takes the next answer for its path prefix and is recorded. */
function scriptedFetch(answers: Record<string, Array<{ status: number; body: unknown }>>) {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const fetchImpl = async (url: string, init: { method?: string; body?: string }) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    const key = Object.keys(answers).find(prefix => url.startsWith(prefix));
    const next = key ? answers[key].shift() : undefined;
    const answer = next || { status: 404, body: { error: 'unscripted' } };
    return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
  };
  return { fetchImpl, calls };
}
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, data };
}

describe('/simple Jarvis adapter', () => {
  it('reads the device thread and maps turns, marking a visual answer with the full-Jarvis link', async () => {
    const { fetchImpl, calls } = scriptedFetch({ '/api/jarvis/history': [{ status: 200, body: { turns: [
      { role: 'user', text: 'Hi' }, { role: 'jarvis', text: 'Hello' }, { role: 'jarvis', text: 'Chart', visual: { kind: 'chart' } }] } }] });
    const storage = memoryStorage({ jarvisSessionId: 'jarvis-abc123' });
    const result = await page.createAdapter({ fetch: fetchImpl, storage }).history();
    expect(calls[0].url).toBe('/api/jarvis/history?sessionId=jarvis-abc123');
    expect(result).toEqual({ ok: true, turns: [
      { role: 'user', text: 'Hi', links: [] }, { role: 'assistant', text: 'Hello', links: [] },
      { role: 'assistant', text: 'Chart', links: [{ label: 'Open Jarvis to see the picture', href: '/api/jarvis/' }] }] });
  });

  it('says a failed history read and a signed-out caller plainly', async () => {
    const failed = scriptedFetch({ '/api/jarvis/history': [{ status: 500, body: null }] });
    expect(await page.createAdapter({ fetch: failed.fetchImpl, storage: memoryStorage() }).history())
      .toEqual({ ok: false, error: 'Your earlier conversation could not be loaded.' });
    const signedOut = scriptedFetch({ '/api/jarvis/history': [{ status: 401, body: { error: 'not_authenticated' } }] });
    expect((await page.createAdapter({ fetch: signedOut.fetchImpl, storage: memoryStorage() }).history()).error)
      .toBe('You are signed out. Sign in again, then send your message.');
  });

  it('sends on the device session, rolls an expired thread once, and returns the answer with its handoff and file links', async () => {
    const { fetchImpl, calls } = scriptedFetch({
      '/api/jarvis/ask/result': [{ status: 200, body: { status: 'pending' } }, { status: 200, body: { status: 'done', answer: 'Done.',
        handoffs: [{ name: 'Finance', deepLink: '/cockpit/?app=finance' }],
        files: [{ name: 'report.pdf', downloadUrl: '/api/jarvis/files/1' }, { name: 'remote', url: 'https://elsewhere.test/x' }] } }],
      '/api/jarvis/ask': [{ status: 404, body: { error: 'session_not_found' } }, { status: 202, body: { jobId: 'job 1' } }],
    });
    const storage = memoryStorage({ jarvisSessionId: 'jarvis-old000' });
    const reply = await page.createAdapter({ fetch: fetchImpl, storage, sleep: async () => undefined }).send('Pay day?');
    const asks = calls.filter(c => c.url === '/api/jarvis/ask');
    expect(asks.map(c => c.body?.sessionId)).toEqual(['jarvis-old000', storage.data.get('jarvisSessionId')]);
    expect(storage.data.get('jarvisSessionId')).not.toBe('jarvis-old000');
    expect(calls.filter(c => c.url.startsWith('/api/jarvis/ask/result')).map(c => c.url)).toEqual(['/api/jarvis/ask/result?jobId=job%201', '/api/jarvis/ask/result?jobId=job%201']);
    expect(reply).toEqual({ ok: true, text: 'Done.', links: [
      { label: 'Open Finance ↗', href: '/cockpit/?app=finance' }, { label: '↓ report.pdf', href: '/api/jarvis/files/1', download: true }] });
  });

  it('turns refusals, failed jobs and expired jobs into the server\'s words, never an answer', async () => {
    const refused = scriptedFetch({ '/api/jarvis/ask': [{ status: 503, body: { error: 'ai_disabled', message: 'The assistant is switched off.' } }] });
    expect(await page.createAdapter({ fetch: refused.fetchImpl, storage: memoryStorage() }).send('x')).toEqual({ ok: false, error: 'The assistant is switched off.' });
    const unreachable = { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } };
    expect(await page.createAdapter({ fetch: unreachable.fetchImpl, storage: memoryStorage() }).send('x')).toEqual({ ok: false, error: 'The swarm could not be reached.' });
    for (const [body, error] of [[{ status: 'error', error: 'Tool refused.' }, 'Tool refused.'], [{ status: 'expired' }, 'That request expired before an answer arrived.']] as const) {
      const job = scriptedFetch({ '/api/jarvis/ask/result': [{ status: 200, body }], '/api/jarvis/ask': [{ status: 202, body: { jobId: 'j' } }] });
      expect(await page.createAdapter({ fetch: job.fetchImpl, storage: memoryStorage(), sleep: async () => undefined }).send('x')).toEqual({ ok: false, error });
    }
  });

  it('says when a reply is slow, and stops waiting at the poll limit with an honest note', async () => {
    const pending = Array.from({ length: 250 }, () => ({ status: 200, body: { status: 'pending' } }));
    const { fetchImpl, calls } = scriptedFetch({ '/api/jarvis/ask/result': pending, '/api/jarvis/ask': [{ status: 202, body: { jobId: 'slow' } }] });
    const progress: string[] = [];
    const reply = await page.createAdapter({ fetch: fetchImpl, storage: memoryStorage(), sleep: async () => undefined }).send('x', { progress: (l: string) => progress.push(l) });
    expect(progress).toEqual(['Still working on it']);
    expect(calls.filter(c => c.url.startsWith('/api/jarvis/ask/result')).length).toBe(200);
    expect(reply).toEqual({ ok: false, error: 'This is taking unusually long. It may still finish; check Jarvis later.' });
  });
});
