/**
 * Run-trace services barrel.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial services barrel for the run-trace read-model slice (TraceService + the self-contained HTML renderer).
 *
 * @module features/run-trace/services
 */
export {
  TraceService,
  buildPhaseSpans,
  mapBotSpan,
  mapLlmSpan,
  computeTotals,
  type RunTrace,
  type TraceSpan,
  type TraceSpanKind,
  type TraceTicket,
  type TraceTotals,
} from './trace-service';
export { renderTraceHtml } from './trace-html';
