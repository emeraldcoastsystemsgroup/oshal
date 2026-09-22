/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — a change to the shared config rolls every pod that reads it. Found live on Docker Desktop: `helm upgrade --set infra.arangodb.inCluster=true` put ARANGO_URL back into oshal-shared-env, nothing in the api's pod template changed, and the api kept answering /api/graph with 503 "ARANGO_URL not configured" until a manual restart. The consumers are found in the render itself (envFrom and valueFrom references to oshal-shared-env / oshal-shared-secret), never from a hand list, so a new consumer without the annotation is caught.
 */
import { describe, expect, it } from 'vitest';
import { DOCKER_DESKTOP_VALUES, RENDER_TIMEOUT_MS, helmTemplate, type K8sObject } from '../helpers/helm-template';

const SHARED: Record<string, { kind: 'configMap' | 'secret'; annotation: string }> = {
  'oshal-shared-env': { kind: 'configMap', annotation: 'checksum/shared-env' },
  'oshal-shared-secret': { kind: 'secret', annotation: 'checksum/shared-secret' },
};

type Workload = { id: string; annotations: Record<string, string>; reads: Set<string> };

/** Every workload in a render, with the shared config objects its containers read. */
function workloads(objects: K8sObject[]): Workload[] {
  return objects.filter(o => o.spec?.template?.spec?.containers).map(o => {
    const pod = o.spec.template.spec;
    const reads = new Set<string>();
    for (const c of [...(pod.initContainers || []), ...pod.containers]) {
      for (const f of c.envFrom || []) {
        const name = f.configMapRef?.name || f.secretRef?.name;
        if (name && SHARED[name]) reads.add(name);
      }
      for (const e of c.env || []) {
        const name = e.valueFrom?.configMapKeyRef?.name || e.valueFrom?.secretKeyRef?.name;
        if (name && SHARED[name]) reads.add(name);
      }
    }
    return { id: `${o.kind}/${o.metadata.name}`, annotations: o.spec.template.metadata?.annotations || {}, reads };
  });
}

function checksumsOf(opts: { sets?: string[]; valuesFiles?: string[] }): Map<string, Record<string, string>> {
  return new Map(workloads(helmTemplate(opts)).map(w => [w.id, w.annotations]));
}

const POSTURES: Array<[string, { sets?: string[]; valuesFiles?: string[] }]> = [
  ['defaults', {}],
  ['values-docker-desktop.yaml', { valuesFiles: [DOCKER_DESKTOP_VALUES] }],
];

describe('a shared config change rolls the pods that read it', () => {
  for (const [label, opts] of POSTURES) {
    it(`${label}: every consumer of a shared ConfigMap/Secret carries its checksum`, () => {
      const all = workloads(helmTemplate(opts));
      const consumers = all.filter(w => w.reads.size > 0);
      expect(consumers.length, 'the render has consumers of the shared config').toBeGreaterThan(1);
      const missing: string[] = [];
      for (const w of consumers) {
        for (const name of w.reads) {
          const value = w.annotations[SHARED[name].annotation];
          if (!value || !/^[0-9a-f]{64}$/.test(value)) missing.push(`${w.id} reads ${name} but has no ${SHARED[name].annotation}`);
        }
      }
      expect(missing).toEqual([]);
    }, RENDER_TIMEOUT_MS);
  }

  it('switching an infra service changes the shared-env checksum on the api and on every bot', () => {
    const on = checksumsOf({ valuesFiles: [DOCKER_DESKTOP_VALUES] });
    const off = checksumsOf({ valuesFiles: [DOCKER_DESKTOP_VALUES], sets: ['infra.arangodb.inCluster=false'] });
    const readers = workloads(helmTemplate({ valuesFiles: [DOCKER_DESKTOP_VALUES] }))
      .filter(w => w.reads.has('oshal-shared-env')).map(w => w.id);
    expect(readers).toContain('Deployment/oshal-api');
    const unchanged = readers.filter(id => on.get(id)?.['checksum/shared-env'] === off.get(id)?.['checksum/shared-env']);
    expect(unchanged, 'these kept the same pod template, so they would keep a stale ARANGO_URL').toEqual([]);
  }, RENDER_TIMEOUT_MS);

  it('a change that leaves the shared config alone does not roll its consumers', () => {
    const base = checksumsOf({});
    const other = checksumsOf({ sets: ['api.resources.requests.cpu=750m'] });
    expect(other.get('Deployment/oshal-api')?.['checksum/shared-env']).toBe(base.get('Deployment/oshal-api')?.['checksum/shared-env']);
    expect(other.get('Deployment/oshal-api')?.['checksum/shared-secret']).toBe(base.get('Deployment/oshal-api')?.['checksum/shared-secret']);
  }, RENDER_TIMEOUT_MS);
});
