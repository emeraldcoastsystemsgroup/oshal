import type { TicketStatusMetadata } from './ticket-store';
import type { OshalTicketState } from './types';

/**
 * @description Builds the small ticket-row metadata patch that keeps operator boards
 * useful without overwriting queue/app provenance such as metadata.source = "jarvis".
 */
export function buildTicketRowStatusMetadataPatch(
  status: OshalTicketState,
  metadata: TicketStatusMetadata,
): Record<string, unknown> | null {
  const source = readText(metadata, 'source');
  const reason = readText(metadata, 'reason') ?? readText(metadata, 'message');
  const severity = readText(metadata, 'severity');
  const nextAction = readText(metadata, 'nextAction');
  const failureClass = readText(metadata, 'failureClass');
  const transition = { status, ...metadata };
  const patch: Record<string, unknown> = {
    lastStatusTransition: transition,
  };

  if (reason) patch.reason = reason;
  if (source) patch.statusSource = source;
  if (severity) patch.severity = severity;
  if (nextAction) patch.nextAction = nextAction;
  if (failureClass) patch.failureClass = failureClass;

  return Object.keys(metadata).length > 0 ? patch : null;
}

function readText(metadata: TicketStatusMetadata, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
