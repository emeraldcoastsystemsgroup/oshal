/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the Kubernetes bot launcher against its own chart Role. The cockpit enable/disable toggle PATCHes the deployments/scale SUBRESOURCE, and the chart granted only `deployments` — a distinct RBAC resource — so every toggle on a real cluster would have 403'd while the docker half worked fine. The needed grants are DERIVED from the launcher's own request paths rather than hand-listed, so a new API call that nothing authorises reddens here instead of in a customer's cluster.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LAUNCHER = path.join(REPO_ROOT, 'src', 'features', 'agent-management', 'services', 'kubernetes-bot-launcher.ts');
const RBAC = path.join(REPO_ROOT, 'deploy', 'helm', 'oshal', 'templates', 'rbac.yaml');

interface PolicyRule { apiGroups?: string[]; resources?: string[]; verbs?: string[] }

/** One API surface the launcher addresses: the RBAC apiGroup and the RBAC resource name. */
interface Addressed { apiGroup: string; resource: string; path: string }

/**
 * @description Derive the API surfaces the launcher actually calls from its request paths, the way
 * the apiserver reads them: `/api/v1/...` is the core group (""), `/apis/<group>/<version>/...` is
 * that group, the segment after `namespaces/<ns>/` is the resource, and a LITERAL segment after the
 * object name is a subresource — which RBAC authorises as `resource/subresource`, never as the
 * parent resource.
 * @returns Every distinct surface, with the source path that produced it.
 */
function addressedSurfaces(source: string): Addressed[] {
  const out = new Map<string, Addressed>();
  for (const match of source.matchAll(/`(\/api(?:s\/[a-z.]+)?\/v[0-9a-z]+\/namespaces\/[^`]+)`/g)) {
    const raw = match[1];
    const groupMatch = /^\/apis\/([a-z.]+)\//.exec(raw);
    const apiGroup = groupMatch ? groupMatch[1] : '';
    const after = raw.split(/namespaces\/[^/]+\//)[1];
    if (!after) continue;
    const segments = after.split('/');
    const resource = segments[0];
    // segments[1] is the object name (a `${...}` interpolation); a third LITERAL segment is the
    // subresource. Anything still carrying an interpolation is a name, not a subresource.
    const sub = segments.length > 2 && !segments[2].includes('${') ? segments[2] : '';
    const full = sub ? `${resource}/${sub}` : resource;
    out.set(`${apiGroup}|${full}`, { apiGroup, resource: full, path: raw });
  }
  return [...out.values()];
}

/** @description Load the chart's bot-launcher Role, dropping the helm directives so it parses. */
function launcherRoleRules(): PolicyRule[] {
  const text = fs.readFileSync(RBAC, 'utf8').split('\n').filter(line => !line.includes('{{')).join('\n');
  const docs = yaml.loadAll(text) as Array<Record<string, any>>;
  const role = docs.find(doc => doc?.kind === 'Role' && doc?.metadata?.name === 'oshal-bot-launcher');
  expect(role, 'the oshal-bot-launcher Role is gone from the chart').toBeTruthy();
  return (role!.rules ?? []) as PolicyRule[];
}

describe('the Kubernetes bot launcher is authorised for every call it makes', () => {
  const source = fs.readFileSync(LAUNCHER, 'utf8');
  const rules = launcherRoleRules();

  it('derives the surfaces from the launcher itself — including the scale subresource', () => {
    const surfaces = addressedSurfaces(source).map(s => `${s.apiGroup}|${s.resource}`);
    // If this fails the extractor stopped seeing the code, and every assertion below is vacuous.
    expect(surfaces).toContain('apps|deployments');
    expect(surfaces).toContain('|services');
    expect(surfaces, 'setRunning PATCHes deployments/scale — see kubernetes-bot-launcher setRunning')
      .toContain('apps|deployments/scale');
  });

  it('grants every surface the launcher addresses', () => {
    const ungranted = addressedSurfaces(source).filter(surface => !rules.some(rule =>
      (rule.apiGroups ?? []).includes(surface.apiGroup) && (rule.resources ?? []).includes(surface.resource)));
    expect(ungranted.map(s => `${s.resource} (${s.path})`),
      'the launcher calls an API the chart Role does not authorise — add the rule, do not widen an existing one').toEqual([]);
  });

  it('carries patch on the scale subresource, because the toggle PATCHes it', () => {
    const scale = rules.find(rule => (rule.resources ?? []).includes('deployments/scale'));
    expect(scale?.verbs ?? []).toContain('patch');
    // A grant on the parent resource does not cover the subresource, so the two rules stay distinct.
    const parent = rules.find(rule => (rule.resources ?? []).includes('deployments'));
    expect(parent?.resources).not.toContain('deployments/scale');
  });
});
