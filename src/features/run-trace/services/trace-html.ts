/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Server-side renderer for GET /api/trace/:ticketId.html — a self-contained (no external assets), theme-aware waterfall: a totals header + one horizontal bar per span positioned/sized by its real time offset + duration, cost/model/agent per row. Pure string builder over an assembled RunTrace so it is unit-testable and shares the exact numbers the JSON endpoint returns. All dynamic text is HTML-escaped: ticket/agent/model ids are user-influenced, so they are never interpolated raw into the page.
 */

import type { RunTrace, TraceSpan } from './trace-service';

/** Bar colour per kind — a fixed 3-hue scale so a phase/bot/llm-call reads at a glance. */
const KIND_COLOR: Record<TraceSpan['kind'], string> = {
  phase: '#6366f1',
  bot: '#0ea5e9',
  'llm-call': '#22c55e',
};

/**
 * @description Renders a complete HTML document for a trace. Self-contained (inline CSS, no external
 * requests) so it renders inside the cockpit or standalone.
 * @param trace - The assembled run trace.
 * @returns A full `<!doctype html>` string.
 */
export function renderTraceHtml(trace: RunTrace): string {
  const { minMs, spanMs } = timeWindow(trace);
  const rows = trace.spans.map((s) => renderRow(s, minMs, spanMs)).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Run trace ${esc(trace.ticket.id)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="wrap">
  <h1>Run trace</h1>
  <p class="sub">${esc(trace.ticket.type)} &middot; ${esc(trace.ticket.status)} &middot; <code>${esc(trace.ticket.id)}</code></p>
  <section class="totals">
    <div class="tot"><span class="k">Total cost</span><span class="v">$${trace.totals.costUsd.toFixed(6)}</span></div>
    <div class="tot"><span class="k">Tokens</span><span class="v">${trace.totals.tokens.toLocaleString()}</span></div>
    <div class="tot"><span class="k">LLM calls</span><span class="v">${trace.totals.llmCalls}</span></div>
    <div class="tot"><span class="k">Wall time</span><span class="v">${fmtMs(trace.totals.wallMs)}</span></div>
  </section>
  <section class="chart">
${rows || '<p class="empty">No spans recorded for this ticket yet.</p>'}
  </section>
  <p class="foot">Read-model over already-persisted rows (tickets, ticket_status_history, chat_tasks, oshal_cost_events). No data is written.</p>
</main>
</body>
</html>`;
}

/** @description The [min, max] instant window across all span boundaries, in ms + total span. */
function timeWindow(trace: RunTrace): { minMs: number; spanMs: number } {
  const times: number[] = [];
  for (const s of trace.spans) {
    times.push(Date.parse(s.startedAt));
    if (s.endedAt) times.push(Date.parse(s.endedAt));
  }
  const finite = times.filter((n) => Number.isFinite(n));
  if (finite.length === 0) return { minMs: 0, spanMs: 1 };
  const minMs = Math.min(...finite);
  const maxMs = Math.max(...finite);
  return { minMs, spanMs: Math.max(1, maxMs - minMs) };
}

/** @description Renders one waterfall row: a label column + a positioned bar in the timeline lane. */
function renderRow(s: TraceSpan, minMs: number, totalMs: number): string {
  const start = Date.parse(s.startedAt);
  const end = s.endedAt ? Date.parse(s.endedAt) : start;
  const leftPct = clampPct(((start - minMs) / totalMs) * 100);
  const widthPct = Math.max(0.6, clampPct(((end - start) / totalMs) * 100));
  const color = KIND_COLOR[s.kind];
  const meta = [
    s.durationMs !== null ? fmtMs(s.durationMs) : null,
    s.costUsd !== undefined && s.costUsd > 0 ? `$${s.costUsd.toFixed(6)}` : null,
    s.tokens !== undefined && s.tokens > 0 ? `${s.tokens.toLocaleString()} tok` : null,
    s.model ? esc(s.model) : null,
  ].filter(Boolean).join(' &middot; ');
  return `    <div class="row ${s.kind}">
      <div class="lab" title="${esc(s.label)}"><span class="dot" style="background:${color}"></span>${esc(s.label)}</div>
      <div class="lane">
        <div class="bar" style="left:${leftPct.toFixed(3)}%;width:${widthPct.toFixed(3)}%;background:${color}"></div>
      </div>
      <div class="mt">${meta || '&nbsp;'}</div>
    </div>`;
}

/** @description Clamps a percentage into [0, 100]. */
function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

/** @description Human-formats a millisecond duration (ms / s / m). */
function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/** @description Escapes text for safe HTML interpolation (ids/labels are user-influenced). */
function esc(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root{--bg:#fff;--fg:#111827;--mut:#6b7280;--line:#e5e7eb;--card:#f9fafb}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f19;--fg:#e5e7eb;--mut:#9ca3af;--line:#1f2937;--card:#111827}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:24px}
h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--mut);margin:0 0 20px}
.sub code{font-size:12px}
.totals{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:24px}
.tot{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:130px}
.tot .k{display:block;color:var(--mut);font-size:12px}
.tot .v{display:block;font-size:18px;font-weight:600}
.chart{border:1px solid var(--line);border-radius:8px;overflow:hidden}
.row{display:grid;grid-template-columns:220px 1fr 180px;align-items:center;gap:12px;padding:6px 14px;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:0}
.row.phase{background:var(--card)}
.lab{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.lane{position:relative;height:18px;background:transparent}
.bar{position:absolute;top:2px;height:14px;border-radius:3px;min-width:2px;opacity:.85}
.mt{color:var(--mut);font-size:12px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.empty{padding:24px;color:var(--mut);text-align:center}
.foot{color:var(--mut);font-size:12px;margin-top:16px}
@media (max-width:640px){.row{grid-template-columns:140px 1fr;}.mt{display:none}}
`;
