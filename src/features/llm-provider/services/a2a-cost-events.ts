/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the A2A cost-event types (A2ARemoteUsage, A2ACostEvent, A2ARecordCostFn) out of a2a-harness-adapter.ts into this pure-types module so controller consumers (a2a-cost-stamper via the feature barrel) can type against cost events WITHOUT the barrel dragging the harness runtime onto the controller graph (two-runtimes doctrine; TODO-BOUNDARY-FINDING 2026-07-19). The adapter imports and re-exports these types, so its deep importers are unchanged.
 */

/**
 * @description Token usage as reported by the remote A2A agent, or null when the
 * remote reported nothing. Null is deliberately distinct from zero: an absent
 * report means the remote cost is UNKNOWN, and OSHAL must never invent numbers.
 */
export interface A2ARemoteUsage {
  /** Prompt-side tokens the remote reported. */
  inputTokens: number;
  /** Completion-side tokens the remote reported. */
  outputTokens: number;
  /** Remote-reported total dollar cost, when the agent bills in currency. */
  totalCostUsd: number | null;
}

/**
 * @description Cost event the adapter emits after every outbound run so the
 * composition root can land attribution in chat_tasks under the bot's agent_id.
 * `costUnknown` is the honest marker for "the remote reported no usage" — the
 * numbers in that case are zero BY DECLARATION, not by measurement.
 */
export interface A2ACostEvent {
  taskId: string;
  agentId: string;
  providerId: 'a2a';
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  currency: string;
  /** 0 when this event is a zero-cost marker (mirrors record-cost.ts doctrine). */
  requestCount: number;
  /** True when the remote reported NO usage metadata — cost is unknown, not zero. */
  costUnknown: boolean;
  /** Hostname of the remote endpoint (never the full URL — it may carry secrets). */
  remoteEndpointHost: string;
}

/**
 * @description Callback the composition root injects to persist an A2ACostEvent.
 * Kept as a local structural type so this features-layer module never
 * imports a sibling slice's recorder directly.
 * @param event - The outbound run's cost/attribution event.
 * @returns Resolves when the event is persisted (failures are non-fatal here).
 */
export type A2ARecordCostFn = (event: A2ACostEvent) => Promise<void>;
