/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bind queued application evidence and validated results without replacing signed bot transport or accounting.
 */
import type { InternalTicket } from '@/entities/ticket';
import type { WorkflowDefinition } from './dispatch-routing';

/** @description Package compatibility floor for queued evidence validation and result fencing. */
export const BOUND_WORKFLOW_RESULTS_VERSION = 1;

/** @description A controller-owned evidence/result contract for one admitted worker invocation. */
export interface ManifestWorkerBinding {
  prompt: string;
  /** No tool loop, fallback transport or caller-selected provider for bounded reasoning. */
  reasonOnly: true;
  alreadyComplete?: boolean;
  complete(response: string): Promise<void>;
  fail(error: unknown): Promise<void>;
}

/** @description Composition resolves domain contracts; an unbound ticket retains the ordinary workflow path. */
export type BindManifestWorker = (ticket: InternalTicket, workflow: WorkflowDefinition, agentId: string) => Promise<ManifestWorkerBinding | undefined>;
