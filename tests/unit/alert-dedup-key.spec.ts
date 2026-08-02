/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Named guards for the consolidation identity: determinism across label ordering and repeated calls, discrimination across targets and alert names, the missing-field sentinel (the guard that goes red the moment a missing field renders as an empty string), value normalization including target port stripping, per-deployment key namespacing, and the identity gate.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DEPLOYMENT_ID,
  DEFAULT_IDENTITY_FIELDS,
  DEPLOYMENT_ID_ENV,
  hasUsableIdentity,
  normalizeIdentityValue,
  normalizeTargetValue,
  renderDedupKey,
  renderIdentitySource,
  resolveDeploymentId,
  type IdentitySourceEvent,
} from '@/features/alert-pipeline/services/dedup-key';

/** The ASCII unit separator the renderer joins with, built from its code point so no control character is embedded in this file. */
const SEP = String.fromCharCode(31);

const DEPLOYMENT = 'prod-east';

/** Render a key under a fixed deployment so every comparison isolates the identity. */
function key(event: IdentitySourceEvent, fields: readonly string[] = DEFAULT_IDENTITY_FIELDS): string {
  return renderDedupKey(event, fields, DEPLOYMENT);
}

/**
 * The rendering a sentinel-free implementation produces: a missing field contributes an empty
 * token, and an empty token is indistinguishable from no token at all once the values are read
 * back. Used to show what the sentinel is buying.
 */
function withoutSentinels(identitySource: string): string {
  return identitySource
    .split(SEP)
    .map((token) => (/^<[^<>]+>$/.test(token) ? '' : token))
    .filter((token) => token.length > 0)
    .join(SEP);
}

describe('alert dedup key — determinism', () => {
  it('renders the same key for the same identity across separate calls', () => {
    const event: IdentitySourceEvent = { target: 'oshal-local-db', alertname: 'ContainerDown' };
    expect(key(event)).toBe(key({ ...event }));
  });

  it('ignores label insertion order', () => {
    const fields = ['target', 'alertname', 'labels.pod'];
    const first: IdentitySourceEvent = {
      target: 'oshal-local-db',
      alertname: 'ContainerDown',
      labels: { pod: 'db-0', severity: 'critical', job: 'cadvisor' },
    };
    const second: IdentitySourceEvent = {
      target: 'oshal-local-db',
      alertname: 'ContainerDown',
      labels: { job: 'cadvisor', pod: 'db-0', severity: 'critical' },
    };

    expect(Object.keys(first.labels ?? {})).not.toEqual(Object.keys(second.labels ?? {}));
    expect(key(first, fields)).toBe(key(second, fields));
  });

  it('ignores labels that are not identity fields', () => {
    const withExtras: IdentitySourceEvent = {
      target: 'oshal-local-db',
      alertname: 'ContainerDown',
      labels: { runbook: 'https://example.invalid/db', shift: 'night' },
    };
    expect(key(withExtras)).toBe(key({ target: 'oshal-local-db', alertname: 'ContainerDown' }));
  });
});

describe('alert dedup key — discrimination', () => {
  it('separates two targets under one alert name', () => {
    const a = key({ target: 'oshal-local-db', alertname: 'ContainerDown' });
    const b = key({ target: 'oshal-local-redis', alertname: 'ContainerDown' });
    expect(a).not.toBe(b);
  });

  it('separates two alert names on one target', () => {
    const a = key({ target: 'oshal-local-db', alertname: 'ContainerDown' });
    const b = key({ target: 'oshal-local-db', alertname: 'DiskFilling' });
    expect(a).not.toBe(b);
  });

  it('keeps all four target/alertname combinations distinct', () => {
    const keys = new Set<string>();
    for (const target of ['oshal-local-db', 'oshal-local-redis']) {
      for (const alertname of ['ContainerDown', 'DiskFilling']) {
        keys.add(key({ target, alertname }));
      }
    }
    expect(keys.size).toBe(4);
  });

  it('separates events differing only in an extra identity field', () => {
    const fields = ['target', 'alertname', 'namespace'];
    const a = key({ target: 'web-1', alertname: 'PodRestarting', namespace: 'prod' }, fields);
    const b = key({ target: 'web-1', alertname: 'PodRestarting', namespace: 'staging' }, fields);
    expect(a).not.toBe(b);
  });

  it('treats an empty or blank field list as unconfigured rather than as "group everything"', () => {
    const event: IdentitySourceEvent = { target: 'web-1', alertname: 'NodeDown' };
    const other: IdentitySourceEvent = { target: 'web-2', alertname: 'DiskFilling' };
    expect(key(event, [])).toBe(key(event, DEFAULT_IDENTITY_FIELDS));
    expect(key(event, ['   ', ''])).toBe(key(event, DEFAULT_IDENTITY_FIELDS));
    expect(key(event, [])).not.toBe(key(other, []));
  });
});

describe('alert dedup key — the missing-field sentinel', () => {
  const missingTarget: IdentitySourceEvent = { alertname: 'HighMemory' };
  const missingAlertname: IdentitySourceEvent = { target: 'HighMemory' };

  it('names the missing field in the identity source', () => {
    expect(renderIdentitySource(missingTarget, DEFAULT_IDENTITY_FIELDS)).toContain('<target>');
    expect(renderIdentitySource(missingAlertname, DEFAULT_IDENTITY_FIELDS)).toContain('<alertname>');
  });

  it('names the missing field for every identity field, not just the default pair', () => {
    const source = renderIdentitySource({ target: 'web-1' }, ['target', 'alertname', 'namespace', 'labels.pod']);
    expect(source).toContain('<alertname>');
    expect(source).toContain('<namespace>');
    expect(source).toContain('<labels.pod>');
    expect(source).not.toContain('<target>');
  });

  it('keeps two alerts missing DIFFERENT fields apart', () => {
    expect(key(missingTarget)).not.toBe(key(missingAlertname));
  });

  it('collides once the sentinel renders as an empty string', () => {
    const a = renderIdentitySource(missingTarget, DEFAULT_IDENTITY_FIELDS);
    const b = renderIdentitySource(missingAlertname, DEFAULT_IDENTITY_FIELDS);

    // The sentinel is what is being removed, so it must have been there.
    expect(withoutSentinels(a)).not.toBe(a);
    expect(withoutSentinels(b)).not.toBe(b);

    // Without it, position carries no information and the two identities merge.
    expect(withoutSentinels(a)).toBe(withoutSentinels(b));
    expect(a).not.toBe(b);
  });

  it('treats a whitespace-only field as missing rather than as a value', () => {
    expect(renderIdentitySource({ target: '   ', alertname: 'HighMemory' }, DEFAULT_IDENTITY_FIELDS)).toBe(
      renderIdentitySource({ alertname: 'HighMemory' }, DEFAULT_IDENTITY_FIELDS),
    );
  });
});

describe('alert dedup key — normalization', () => {
  it('strips a trailing port from the target', () => {
    expect(normalizeTargetValue('host:9090')).toBe('host');
    expect(key({ target: 'HOST:9090', alertname: 'NodeDown' })).toBe(key({ target: 'host', alertname: 'NodeDown' }));
  });

  it('trims and lowercases', () => {
    expect(normalizeIdentityValue('  Host  ')).toBe('host');
    expect(key({ target: '  Host  ', alertname: 'NodeDown' })).toBe(key({ target: 'host', alertname: 'NodeDown' }));
  });

  it('collapses internal whitespace runs to one space', () => {
    expect(normalizeIdentityValue('Node\t\tIs   Down')).toBe('node is down');
    expect(key({ target: 'host', alertname: 'Node   Is Down' })).toBe(
      key({ target: 'host', alertname: 'node is down' }),
    );
  });

  it('folds compatibility forms with NFKC', () => {
    // Full-width latin small letter a (U+FF41) folds to plain 'a'.
    const fullWidthA = String.fromCharCode(0xff41);
    expect(normalizeIdentityValue(`${fullWidthA}pi-1`)).toBe('api-1');
  });

  it('folds a control character into whitespace so a value cannot forge a field boundary', () => {
    expect(normalizeIdentityValue(`web${SEP}1`)).toBe('web 1');
    const forged = key({ target: `web-1${SEP}NodeDown`, alertname: 'Other' });
    const genuine = key({ target: 'web-1', alertname: 'NodeDown' });
    expect(forged).not.toBe(genuine);
  });

  it('keeps the port on fields that are not the target', () => {
    expect(normalizeIdentityValue('host:9090')).toBe('host:9090');
    const fields = ['instance', 'alertname'];
    expect(key({ instance: 'host:9090', alertname: 'NodeDown' }, fields)).not.toBe(
      key({ instance: 'host:9100', alertname: 'NodeDown' }, fields),
    );
  });

  it('leaves a bare IPv6 literal intact and still reduces a bracketed one', () => {
    expect(normalizeTargetValue('::1')).toBe('::1');
    expect(normalizeTargetValue('[::1]:9090')).toBe('[::1]');
  });

  it('resolves an identity field from labels when the promoted column is absent', () => {
    expect(key({ labels: { target: 'oshal-local-db', alertname: 'ContainerDown' } })).toBe(
      key({ target: 'oshal-local-db', alertname: 'ContainerDown' }),
    );
  });
});

describe('alert dedup key — deployment namespacing', () => {
  const event: IdentitySourceEvent = { target: 'web-1', alertname: 'NodeDown' };

  it('separates the same identity across two deployments', () => {
    expect(renderDedupKey(event, DEFAULT_IDENTITY_FIELDS, 'prod')).not.toBe(
      renderDedupKey(event, DEFAULT_IDENTITY_FIELDS, 'staging'),
    );
  });

  it('prefixes the key with the deployment so the namespace stays readable', () => {
    expect(renderDedupKey(event, DEFAULT_IDENTITY_FIELDS, 'prod').startsWith('prod:')).toBe(true);
  });

  it('varies only the prefix — the identity digest is deployment-independent', () => {
    const prod = renderDedupKey(event, DEFAULT_IDENTITY_FIELDS, 'prod');
    const staging = renderDedupKey(event, DEFAULT_IDENTITY_FIELDS, 'staging');
    expect(prod.split(':')[1]).toBe(staging.split(':')[1]);
  });

  describe('resolveDeploymentId', () => {
    let saved: string | undefined;

    beforeEach(() => {
      saved = process.env[DEPLOYMENT_ID_ENV];
    });

    afterEach(() => {
      if (saved === undefined) {
        delete process.env[DEPLOYMENT_ID_ENV];
      } else {
        process.env[DEPLOYMENT_ID_ENV] = saved;
      }
    });

    it('reads the environment', () => {
      process.env[DEPLOYMENT_ID_ENV] = 'Prod-East';
      expect(resolveDeploymentId()).toBe('prod-east');
    });

    it('falls back to the default when unset or blank', () => {
      delete process.env[DEPLOYMENT_ID_ENV];
      expect(resolveDeploymentId()).toBe(DEFAULT_DEPLOYMENT_ID);
      process.env[DEPLOYMENT_ID_ENV] = '   ';
      expect(resolveDeploymentId()).toBe(DEFAULT_DEPLOYMENT_ID);
    });

    it('never emits a colon, so the key splits unambiguously', () => {
      process.env[DEPLOYMENT_ID_ENV] = 'east:1';
      const resolved = resolveDeploymentId();
      expect(resolved).not.toContain(':');
      expect(renderDedupKey({ target: 'web-1', alertname: 'NodeDown' }, DEFAULT_IDENTITY_FIELDS, resolved).split(':')
        .length).toBe(2);
    });
  });
});

describe('alert dedup key — the identity gate', () => {
  it('accepts an event carrying only an alert name', () => {
    expect(hasUsableIdentity({ alertname: 'NodeDown' })).toBe(true);
  });

  it('accepts an event carrying only a target', () => {
    expect(hasUsableIdentity({ target: 'web-1' })).toBe(true);
  });

  it('accepts an identity carried on labels rather than promoted columns', () => {
    expect(hasUsableIdentity({ labels: { alertname: 'NodeDown' } })).toBe(true);
  });

  it('rejects an event with neither half', () => {
    expect(hasUsableIdentity({})).toBe(false);
    expect(hasUsableIdentity({ target: '', alertname: '' })).toBe(false);
    expect(hasUsableIdentity({ target: '   ', alertname: '\t\n' })).toBe(false);
    expect(hasUsableIdentity({ severity: 'critical', job: 'cadvisor' })).toBe(false);
  });
});
