/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-171 R0 guard for the unified logging overlay: pinned images, a memory cap on every service, Docker reached only through a read-only proxy, the log store on loopback only with bounded retention, the Alloy pipeline pointed at the proxy and the store, and the overlay started by no script until the BACKLOG wiring lands.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadComposeYaml } from '@/shared/config';

interface ComposeService {
  image?: string;
  container_name?: string;
  command?: string[];
  mem_limit?: string;
  ports?: string[];
  volumes?: string[];
  environment?: Record<string, string | number>;
  networks?: string[];
}

interface ComposeFile {
  services: Record<string, ComposeService>;
  networks: Record<string, { external?: boolean; name?: string }>;
}

const root = process.cwd();
const COMPOSE_NAME = 'docker-compose.logging.yml';
const compose = loadComposeYaml(readFileSync(resolve(root, COMPOSE_NAME), 'utf8')) as ComposeFile;
const alloyConfig = readFileSync(resolve(root, 'ops/logging/config.alloy'), 'utf8');
const services = Object.entries(compose.services);
const proxy = compose.services['logging-docker-proxy'];
const store = compose.services.victorialogs;
const collector = compose.services.alloy;

/** Every file under a directory, skipping dependency trees. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === '.git') return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

describe('ADR-171 unified logging overlay', () => {
  it('pins every image to an explicit version, never a floating tag', () => {
    for (const [name, svc] of services) {
      expect(svc.image, `${name} image`).toMatch(/^[\w./-]+:v?\d+\.\d+\.\d+$/);
    }
  });

  it('caps the memory of every service, so the overlay cannot starve the core stack', () => {
    for (const [name, svc] of services) {
      expect(svc.mem_limit, `${name} mem_limit`).toMatch(/^\$\{[A-Z_]+:-\d+m\}$/);
    }
  });

  it('mounts the Docker socket into the proxy alone, read-only, with writes denied', () => {
    const socketHolders = services
      .filter(([, svc]) => (svc.volumes ?? []).some((v) => v.includes('docker.sock')))
      .map(([name]) => name);
    expect(socketHolders).toEqual(['logging-docker-proxy']);
    expect(proxy.volumes).toContain('/var/run/docker.sock:/var/run/docker.sock:ro');
    for (const key of ['POST', 'EXEC', 'BUILD', 'IMAGES', 'VOLUMES', 'SECRETS', 'SYSTEM']) {
      expect(proxy.environment?.[key], `proxy ${key}`).toBe(0);
    }
    expect(proxy.environment?.CONTAINERS).toBe(1);
    expect(proxy.ports).toBeUndefined();
  });

  it('publishes the store on loopback only and keeps the collector unpublished', () => {
    expect(store.ports).toHaveLength(1);
    expect(store.ports?.[0]).toMatch(/^127\.0\.0\.1:/);
    expect(collector.ports).toBeUndefined();
  });

  it('bounds the store by age and by disk size, and caps its cache', () => {
    const flags = (store.command ?? []).map((c) => c.split('=')[0]);
    expect(flags).toEqual(expect.arrayContaining([
      '-retentionPeriod',
      '-retention.maxDiskSpaceUsageBytes',
      '-memory.allowedBytes',
    ]));
  });

  it('joins the core stack network rather than creating its own', () => {
    expect(compose.networks.oshal).toEqual({ external: true, name: 'oshal-local_oshal' });
    for (const [name, svc] of services) {
      expect(svc.networks, `${name} networks`).toEqual(['oshal']);
    }
  });

  it('points the Alloy pipeline at the proxy and the store, never at the raw socket', () => {
    expect(collector.volumes).toContain('./ops/logging/config.alloy:/etc/alloy/config.alloy:ro');
    expect(alloyConfig).not.toMatch(/unix:\/\//);
    const hosts = [...alloyConfig.matchAll(/^\s*host\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
    expect(hosts.length).toBeGreaterThanOrEqual(2);
    for (const host of hosts) expect(host).toBe(`tcp://${proxy.container_name}:2375`);
    expect(alloyConfig).toContain(`http://${store.container_name}:9428/insert/loki/api/v1/push?`);
    expect(alloyConfig).toMatch(/_msg_field=msg,_msg/);
    expect(alloyConfig).toMatch(/values\s*=\s*\["oshal-local_oshal"\]/);
  });

  it('is started by no bring-up, deploy or installer script until the BACKLOG wiring lands', () => {
    // Operator decision 2026-09-29: configuration only. The change that wires the overlay in
    // replaces this assertion with one that pins it staying optional (ADR-171 R1).
    const candidates = [
      ...walk(resolve(root, 'scripts')),
      ...walk(resolve(root, 'installer')),
      ...readdirSync(root).filter((f) => /^install/i.test(f)).map((f) => resolve(root, f)),
    ].filter((f) => /\.(sh|js|mjs|cjs|ts|ps1|psm1|bat|cmd)$/.test(f) && existsSync(f) && statSync(f).isFile());
    expect(candidates.length).toBeGreaterThan(10);
    const referencing = candidates.filter((f) => readFileSync(f, 'utf8').includes(COMPOSE_NAME));
    expect(referencing).toEqual([]);
  });
});
