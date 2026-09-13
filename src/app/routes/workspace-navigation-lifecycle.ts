/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Stop subsequent workspace discovery reads after its response is abandoned, without cancelling shared work or treating a received request as disconnected.
 */
import type { Request, Response } from 'express';

/** @description Track one response lifetime; an already-started port settles normally before cancellation is observed. */
export class WorkspaceNavigationLifecycle {
  private abandoned = false;
  readCount = 0;
  private readonly abort = () => { this.abandoned = true; };
  private readonly close = () => { if (!this.res.writableFinished) this.abort(); };

  constructor(private readonly req: Request, private readonly res: Response) {
    req.once('aborted', this.abort);
    res.once('close', this.close);
  }

  /** @description Request completion/close alone is normal for GET; only an aborted request or unfinished destroyed response cancels work. */
  get cancelled(): boolean {
    return this.abandoned || this.req.aborted || (this.res.destroyed && !this.res.writableFinished);
  }

  /** @description Fence the next read or response write without claiming cancellation of an in-flight SQL query. */
  check(): void {
    if (this.cancelled) throw new Error('workspace_discovery_cancelled');
  }

  /** @description Keep fresh serial reads, but never start another port after abandonment. @param read One existing awaited port. @returns Its value while connected. */
  async read<T>(read: () => Promise<T>): Promise<T> {
    this.check(); this.readCount++;
    try { return await read(); }
    finally { this.check(); }
  }

  /** @description Release both listeners on success, denial, error or cancellation. */
  dispose(): void {
    this.req.off('aborted', this.abort);
    this.res.off('close', this.close);
  }
}
