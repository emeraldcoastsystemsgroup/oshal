/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for Vault's own ServiceAccount (templates/vault.yaml SEQ 4). On the first Docker Desktop install the oshal-vault pod ran as the namespace's `default` ServiceAccount, which every infra pod without one of its own shares, so any RBAC granted for the Vault Kubernetes secrets engine (work-package item 14) would have reached postgres, redis and the rest. Renders the REAL chart in four postures and requires: the Vault pod's serviceAccountName is a ServiceAccount the same render creates, is not `default`, and is the effective ServiceAccount of no other workload (each pod's account resolved the way the API server defaults it); no Role, ClusterRole, RoleBinding or ClusterRoleBinding in the render reaches that account (by ServiceAccount subject, by its user name, or by the system:serviceaccounts groups that include it), and none is named for Vault; the pod's token is not withheld, because the engine authenticates with it. The values switch is held too: create=false uses the operator's account and renders none, and an empty name, the api's account or create=true on `default` fail the render, read from helm's own stderr. The README runbook's example is held to the minimal rules the engine needs in its generated-ServiceAccount mode, to a subject that is the account the render creates, and to the Vault role line that hands out the same Role it may bind.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import {
  CHART_DIR, DOCKER_DESKTOP_VALUES, RENDER_TIMEOUT_MS, helmRefusal, helmTemplate, type K8sObject, type RenderOptions,
} from '../helpers/helm-template';

/** The namespace helmTemplate renders into (tests/helpers/helm-template.ts runHelm). */
const NAMESPACE = 'oshal';
const README = fs.readFileSync(path.join(CHART_DIR, 'README.md'), 'utf8');
const RBAC_KINDS = new Set(['Role', 'ClusterRole', 'RoleBinding', 'ClusterRoleBinding']);

const POSTURES: Array<[string, RenderOptions]> = [
  ['defaults', {}],
  ['values-docker-desktop.yaml', { valuesFiles: [DOCKER_DESKTOP_VALUES] }],
  ['fleet=full, ollama on', { sets: ['fleet=full', 'infra.ollama.inCluster=true'] }],
];

/** A pod-bearing workload and the ServiceAccount its pods run as. */
interface PodIdentity { id: string; serviceAccount: string; automount?: boolean }

/**
 * @description The pod spec of any workload kind that carries one (a CronJob nests it one level
 * deeper), so no kind of workload escapes the "who else runs as it" check.
 * @param o rendered object
 * @returns {Record<string, any> | undefined} the pod spec, or undefined for a non-workload
 */
function podSpecOf(o: K8sObject): Record<string, any> | undefined {
  if (o.kind === 'Pod') return o.spec;
  if (o.kind === 'CronJob') return o.spec?.jobTemplate?.spec?.template?.spec;
  return o.spec?.template?.spec?.containers ? o.spec.template.spec : undefined;
}

/**
 * @description Every workload in a render with its effective ServiceAccount: serviceAccountName,
 * else the deprecated serviceAccount alias, else `default` - what the API server assigns a pod
 * that names none.
 * @param objects rendered objects
 * @returns {PodIdentity[]} one entry per pod-bearing object
 */
function podIdentities(objects: K8sObject[]): PodIdentity[] {
  return objects.flatMap((o) => {
    const pod = podSpecOf(o);
    if (!pod) return [];
    return [{ id: `${o.kind}/${o.metadata.name}`, serviceAccount: pod.serviceAccountName || pod.serviceAccount || 'default', automount: pod.automountServiceAccountToken }];
  });
}

/**
 * @description The identity of the Vault StatefulSet's pods. Throws when the render has none, so
 * nothing below can pass against an absent Vault.
 * @param objects rendered objects
 * @returns {PodIdentity} the Vault pod's identity
 */
function vaultIdentity(objects: K8sObject[]): PodIdentity {
  const v = podIdentities(objects).find((p) => p.id === 'StatefulSet/oshal-vault');
  if (!v) throw new Error('the render has no StatefulSet/oshal-vault');
  return v;
}

/**
 * @description Whether an RBAC subject includes a namespaced ServiceAccount: named directly, by
 * its user name, or through the groups every ServiceAccount (or every one in its namespace) is in.
 * @param s binding subject
 * @param name ServiceAccount name
 * @param bindingNs the binding's namespace (a ServiceAccount subject without one defaults to it)
 * @returns {boolean} true when the subject reaches that account
 */
function subjectReaches(s: Record<string, any>, name: string, bindingNs: string): boolean {
  if (s.kind === 'ServiceAccount') return s.name === name && (s.namespace ?? bindingNs) === NAMESPACE;
  if (s.kind === 'User') return s.name === `system:serviceaccount:${NAMESPACE}:${name}`;
  if (s.kind === 'Group') return s.name === 'system:serviceaccounts' || s.name === `system:serviceaccounts:${NAMESPACE}`;
  return false;
}

/**
 * @description Every RBAC object in a render that grants to, or is written for, a ServiceAccount:
 * a binding with a subject that reaches it, or a Role/ClusterRole named for Vault.
 * @param objects rendered objects
 * @param name ServiceAccount name
 * @returns {string[]} kind/name of each offending object
 */
function rbacFor(objects: K8sObject[], name: string): string[] {
  return objects.filter((o) => RBAC_KINDS.has(o.kind)).filter((o) => {
    const subjects = ((o as K8sObject & { subjects?: Array<Record<string, any>> }).subjects ?? []);
    const bindingNs = (o.metadata as { namespace?: string }).namespace ?? NAMESPACE;
    if (subjects.some((s) => subjectReaches(s, name, bindingNs))) return true;
    return /vault/i.test(o.metadata.name);
  }).map((o) => `${o.kind}/${o.metadata.name}`);
}

describe('the Vault pod runs as a ServiceAccount of its own', () => {
  it.each(POSTURES)('%s: a chart-created account, not default, shared by no other workload', (_label, opts) => {
    const objects = helmTemplate(opts);
    const vault = vaultIdentity(objects);
    expect(vault.serviceAccount, 'the Vault pod runs as the namespace default ServiceAccount every infra pod shares').not.toBe('default');
    const created = objects.filter((o) => o.kind === 'ServiceAccount').map((o) => o.metadata.name);
    expect(created, `the Vault pod runs as ${vault.serviceAccount}, which this render does not create`).toContain(vault.serviceAccount);
    const sharing = podIdentities(objects).filter((p) => p.id !== 'StatefulSet/oshal-vault' && p.serviceAccount === vault.serviceAccount);
    expect(sharing.map((p) => p.id), `other workloads run as Vault's ServiceAccount ${vault.serviceAccount}`).toEqual([]);
  }, RENDER_TIMEOUT_MS);

  it.each(POSTURES)('%s: the chart grants that account no RBAC, and leaves its token mounted', (_label, opts) => {
    const objects = helmTemplate(opts);
    const vault = vaultIdentity(objects);
    expect(rbacFor(objects, vault.serviceAccount), 'the chart renders RBAC for Vault: the engine\'s Role is operator config, per tenant (README "Vault runbook")').toEqual([]);
    // The Kubernetes secrets engine configured in-cluster authenticates with the pod's own token.
    expect(vault.automount, 'the Vault pod withholds its ServiceAccount token').not.toBe(false);
    const sa = objects.find((o) => o.kind === 'ServiceAccount' && o.metadata.name === vault.serviceAccount) as (K8sObject & { automountServiceAccountToken?: boolean }) | undefined;
    expect(sa?.automountServiceAccountToken, `ServiceAccount ${vault.serviceAccount} withholds its token`).not.toBe(false);
  }, RENDER_TIMEOUT_MS);

  it('a bot-pod render has no Vault and creates no Vault ServiceAccount', () => {
    const objects = helmTemplate({ valuesFiles: [path.join(CHART_DIR, 'values-bot-pod.example.yaml')] });
    expect(objects.filter((o) => o.kind === 'StatefulSet' && o.metadata.name === 'oshal-vault')).toEqual([]);
    expect(objects.filter((o) => o.kind === 'ServiceAccount' && /vault/i.test(o.metadata.name)).map((o) => o.metadata.name)).toEqual([]);
  }, RENDER_TIMEOUT_MS);
});

describe('infra.vault.serviceAccount', () => {
  it('create=false runs the pod as the operator\'s account and renders none', () => {
    const objects = helmTemplate({ sets: ['infra.vault.serviceAccount.create=false', 'infra.vault.serviceAccount.name=guard-own-vault'] });
    expect(vaultIdentity(objects).serviceAccount).toBe('guard-own-vault');
    expect(objects.filter((o) => o.kind === 'ServiceAccount').map((o) => o.metadata.name)).not.toContain('guard-own-vault');
  }, RENDER_TIMEOUT_MS);

  it('an empty name, the api\'s account, or creating `default` fails the render and says why', () => {
    expect(helmRefusal({ sets: ['infra.vault.serviceAccount.name='] })).toMatch(/infra\.vault\.serviceAccount\.name is empty/);
    const apiSa = (yaml.load(fs.readFileSync(path.join(CHART_DIR, 'values.yaml'), 'utf8')) as Record<string, any>).rbac.serviceAccountName;
    expect(helmRefusal({ sets: [`infra.vault.serviceAccount.name=${apiSa}`] })).toMatch(/rbac\.serviceAccountName/);
    expect(helmRefusal({ sets: ['infra.vault.serviceAccount.name=default'] })).toMatch(/cannot create a ServiceAccount named default/);
  }, RENDER_TIMEOUT_MS);
});

/** One RBAC rule as the runbook example writes it. */
interface Rule { apiGroups: string[]; resources: string[]; verbs: string[]; resourceNames?: string[] }

/**
 * @description The minimal rules the engine needs in the mode where Vault generates a
 * ServiceAccount per credential and binds it to an existing Role: create and delete that account
 * (get to see it), mint its token, create and delete its RoleBinding (get to see it), and `bind`
 * on exactly the Role it hands out. One `resource:verb` key per grant.
 */
const MINIMAL_GRANTS = [
  '|serviceaccounts:create', '|serviceaccounts:delete', '|serviceaccounts:get',
  '|serviceaccounts/token:create',
  'rbac.authorization.k8s.io|rolebindings:create', 'rbac.authorization.k8s.io|rolebindings:delete', 'rbac.authorization.k8s.io|rolebindings:get',
  'rbac.authorization.k8s.io|roles:bind',
].sort();

/**
 * @description The README "Vault runbook" section and every YAML document in its fenced blocks.
 * @returns {{ runbook: string, docs: Array<Record<string, any>> }} the section text and its YAML
 */
function runbookExample(): { runbook: string; docs: Array<Record<string, any>> } {
  const runbook = /^## Vault runbook\s*$([\s\S]*?)(?=^## )/m.exec(README)?.[1] ?? '';
  if (!runbook) throw new Error('deploy/helm/oshal/README.md has no "## Vault runbook" section');
  const blocks = [...runbook.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);
  const docs = blocks.flatMap((b) => yaml.loadAll(b) as Array<Record<string, any>>).filter((d) => d?.kind);
  return { runbook, docs };
}

describe('the README runbook carries the engine\'s RBAC as an operator example', () => {
  it('the example is the minimal rule set, namespaced, and binds the account the chart creates', () => {
    const { runbook, docs } = runbookExample();
    expect(runbook).toMatch(/binds no Role, RoleBinding or ClusterRole to `oshal-vault`/);
    expect(runbook).toMatch(/Not rendered by the chart/);
    expect(docs.filter((d) => d.kind.startsWith('Cluster')).map((d) => d.kind), 'the example grants cluster-wide').toEqual([]);
    const role = docs.find((d) => d.kind === 'Role');
    const binding = docs.find((d) => d.kind === 'RoleBinding');
    expect(role && binding, 'the runbook has no example Role and RoleBinding').toBeTruthy();
    const rules = (role!.rules ?? []) as Rule[];
    const grants = rules.flatMap((r) => r.apiGroups.flatMap((g) => r.resources.flatMap((res) => r.verbs.map((v) => `${g}|${res}:${v}`)))).sort();
    expect(grants, 'the example is not the minimal rule set for generated ServiceAccounts').toEqual(MINIMAL_GRANTS);
    for (const r of rules) {
      const bindsRoles = r.resources.includes('roles');
      expect(Boolean(r.resourceNames?.length), `${r.resources.join(',')}: resourceNames ${bindsRoles ? 'must name the one Role handed out' : 'is not expected here'}`).toBe(bindsRoles);
    }
    const vault = vaultIdentity(helmTemplate({}));
    expect(binding!.subjects, 'the example binds an account other than the one the chart creates').toEqual([{ kind: 'ServiceAccount', name: vault.serviceAccount, namespace: NAMESPACE }]);
    expect(binding!.roleRef).toEqual({ apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: role!.metadata.name });
    expect(binding!.metadata.namespace).toBe(role!.metadata.namespace);
    expect(role!.metadata.namespace, 'the example Role belongs in a tenant namespace, not the chart\'s').not.toBe(NAMESPACE);
  }, RENDER_TIMEOUT_MS);

  it('the Vault role line hands out the same Role, in the same namespace, the example may bind', () => {
    const { runbook, docs } = runbookExample();
    const role = docs.find((d) => d.kind === 'Role')!;
    const bindable = ((role.rules ?? []) as Rule[]).find((r) => r.resources.includes('roles'))?.resourceNames ?? [];
    const line = /vault write kubernetes\/roles\/\S+[\s\\]+([^`]*)/.exec(runbook)?.[1] ?? '';
    expect(line, 'the runbook has no `vault write kubernetes/roles/...` line').not.toBe('');
    expect(bindable).toEqual([/kubernetes_role_name=(\S+)/.exec(line)?.[1]]);
    expect(/allowed_kubernetes_namespaces=(\S+)/.exec(line)?.[1]).toBe(role.metadata.namespace);
  });
});
