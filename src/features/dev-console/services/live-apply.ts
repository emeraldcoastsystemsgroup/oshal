/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Dev-mode fast lanes (ADR-077 gap 3): apply an approved asset/manifest/persona/package change to the LIVE tree and take exactly the restart action that class requires. Previously every self-edit, including a cockpit CSS tweak, could only reach the running stack through clone -> commit -> push -> image rebuild, so the cheap 90% of platform work paid the price of the expensive 10%. core/infra are refused here by construction, not by convention: they route to the PR + verified-deploy path instead.
 */

import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createChildLogger } from '@/shared/logger';
import {
  classifyChangeSet,
  isLiveAppliable,
  normalizeRepoRelative,
  restartActionFor,
  type ChangeClass,
  type RestartAction,
} from './change-class';
import { buildDevSessionProcessEnv } from './dev-session-engine';

const logger = createChildLogger({ module: 'live-apply' });

/** Path segments no live apply may ever write through, whatever the class says. */
const FORBIDDEN_SEGMENTS = new Set(['.git', '.githooks', 'node_modules']);

/** One file to write into the live tree. */
export interface LiveChange {
  /** Repo-relative path (POSIX or Windows separators). */
  path: string;
  /** Full file content - live apply writes whole files, never patches. */
  content: string;
}

/** What happened to the restart the applied class required. */
export interface RestartOutcome {
  action: RestartAction;
  /** Manifest paths reloaded, or container names restarted. */
  targets: string[];
  executed: boolean;
  detail: string;
}

/** A refusal: the change set is not eligible for the live tree at all. */
export interface LiveApplyRefusal {
  applied: false;
  cls: ChangeClass;
  reason: string;
  /** Where the change must go instead. */
  route: 'pull-request' | 'operator';
}

/** A successful live apply. */
export interface LiveApplySuccess {
  applied: true;
  cls: ChangeClass;
  written: string[];
  restart: RestartOutcome;
}

export type LiveApplyResult = LiveApplyRefusal | LiveApplySuccess;

/** Restarts one container by name; injectable so the confinement guards need no Docker. */
export type ContainerRestarter = (containerName: string) => Promise<{ ok: boolean; detail: string }>;

/** Reloads one swarm-app manifest by repo-relative path. */
export type ManifestReloader = (manifestPath: string) => Promise<{ ok: boolean; detail: string }>;

/** Configuration for the live applier. */
export interface LiveApplierConfig {
  repoRoot: string;
  /** Container name prefix - compose's project name. Containers are `<prefix>-<service>`. */
  containerPrefix?: string;
  /** Base URL of the api used for manifest hot-load. */
  apiBaseUrl?: string;
  /** Service secret for the api's trusted-service header. Never logged. */
  serviceSecret?: string;
  restarter?: ContainerRestarter;
  reloader?: ManifestReloader;
}

/**
 * @description Applies an approved change set to the live tree and performs the restart its
 * class requires.
 *
 * The refusal of `core` and `infra` is the security property: `core` is compiled into the
 * image, so writing it live would leave the running container serving code no image contains
 * (and the next deploy would silently revert it), and `infra` is operator-owned. Both are
 * returned as explicit refusals with the route to take instead - never downgraded, never
 * partially applied.
 */
export class LiveApplier {
  private readonly repoRoot: string;
  private readonly containerPrefix: string;
  private readonly apiBaseUrl: string;
  private readonly serviceSecret: string;
  private readonly restarter: ContainerRestarter;
  private readonly reloader: ManifestReloader;

  /**
   * @description Builds an applier bound to one live checkout.
   * @param config - Repo root plus optional container prefix, api coordinates and injected effects.
   */
  constructor(config: LiveApplierConfig) {
    this.repoRoot = path.resolve(config.repoRoot);
    this.containerPrefix = config.containerPrefix ?? process.env.COMPOSE_PROJECT_NAME ?? 'oshal-local';
    this.apiBaseUrl = (config.apiBaseUrl ?? process.env.OSHAL_API_URL ?? 'http://localhost:35457').replace(/\/$/, '');
    this.serviceSecret = config.serviceSecret ?? process.env.SWARM_SERVICE_SECRET ?? '';
    this.restarter = config.restarter ?? this.defaultRestarter.bind(this);
    this.reloader = config.reloader ?? this.defaultReloader.bind(this);
  }

  /**
   * @description Classifies the set, refuses anything not live-appliable, writes the files
   * path-confined, then performs the class's restart action.
   * @param changes - The approved files to write.
   * @returns A refusal with a route, or the applied paths plus the restart outcome.
   */
  async apply(changes: readonly LiveChange[]): Promise<LiveApplyResult> {
    if (!changes.length) {
      return { applied: false, cls: 'core', reason: 'empty change set', route: 'pull-request' };
    }
    const cls = classifyChangeSet(changes.map((c) => c.path));
    if (!isLiveAppliable(cls)) {
      return {
        applied: false,
        cls,
        reason: cls === 'infra'
          ? 'infra changes (compose, Dockerfile, env, helm, CI) are operator-only and are never applied automatically'
          : 'core changes are compiled into the image - applying them live would serve code no image contains; land them via PR and promote',
        route: cls === 'infra' ? 'operator' : 'pull-request',
      };
    }

    // Resolve EVERY target before writing ANY of them: a set that is half-written because the
    // ninth path escaped the repo is worse than a set that was refused.
    const targets = changes.map((change) => ({ abs: this.resolveConfined(change.path), content: change.content }));
    const written: string[] = [];
    for (const target of targets) {
      mkdirSync(path.dirname(target.abs), { recursive: true });
      writeFileSync(target.abs, target.content, 'utf8');
      written.push(path.relative(this.repoRoot, target.abs).replace(/\\/g, '/'));
    }
    logger.info({ cls, count: written.length }, 'live apply wrote change set');

    const restart = await this.performRestart(cls, written);
    return { applied: true, cls, written, restart };
  }

  /**
   * @description Resolves a repo-relative path to an absolute path inside the repo, refusing
   * traversal, absolute inputs, forbidden segments, a symlink at the target, and - the case a
   * string-prefix check alone misses - a symlinked or JUNCTIONED intermediate directory. A
   * lexical `startsWith(repoRoot)` says `<repo>/src/pages/link/x.js` is confined; if `link` is
   * a junction, the write still lands outside the repo. So the deepest existing ancestor is
   * resolved through realpath and re-checked.
   * @param relPath - The caller-supplied repo-relative path.
   * @returns The absolute path to write.
   * @throws When the path is not confined to the repo.
   */
  private resolveConfined(relPath: string): string {
    const normalized = normalizeRepoRelative(relPath);
    if (normalized === null) throw new Error(`refusing path outside the repo: ${relPath}`);
    if (normalized.split('/').some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
      throw new Error(`refusing path through a protected directory: ${relPath}`);
    }
    const abs = path.resolve(this.repoRoot, normalized);
    if (abs !== this.repoRoot && !abs.startsWith(this.repoRoot + path.sep)) {
      throw new Error(`refusing path outside the repo: ${relPath}`);
    }
    if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) {
      throw new Error(`refusing to write through a symlink: ${relPath}`);
    }
    this.assertAncestorConfined(abs, relPath);
    return abs;
  }

  /**
   * @description Resolves the deepest EXISTING ancestor of a target path through realpath and
   * verifies it is still inside the repo, so a symlink or Windows junction anywhere along the
   * directory chain cannot carry a lexically-confined write out of the tree.
   * @param abs - The absolute target path.
   * @param relPath - The original caller-supplied path, for the error message.
   * @throws When the resolved ancestor escapes the repo root.
   */
  private assertAncestorConfined(abs: string, relPath: string): void {
    let ancestor = path.dirname(abs);
    while (!existsSync(ancestor) && path.dirname(ancestor) !== ancestor) {
      ancestor = path.dirname(ancestor);
    }
    // realpath BOTH sides: the repo root itself can legitimately sit behind a symlink
    // (/var -> /private/var on macOS, a mapped drive on Windows).
    const realRoot = realpathSync(this.repoRoot);
    const realAncestor = realpathSync(ancestor);
    if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) {
      throw new Error(`refusing to write through a link that leaves the repo: ${relPath}`);
    }
  }

  /** Runs the restart action the class requires, reporting exactly what it did. */
  private async performRestart(cls: ChangeClass, written: readonly string[]): Promise<RestartOutcome> {
    const action = restartActionFor(cls);
    switch (action) {
      case 'none':
        return { action, targets: [], executed: true, detail: 'served from the live bind mount; a browser refresh is enough' };
      case 'app-reload':
        return this.reloadManifests(action, written);
      case 'bot-restart':
        return this.restartContainers(action, written.map((p) => this.containerForPersona(p)));
      case 'api-restart':
        return this.restartContainers(action, [`${this.containerPrefix}-api`]);
      default:
        // Unreachable for live-appliable classes; keeps the switch total if the union grows.
        return { action, targets: [], executed: false, detail: `no automatic action for ${action}` };
    }
  }

  /** Hot-loads each written manifest through the api's app loader. */
  private async reloadManifests(action: RestartAction, written: readonly string[]): Promise<RestartOutcome> {
    const results = await Promise.all(written.map((manifestPath) => this.reloader(manifestPath)));
    const failed = results.filter((r) => !r.ok);
    return {
      action,
      targets: [...written],
      executed: failed.length === 0,
      detail: failed.length ? `reload failed: ${failed.map((f) => f.detail).join('; ')}` : 'manifests reloaded',
    };
  }

  /** Restarts each named container, reporting any that could not be restarted. */
  private async restartContainers(action: RestartAction, names: readonly string[]): Promise<RestartOutcome> {
    const unique = [...new Set(names)];
    const results = await Promise.all(unique.map((name) => this.restarter(name)));
    const failed = results.filter((r) => !r.ok);
    return {
      action,
      targets: unique,
      executed: failed.length === 0,
      detail: failed.length ? `restart failed: ${failed.map((f) => f.detail).join('; ')}` : `restarted ${unique.join(', ')}`,
    };
  }

  /** `ai-lab/bot-personas/foo.yaml` -> the compose container that loads it at start. */
  private containerForPersona(relPath: string): string {
    return `${this.containerPrefix}-${path.posix.basename(relPath).replace(/\.ya?ml$/i, '')}`;
  }

  /** Restarts a container by name, refusing when no container of that name exists. */
  private defaultRestarter(containerName: string): Promise<{ ok: boolean; detail: string }> {
    return runCommand('docker', ['restart', containerName])
      .then(({ code, output }) => code === 0
        ? { ok: true, detail: `${containerName} restarted` }
        : { ok: false, detail: `${containerName}: ${output.trim().slice(-200) || `exit ${code}`}` });
  }

  /** Posts a manifest path to the api's loader using the trusted-service header. */
  private async defaultReloader(manifestPath: string): Promise<{ ok: boolean; detail: string }> {
    if (!this.serviceSecret) return { ok: false, detail: 'SWARM_SERVICE_SECRET is not set - cannot reload manifests' };
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/swarm/apps/load`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-service-secret': this.serviceSecret },
        body: JSON.stringify({ path: manifestPath }),
      });
      if (!res.ok) return { ok: false, detail: `${manifestPath}: HTTP ${res.status}` };
      return { ok: true, detail: `${manifestPath} reloaded` };
    } catch (error) {
      return { ok: false, detail: `${manifestPath}: ${error instanceof Error ? error.message : 'reload failed'}` };
    }
  }
}

/** Runs a command with a least-privilege env, resolving with its exit code and bounded output. */
function runCommand(command: string, args: readonly string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { env: buildDevSessionProcessEnv(), windowsHide: true });
    let output = '';
    const append = (chunk: Buffer): void => { output = (output + chunk.toString('utf8')).slice(-4096); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err) => resolve({ code: null, output: err.message }));
    child.on('close', (code) => resolve({ code, output }));
  });
}
