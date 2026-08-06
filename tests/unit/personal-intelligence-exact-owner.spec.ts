/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard exact ownerSub propagation through personal-vault layout resolution and store calls while retaining empty-owner fallback and fail-closed behavior.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard digest-keyed filesystem layout plus the shared exact-subject contract: nullish absence alone may use a default, valid whitespace remains distinct, and empty/control assertions fail closed.
 */

import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  PersonalIntelligenceService,
  type PersonalIntelligenceConfig,
  type VaultStore,
} from '../../src/features/personal-data/personal-intelligence-service';
import type { SchemaContribution } from '../../src/features/personal-data/schema-contribution';
import { exactSubjectDirectoryKey } from '../../src/shared/security/exact-subject-store';

function contribution(ownerSub: string): SchemaContribution {
  return {
    ownerSub,
    provenance: { source: 'exact-owner-spec', ingestedAt: '2026-08-05T12:00:00.000Z', confidence: 1 },
    entities: [{
      ref: 'person', type: 'person', match: { id: 'one' }, label: 'Person', attrs: {},
      worldRef: null, confidence: 1,
    }],
    edges: [],
    facts: [],
  };
}

function fixture(defaultOwnerSub: string | null = null) {
  const store: VaultStore = {
    resolveEntity: vi.fn(async () => null),
    upsertEntity: vi.fn(async () => ({ id: 'entity-one', merged: false })),
    upsertEdge: vi.fn(async () => ({ id: 'edge-one' })),
    writeFact: vi.fn(async () => undefined),
  };
  const config: PersonalIntelligenceConfig = {
    storeRoot: 'C:\\vault-spec', tenant: 'tenant-one', defaultOwnerSub, contributionFloor: 0.4,
  };
  return { service: new PersonalIntelligenceService(config, store), store };
}

describe('PersonalIntelligenceService exact owner identity', () => {
  it('preserves case and surrounding whitespace in the vault namespace and every store call', async () => {
    const ownerSub = ' Auth0|Case-Sensitive ';
    const { service, store } = fixture();
    await service.ingest(contribution(ownerSub));

    expect(store.resolveEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectDir: path.join(path.resolve('C:\\vault-spec'), 'tenant-one', exactSubjectDirectoryKey(ownerSub)),
        graphPartition: `pkg:${ownerSub}`,
        vectorCollection: `vault_${ownerSub}`,
        metricNamespace: ownerSub,
      }),
      ownerSub,
      'person',
      { id: 'one' },
    );
    expect(store.upsertEntity).toHaveBeenCalledWith(expect.any(Object), ownerSub, expect.any(Object), expect.any(Object));
  });

  it('uses the exact default only for absence and validates every supplied subject without trimming', async () => {
    const exactDefault = ' Default|Owner ';
    const fallback = fixture(exactDefault);
    await fallback.service.ingest(contribution(undefined as unknown as string));
    expect(fallback.store.resolveEntity).toHaveBeenCalledWith(
      expect.objectContaining({ graphPartition: `pkg:${exactDefault}` }),
      exactDefault,
      'person',
      { id: 'one' },
    );

    await expect(fixture().service.ingest(contribution(undefined as unknown as string))).rejects.toThrow('no ownerSub');
    await expect(fixture(exactDefault).service.ingest(contribution(''))).rejects.toThrow(/exact UTF-8/);
    await expect(fixture(exactDefault).service.ingest(contribution('bad\nowner'))).rejects.toThrow(/exact UTF-8/);

    const whitespace = fixture();
    await whitespace.service.ingest(contribution('   '));
    expect(whitespace.store.resolveEntity).toHaveBeenCalledWith(
      expect.objectContaining({ graphPartition: 'pkg:   ' }),
      '   ',
      'person',
      { id: 'one' },
    );
  });
});
