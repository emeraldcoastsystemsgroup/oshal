/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the two readiness probes the first Docker Desktop Kubernetes install (2026-09-21) found could never pass, which left `helm --wait` to time out and each Service with no endpoints. (a) ArangoDB: the probe asked /_api/version, which ArangoDB authenticates once a root password is set (and the chart sets one), so it got 401 forever and the graph tier was unreachable; it must ask /_admin/server/availability, which ArangoDB serves without auth. (b) speaker-diarization: /health is key-authenticated behind Starlette's TrustedHostMiddleware, so a bare kubelet probe (Host = pod IP, no key) got refused forever. The probe must carry the service's key header with the SAME value the container is given, and a Host the service admits. Both halves are read from the service's own Python source (header name, key env, allowlist env, default allowlist, /health's authentication), not copied, so a renamed header or a narrowed allowlist goes red here instead of on a cluster. Renders the REAL chart; no helm is a loud failure.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The ArangoDB precondition (a root password is set, so /_api/version answers 401) reads the password through the render: chart 0.5.0 moved it from a literal env value to a secretKeyRef into the oshal-shared-secret Secret, and a literal-only read would see no password and fail on a working chart.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DOCKER_DESKTOP_VALUES, REPO_ROOT, RENDER_TIMEOUT_MS, containerOf, envValue, helmTemplate, resolvedEnv,
} from '../helpers/helm-template';

const SPEAKER_SRC = path.join(REPO_ROOT, 'services', 'speaker-diarization', 'speaker_service');
const SETTINGS_PY = fs.readFileSync(path.join(SPEAKER_SRC, 'settings.py'), 'utf8');
const API_PY = fs.readFileSync(path.join(SPEAKER_SRC, 'api.py'), 'utf8');

/** ArangoDB's unauthenticated availability endpoint; /_api/version answers 401 once auth is on. */
const ARANGO_UNAUTHENTICATED_PATH = '/_admin/server/availability';
const ARANGO_AUTHENTICATED_PATH = '/_api/version';
const PROBE_KINDS = ['readinessProbe', 'livenessProbe', 'startupProbe'];

/** The two postures the guards hold: chart defaults and the Docker Desktop overlay that ran live. */
const POSTURES: Array<[string, { valuesFiles?: string[] }]> = [
  ['defaults', {}],
  ['values-docker-desktop.yaml', { valuesFiles: [DOCKER_DESKTOP_VALUES] }],
];

/**
 * @description The first capture group of a pattern in a source file, or a thrown error naming
 * what could not be found - a parse that silently returns nothing would let every check pass.
 * @param source file text
 * @param pattern regex with one capture group
 * @param what human description for the failure message
 * @returns {string} the captured text
 */
function capture(source: string, pattern: RegExp, what: string): string {
  const m = pattern.exec(source);
  if (!m?.[1]) throw new Error(`could not read ${what} from the speaker service source`);
  return m[1];
}

/**
 * @description The source of one top-level Python function, up to the next top-level
 * statement, so a pattern is matched inside that function and nowhere else.
 * @param source file text
 * @param name function name
 * @returns {string} the function's source
 */
function pyFunction(source: string, name: string): string {
  const start = source.indexOf(`def ${name}(`);
  if (start < 0) throw new Error(`speaker service source has no function ${name}`);
  const rest = source.slice(start);
  const end = rest.slice(1).search(/\n(?:def |class |@|[A-Za-z_])/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

/** What the speaker service itself says a probe must satisfy, read from its source. */
const service = {
  keyHeader: capture(pyFunction(API_PY, '_authenticate'), /request\.headers\.get\(\s*"([^"]+)"/, 'the key header'),
  keyEnv: capture(SETTINGS_PY, /service_key=os\.getenv\(\s*"([A-Z_]+)"/, 'the service key env name'),
  hostsEnv: capture(pyFunction(SETTINGS_PY, '_allowed_hosts'), /os\.getenv\(\s*"([A-Z_]+)"/, 'the allowed-hosts env name'),
  defaultHosts: [...capture(SETTINGS_PY, /^DEFAULT_ALLOWED_HOSTS\s*=\s*\(([^)]*)\)/m, 'DEFAULT_ALLOWED_HOSTS')
    .matchAll(/"([^"]+)"/g)].map((m) => m[1]),
  healthPath: capture(API_PY, /add_route\(\s*"([^"]+)"\s*,\s*_health_handler\(/, 'the /health route'),
};

/**
 * @description The httpGet readiness probe of a container; throws when it is missing.
 * @param container container spec
 * @returns the httpGet block
 */
function readinessGet(container: Record<string, any>): Record<string, any> {
  const get = container.readinessProbe?.httpGet;
  if (!get) throw new Error(`container ${container.name} has no httpGet readinessProbe`);
  return get;
}

/**
 * @description A probe header value by name, case-insensitively (HTTP header names are).
 * @param get httpGet block
 * @param name header name
 * @returns {string | undefined} the value
 */
function header(get: Record<string, any>, name: string): string | undefined {
  return (get.httpHeaders ?? []).find((h: { name: string }) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

describe('ArangoDB readiness probe asks an endpoint ArangoDB serves without auth', () => {
  it.each(POSTURES)('%s: authentication is on, and no probe asks /_api/version', (_label, opts) => {
    const objects = helmTemplate(opts);
    const c = containerOf(objects, 'StatefulSet', 'oshal-arangodb', 'arangodb');
    // The precondition that makes /_api/version a 401: a non-empty root password turns auth on.
    // Without it every path would pass and this guard would prove nothing. The password is a
    // secretKeyRef into the chart's own Secret, so it is resolved through the render.
    expect(resolvedEnv(objects, c).ARANGO_ROOT_PASSWORD, 'the arangodb container sets no root password').toBeTruthy();
    for (const kind of PROBE_KINDS) {
      expect(c[kind]?.httpGet?.path, `${kind} asks the authenticated ${ARANGO_AUTHENTICATED_PATH}`).not.toBe(ARANGO_AUTHENTICATED_PATH);
    }
    const get = readinessGet(c);
    expect(get.path, 'the readiness probe must ask the unauthenticated availability endpoint').toBe(ARANGO_UNAUTHENTICATED_PATH);
    expect(header(get, 'authorization'), 'the probe must not carry the root credential').toBeUndefined();
    const ports = (c.ports ?? []).map((p: { containerPort: number }) => p.containerPort);
    expect(ports, 'the probe port is not a port the container listens on').toContain(get.port);
  }, RENDER_TIMEOUT_MS);
});

describe('speaker-diarization readiness probe satisfies the service it probes', () => {
  it('the service source still authenticates /health and still reads the names this guard derives', () => {
    // /health calls _authenticate first: that is WHY the probe needs the key at all.
    expect(pyFunction(API_PY, '_health_handler'), '/health no longer authenticates - re-read this guard').toMatch(/_authenticate\(/);
    expect(API_PY, 'the trusted-host allowlist is why the probe needs a Host header').toMatch(/TrustedHostMiddleware/);
    expect(service.defaultHosts.length, 'DEFAULT_ALLOWED_HOSTS parsed empty').toBeGreaterThan(0);
  });

  it.each(POSTURES)('%s: the probe sends the container\'s own key and an admitted Host', (_label, opts) => {
    const c = containerOf(helmTemplate(opts), 'Deployment', 'speaker-diarization', 'diarization');
    const get = readinessGet(c);
    expect(get.path).toBe(service.healthPath);
    const key = envValue(c, service.keyEnv);
    expect(key, `the container sets no ${service.keyEnv}`).toBeTruthy();
    expect(header(get, service.keyHeader), `the probe must send ${service.keyHeader} equal to the container's ${service.keyEnv}`).toBe(key);
    // The allowlist the service will actually enforce: its env override if the chart sets one,
    // otherwise its compiled default.
    const override = envValue(c, service.hostsEnv);
    const allowed = override ? override.split(',').map((h) => h.trim()) : service.defaultHosts;
    const host = header(get, 'host');
    expect(host, 'no Host header: the kubelet would send the pod IP, which the allowlist refuses').toBeTruthy();
    expect(allowed, `Host ${host} is not admitted by the service's allowlist`).toContain(String(host).replace(/:\d+$/, ''));
  }, RENDER_TIMEOUT_MS);

  it('the key header follows infra.diarization.serviceKey rather than a literal', () => {
    const key = 'guard-rotated-speaker-key';
    const c = containerOf(helmTemplate({ sets: [`infra.diarization.serviceKey=${key}`] }), 'Deployment', 'speaker-diarization', 'diarization');
    expect(envValue(c, service.keyEnv)).toBe(key);
    expect(header(readinessGet(c), service.keyHeader)).toBe(key);
  }, RENDER_TIMEOUT_MS);
});
