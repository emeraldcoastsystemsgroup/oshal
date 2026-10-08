/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard log-read refusal, safe rendering, trace encoding and finite administrator override input.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogsView } from '../../src/pages/cockpit/js/views/LogsView.js';
import { escapeLoggingHtml, loggingLevel, loggingQuery, loggingRequest, loggingStatus } from '../../src/pages/cockpit/js/views/logging-reader.js';
import { parseLoggingOverrides } from '../../src/pages/cockpit/js/views/logging-settings.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('native logging screen contracts', () => {
  it('preserves auth and storage refusals instead of returning an empty history', async () => {
    for (const status of [401, 403, 503]) {
      const json = vi.fn(async () => ({ detail: 'private failure content' }));
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status, json })));
      await expect(loggingRequest('/api/v1/logs/query')).rejects.toMatchObject({ status });
      expect(json).not.toHaveBeenCalled();
    }
  });

  it('encodes user filters as values and never widens the fixed query limit', () => {
    const params = loggingQuery({ ticketId: 'ticket&limit=9999', traceId: 'trace?x=1', search: 'a+b&level=trace', level: 'debug' }, null);
    expect(params.get('limit')).toBe('500');
    expect(params.get('ticketId')).toBe('ticket&limit=9999');
    expect(params.get('traceId')).toBe('trace?x=1');
    expect(params.get('search')).toBe('a+b&level=trace');
    expect(params.get('level')).toBe('debug');
  });

  it('shows actual memory retention, eviction and result truncation', () => {
    const status = loggingStatus({ total: 3, hasMore: true, evicted: 42, droppedOversize: 1 }, 'native-kernel-observer');
    expect(status).toContain('3 matching entries');
    expect(status).toContain('resets on restart');
    expect(status).toContain('42 older entries evicted');
    expect(status).toContain('1 oversized entries omitted');
    expect(status).toContain('result limit reached');
  });

  it('escapes untrusted records and restricts severity CSS classes', () => {
    const view = Object.create(LogsView.prototype);
    const html = view._renderRow({ time: 1, levelLabel: 'error" onclick="alert(1)',
      module: '<img src=x onerror=alert(1)>', msg: '<script>secret()</script>',
      traceId: '" data-other="payload' }, 0);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('class="logs-level logs-level-error" onclick');
    expect(html).toContain('logs-level-info');
    expect(escapeLoggingHtml("'\"<>&")).toBe('&#39;&quot;&lt;&gt;&amp;');
    expect(loggingLevel('TRACE')).toBe('trace');
  });

  it('accepts finite exact module overrides including trace and error', () => {
    expect(parseLoggingOverrides('oshald::turn_runner=trace\napi=error')).toEqual({ 'oshald::turn_runner': 'trace', api: 'error' });
    expect(Object.getPrototypeOf(parseLoggingOverrides('__proto__=warn'))).toBeNull();
  });

  it('refuses duplicate, malformed, excessive and overlong overrides', () => {
    for (const text of ['api=debug\napi=trace', 'api=quiet', '=info', '<script>=error',
      `${'a'.repeat(97)}=info`, Array.from({ length: 33 }, (_, i) => `module${i}=info`).join('\n')]) {
      expect(() => parseLoggingOverrides(text)).toThrow();
    }
  });
});
