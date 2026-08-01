/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prometheus exposition for the swarm's own runtimes. The live container-kill drill (2026-08-01) proved cAdvisor emits ZERO series for any docker container on Docker Desktop 29's containerd/`overlayfs` image store — its docker factory dies in getRwLayerID because /var/lib/docker/image/overlayfs/layerdb does not exist in that layout — so every `container_last_seen{name=~"oshal-local-.+"}` rule matched nothing and SwarmContainerDown was a standing, target-less false alarm. The swarm now reports its OWN liveness/restart/memory/CPU in the Prometheus text format, so the self-healing rules key on series the platform itself guarantees instead of on a host-level collector that may not see it.
 */

/**
 * Prometheus text-exposition (v0.0.4) for an oshal runtime process.
 *
 * WHY THE SWARM EXPORTS ITS OWN METRICS: the self-healing loop needs two things from a
 * container-health signal — that it EXISTS on every deployment, and that it carries a usable
 * target identity. A host-level collector gives neither reliably: cAdvisor cannot enumerate
 * docker containers at all on Docker Desktop's containerd image store (proven live, see the
 * change log), and even where it works its `name` label depends on privileged host mounts.
 * A scrape of the process itself is portable — Docker Desktop, plain Linux, or k8s — and
 * Prometheus's own `up` metric plus the per-target `container` label give the alert an exact
 * identity, which ADR-119 P1's identity gate REQUIRES (identity-less alerts are dropped) and
 * P2/P4 need in order to bundle and to bound core-infra.
 *
 * What is deliberately NOT here: request counters, per-route histograms, business metrics.
 * This module exists to make container health alertable; growing it into a general
 * application-metrics surface is a separate decision (and would want a real client library).
 *
 * @module shared/observability/runtime-metrics
 */

import { readFileSync } from 'node:fs';

/** Which of the two runtimes (Dockerfile.oshal ships both) is reporting. */
export type OshalRuntimeKind = 'swarm' | 'bot-node';

/** @description Identity stamped on every series this process exports. */
export interface RuntimeMetricsIdentity {
  /** `swarm` = the controller/api, `bot-node` = an LLM execution worker. */
  runtime: OshalRuntimeKind;
  /** The bot/service name this process answers as ('' when the process has no name). */
  instance: string;
}

/** cgroup v2 memory ceiling; the literal string `max` means unlimited. */
const CGROUP_V2_MEMORY_MAX = '/sys/fs/cgroup/memory.max';

/** cgroup v1 memory ceiling; "unlimited" is encoded as an implausibly large number. */
const CGROUP_V1_MEMORY_MAX = '/sys/fs/cgroup/memory/memory.limit_in_bytes';

/**
 * cgroup v1 writes "no limit" as PAGE_COUNTER_MAX * PAGE_SIZE — a number in the
 * 9.2e18 range. Anything at or above 2^53 is not a real container limit; treating it as one
 * would make the HighMemory rule's ratio permanently ~0 and the alert permanently silent.
 */
const V1_UNLIMITED_FLOOR = 2 ** 53;

/** Memoized cgroup limit: a container's memory ceiling does not change while it runs. */
let memoryLimitCache: number | null = null;

/** Reader seam so the guard can drive both cgroup layouts and the "no cgroup" host case. */
export type FileReader = (path: string) => string;

const defaultReader: FileReader = (path) => readFileSync(path, 'utf8');

/**
 * @description Resolves this container's memory ceiling in bytes, or 0 when there is no
 * enforceable limit (bare metal, an unlimited cgroup, or an unreadable cgroupfs). 0 is a
 * meaningful value, not an error: the HighMemory rule requires `limit > 0`, so an
 * unconstrained process can never trip a percentage-of-limit alert.
 * @param read - File reader (injected by the guard).
 * @param useCache - False to bypass the memo (guards only).
 * @returns Memory limit in bytes, 0 when unlimited/unknown.
 */
export function containerMemoryLimitBytes(read: FileReader = defaultReader, useCache = true): number {
  if (useCache && memoryLimitCache !== null) return memoryLimitCache;
  let resolved = 0;
  try {
    const raw = read(CGROUP_V2_MEMORY_MAX).trim();
    // cgroup v2 spells unlimited as the word `max`; anything else is a byte count.
    if (raw && raw !== 'max') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) resolved = parsed;
    }
  } catch {
    // No cgroup v2 (v1 host, or not containerised) — fall through to v1.
  }
  if (resolved === 0) {
    try {
      const parsed = Number(read(CGROUP_V1_MEMORY_MAX).trim());
      if (Number.isFinite(parsed) && parsed > 0 && parsed < V1_UNLIMITED_FLOOR) resolved = parsed;
    } catch {
      // Not containerised, or cgroupfs is not mounted — 0 (no limit) is the honest answer.
    }
  }
  if (useCache) memoryLimitCache = resolved;
  return resolved;
}

/** Reset the cgroup memo (guards only, so one spec can drive several layouts). */
export function _resetMemoryLimitCache(): void {
  memoryLimitCache = null;
}

/**
 * @description Escapes a Prometheus label VALUE per the exposition format (backslash, double
 * quote, newline). A container name should never contain these, but an unescaped value would
 * corrupt the whole scrape rather than one series — Prometheus rejects the entire body.
 * @param value - Raw label value.
 * @returns Escaped value.
 */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** One exported series: name, help text, type, and value. */
interface Series {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  value: number;
}

/**
 * @description Renders the Prometheus text exposition for this process.
 *
 * `oshal_up` is intentionally present even though Prometheus synthesizes `up` itself: `up`
 * proves the SCRAPE succeeded, `oshal_up` proves an oshal runtime (not some other service that
 * happens to hold the port) answered it.
 *
 * @param identity - Runtime kind + instance name for the shared label set.
 * @param nowMs - Current epoch milliseconds (injected for deterministic guards).
 * @param read - cgroup reader (injected for deterministic guards).
 * @returns The exposition body, `text/plain; version=0.0.4` with a trailing newline.
 */
export function renderRuntimeMetrics(
  identity: RuntimeMetricsIdentity,
  nowMs: number = Date.now(),
  read: FileReader = defaultReader,
): string {
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  const series: Series[] = [
    {
      name: 'oshal_up',
      help: '1 when an oshal runtime process is serving this scrape target.',
      type: 'gauge',
      value: 1,
    },
    {
      name: 'oshal_process_start_time_seconds',
      help: 'Unix epoch seconds at which this process started. A change is a restart.',
      type: 'gauge',
      // uptime() is monotonic within the process, so start time stays stable across scrapes
      // (Date.now() - uptime is not perturbed by wall-clock adjustments the way a cached
      // timestamp would be by a clock step). changes()[10m] over this IS the restart count.
      value: (nowMs - Math.round(process.uptime() * 1000)) / 1000,
    },
    {
      name: 'oshal_process_cpu_seconds_total',
      help: 'Total user + system CPU seconds consumed by this process.',
      type: 'counter',
      value: (cpu.user + cpu.system) / 1_000_000,
    },
    {
      name: 'oshal_process_resident_memory_bytes',
      help: 'Resident set size of this process in bytes.',
      type: 'gauge',
      value: memory.rss,
    },
    {
      name: 'oshal_process_memory_limit_bytes',
      help: 'cgroup memory ceiling in bytes; 0 when the process runs with no enforceable limit.',
      type: 'gauge',
      value: containerMemoryLimitBytes(read),
    },
  ];

  const labels =
    `{runtime="${escapeLabelValue(identity.runtime)}",instance_name="${escapeLabelValue(identity.instance)}"}`;

  return `${series
    .map((s) => [`# HELP ${s.name} ${s.help}`, `# TYPE ${s.name} ${s.type}`, `${s.name}${labels} ${s.value}`].join('\n'))
    .join('\n')}\n`;
}

/** Content type Prometheus expects for the text exposition format. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
