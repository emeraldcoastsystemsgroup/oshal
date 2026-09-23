/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com   | Add the single process-wide refusal recording chokepoint. Enforcement paths report structured denials here without importing PostgreSQL or weakening the original fail-closed result when persistence is unavailable.
 * 2   | maintainer@emeraldcoastsystemsgroup.com   | Enrich declared operator-remediable codes from the canonical remedy catalog before persistence while preserving a more specific remedy supplied by the enforcing path.
 */

import { createChildLogger } from '@/shared/logger';
import { remedyForRefusal } from './remedies';

export * from './remedies';

const logger = createChildLogger({ module: 'refusal-events' });

/** The stable target classes understood by the refusal ledger and cockpit. */
export type RefusalTargetKind = 'agent' | 'job' | 'route' | 'ticket' | 'tool' | 'other';

/** One structured refusal before the persistence adapter assigns its durable id and timestamp. */
export interface RefusalEventInput {
  code: string;
  actorSub: string;
  actorIssuer?: string;
  owningPackage: string;
  targetKind: RefusalTargetKind;
  target: string;
  preparedExecutionId?: string;
  remedy?: string;
  metadata?: Record<string, unknown>;
  occurredAt?: string;
}

/** Persistence port installed once by the composition root. */
export interface RefusalRecorder {
  record(input: RefusalEventInput): Promise<void>;
}

let recorder: RefusalRecorder | undefined;

/** @description Install or clear the process refusal recorder. */
export function configureRefusalRecorder(value: RefusalRecorder | undefined): void {
  recorder = value;
}

/**
 * @description Record one already-decided refusal through the platform chokepoint.
 * Persistence is observational: it may never replace the original denial with a different error.
 * @returns True only after the durable adapter commits the row.
 */
export async function recordRefusal(input: RefusalEventInput): Promise<boolean> {
  const current = recorder;
  if (!current) {
    logger.warn({ code: input.code, target: input.target }, 'Refusal recorder unavailable; denial remains enforced');
    return false;
  }
  try {
    const remedy = input.remedy ?? remedyForRefusal(input.code);
    await current.record(remedy ? { ...input, remedy } : input);
    return true;
  } catch (error) {
    logger.error({ err: error, code: input.code, target: input.target },
      'Refusal could not be persisted; denial remains enforced');
    return false;
  }
}
