import { describe, expect, it } from 'vitest';
import { connectorProvidersForManifestWorker } from '../../src/app/manifest-worker-connector-scope';

describe('manifest-worker connector scope', () => {
  it('grants communications workers only their supported communication providers', () => {
    expect(connectorProvidersForManifestWorker('b0000000-0000-0000-0000-000000000001'))
      .toEqual(['google', 'twitter', 'twilio']);
  });

  it('grants home workers only SmartThings and unknown workers nothing', () => {
    expect(connectorProvidersForManifestWorker('d0000000-0000-0000-0000-000000000001'))
      .toEqual(['smartthings']);
    expect(connectorProvidersForManifestWorker('unknown-agent')).toEqual([]);
  });

  it('grants commerce workers only their dedicated provider', () => {
    expect(connectorProvidersForManifestWorker('b0070000-0000-0000-0000-000000000001'))
      .toEqual(['walmart']);
    expect(connectorProvidersForManifestWorker('b0080000-0000-0000-0000-000000000001'))
      .toEqual(['uber']);
  });
});
