/**
 * Run-trace feature barrel — a READ-MODEL that assembles one ticket's execution timeline from
 * data already persisted (tickets, ticket_status_history, ticket_task_links, chat_tasks,
 * oshal_cost_events, agents). It adds no writes and no cross-boundary correlation instrumentation:
 * it exists so the debugging waterfall (ticket -> phases -> bot executions -> per-LLM-call cost)
 * stops being reconstructed from docker logs by hand. Trace totals reuse the budget ticket-spend
 * join so they agree with the cost-governance + cockpit ticket-cost rollups.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel for the run-trace slice.
 *
 * @module features/run-trace
 */
export {
  TraceService,
  buildPhaseSpans,
  mapBotSpan,
  mapLlmSpan,
  computeTotals,
  renderTraceHtml,
  type RunTrace,
  type TraceSpan,
  type TraceSpanKind,
  type TraceTicket,
  type TraceTotals,
} from './services';
