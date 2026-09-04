/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the print service that comes up WITH the node (ADR-135 amendment H). Operator: "add it to the remote node, and when the remote node is up it is running the print service, and that service is then accessible on the intranet the remote node is running on." The standalone -AtStartup task was a separate install with a separate hand-placed token; this makes the printer part of the node's own lifecycle, advertised on the node's LOCAL segment (which is why an overlay's lack of a broadcast domain stops mattering) and delivering on the node's OWN control-plane path with the node's OWN credential.
 *
 * @module main/print-service
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { OshalChatConfig } from './config';
import { buildLocalNodeProcessEnv } from './process-environment';

/** A line of progress from the print service, surfaced in the node UI like worker events. */
export type PrintServiceLog = (message: string) => void;

/** Restart budget: a printer that cannot bind its port must not spin forever. */
const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 5_000;

/**
 * @description Locates the print-drop entry script. Ordered most-explicit first so a
 * packaged build, a monorepo checkout and an operator override all resolve without
 * branching on how the node was installed.
 * @param packageRoot - The chat package's root directory.
 * @returns Absolute path to bin/print-drop.js, or null when the package is absent.
 */
export function resolvePrintDropEntry(packageRoot: string): string | null {
  const explicit = String(process.env.OSHAL_PRINT_DROP_ENTRY || '').trim();
  const candidates = [
    ...(explicit ? [explicit] : []),
    join(packageRoot, 'node_modules', '@oshal', 'print-drop', 'bin', 'print-drop.js'),
    join(packageRoot, '..', 'oshal-print-drop', 'bin', 'print-drop.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * @description Builds the control-plane URL the print service delivers to.
 *
 * This is the node's OWN plane, not `/api/print-ingest/documents`, and that is deliberate:
 * a node-bound token is scoped to `/api/remote-clients/<its own clientId>/*`, so the global
 * intake would refuse it as `off-plane`. Filing on its own plane is also what lets the swarm
 * translate device -> owner before the document is stored, so a node can never file into
 * somebody else's knowledge.
 *
 * @param config - The node's persisted settings.
 * @returns Absolute intake URL for this node.
 */
export function nodePrintIntakeUrl(config: OshalChatConfig): string {
  const base = String(config.controlPlaneUrl || '').replace(/\/+$/, '');
  return `${base}/api/remote-clients/${encodeURIComponent(config.clientId)}/print-documents`;
}

/**
 * Supervises the print-drop process for the lifetime of the node's connection.
 *
 * The printer is advertised on the node's own network segment, so the machines that print
 * to it are the ones that share that segment — no overlay multicast required, no client
 * software, and no credential on the printing machine. This process holds the node's token;
 * a person on the intranet just picks a printer.
 */
export class PrintService {
  private child: ChildProcess | null = null;
  private restarts = 0;
  private stopping = false;

  constructor(
    private readonly config: OshalChatConfig,
    private readonly packageRoot: string,
    private readonly log: PrintServiceLog = () => {},
  ) {}

  /** @description True when this node is configured to advertise a print-to-rag printer. */
  static enabled(config: OshalChatConfig): boolean {
    return config.printServiceEnabled === true;
  }

  /**
   * @description Starts the printer. Refuses — loudly, without spawning — the two
   * configurations that would advertise a printer that cannot deliver, because a printer
   * that accepts a job and drops it is worse than one that never appeared.
   * @returns True when the service was started.
   */
  start(): boolean {
    if (this.child) return true;
    if (!this.config.clientId) {
      this.log('Print service not started: this node has no clientId yet.');
      return false;
    }
    if (!this.config.sharedSecret) {
      this.log('Print service not started: the node has no credential, so printed documents could not be delivered.');
      return false;
    }
    const entry = resolvePrintDropEntry(this.packageRoot);
    if (!entry) {
      this.log('Print service not started: the @oshal/print-drop package is not installed alongside this node.');
      return false;
    }

    const spoolDir = this.config.printServiceSpoolDir || join(this.packageRoot, 'print-spool');
    if (!existsSync(spoolDir)) mkdirSync(spoolDir, { recursive: true });

    const args = [
      entry,
      '--target', 'swarm',
      '--intake-url', nodePrintIntakeUrl(this.config),
      '--dir', spoolDir,
    ];

    // The node's own credential travels in the environment, never on the command line —
    // an argv is world-readable in the process table.
    const env = {
      ...buildLocalNodeProcessEnv(),
      OSHAL_PRINT_INTAKE_TOKEN: this.config.sharedSecret,
    };

    this.child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stdout?.on('data', (chunk: Buffer) => this.log(chunk.toString().trimEnd()));
    this.child.stderr?.on('data', (chunk: Buffer) => this.log(chunk.toString().trimEnd()));
    this.child.on('error', (err: Error) => {
      this.log(`Print service failed to launch: ${err.message}`);
      this.child = null;
    });
    this.child.on('close', (code: number | null) => {
      this.child = null;
      if (this.stopping) return;
      if (this.restarts >= MAX_RESTARTS) {
        this.log(`Print service exited (${code}) and has restarted ${MAX_RESTARTS} times — giving up. Check whether another print-drop instance holds the port.`);
        return;
      }
      this.restarts += 1;
      this.log(`Print service exited (${code}) — restarting (${this.restarts}/${MAX_RESTARTS})`);
      setTimeout(() => { if (!this.stopping) this.start(); }, RESTART_DELAY_MS);
    });

    this.log(`Print service starting — this computer now offers a print-to-rag printer on its network. Spool: ${spoolDir}`);
    return true;
  }

  /** @description Stops the printer so it disappears with the node rather than outliving it. */
  stop(): void {
    this.stopping = true;
    if (this.child) {
      this.child.kill();
      this.child = null;
      this.log('Print service stopped.');
    }
  }
}
