/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Project the caller's native ledger and distinguish unprobed bot health from offline.
 */

/** Select the explicit native caller metrics contract without guessing deployment mode. */
export function isNativeOperations(metrics) {
  return metrics?.source === 'native-tickets-and-ledger' && metrics?.data?.scope === 'caller';
}

/** Routing admission is separate from observed liveness. */
export function agentHealth(bot) {
  if (bot.dbStatus === 'inactive') return 'disabled';
  if (bot.online === true) return 'online';
  if (bot.online === false) return 'offline';
  return 'unknown';
}

/** Preserve every integer micro-dollar, including a measured zero. */
export function formatNativeCost(micros) {
  if (!Number.isSafeInteger(micros)) return 'Unavailable';
  const amount = Math.abs(micros);
  return `${micros < 0 ? '-' : ''}$${Math.floor(amount / 1_000_000)}.${String(amount % 1_000_000).padStart(6, '0')}`;
}

function dimension(raw) {
  if (!raw || !Number.isSafeInteger(raw.total_micros)) return null;
  const fields = ['tokens_in', 'tokens_out', 'total_tokens', 'call_count', 'estimated_count'];
  if (fields.some((key) => !Number.isSafeInteger(raw[key]) || raw[key] < 0)) return null;
  return {
    micros: raw.total_micros, tokensIn: raw.tokens_in, tokensOut: raw.tokens_out,
    tokens: raw.total_tokens, calls: raw.call_count, estimatedCalls: raw.estimated_count,
  };
}

function dimensions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rows = Object.entries(raw).map(([id, value]) => ({ id, usage: dimension(value) }));
  if (rows.some((row) => !row.usage)) return null;
  return rows.map(({ id, usage }) => ({ id, ...usage }))
    .sort((a, b) => b.micros - a.micros || b.calls - a.calls || a.id.localeCompare(b.id));
}

function eventMetadata(events, field, id) {
  const matching = events.filter((event) => event[field] === id);
  const latest = matching.reduce((found, event) => (
    Number.isSafeInteger(event.at) && (!found || event.at > found.at) ? event : found
  ), null);
  const values = (key) => [...new Set(matching.map((event) => event[key]).filter((value) => typeof value === 'string' && value))];
  return {
    lastActivityAt: latest?.at ?? null, latestModel: latest?.model ?? null,
    providers: values('api'), harnesses: values('harness'),
  };
}

function costKinds(events, calls) {
  if (events.length !== calls) return null;
  const totals = { metered: 0, reported: 0 };
  for (const event of events) {
    if (!['metered', 'reported'].includes(event.kind) || !Number.isSafeInteger(event.amount)) return null;
    const amount = totals[event.kind] + event.amount;
    if (!Number.isSafeInteger(amount)) return null;
    totals[event.kind] = amount;
  }
  return totals;
}

/** Read only the native own-ledger contract; failed/malformed reads stay unavailable. */
export function projectNativeLedger(report) {
  const summary = dimension(report?.summary);
  const byBot = dimensions(report?.by_bot);
  const byModel = dimensions(report?.by_model);
  if (!summary || !byBot || !byModel || !Array.isArray(report.events)) return null;
  const events = report.events.filter((event) => event && typeof event === 'object');
  return {
    summary, kinds: costKinds(events, summary.calls),
    byBot: byBot.map((row) => ({ ...row, ...eventMetadata(events, 'bot', row.id) })),
    byModel: byModel.map((row) => ({ ...row, ...eventMetadata(events, 'model', row.id) })),
    recent: events.filter((event) => Number.isSafeInteger(event.at) && Math.abs(event.at) <= 8_640_000_000_000_000 && Number.isSafeInteger(event.amount))
      .sort((a, b) => b.at - a.at).slice(0, 10)
      .map((event) => ({ at: event.at, micros: event.amount, kind: event.kind, model: event.model })),
  };
}

/** Match usage by the declared or resolved bot identity; never infer health from usage. */
export function mergeNativeBots(bots, ledger) {
  const usageByBot = new Map((ledger?.byBot || []).map((row) => [row.id, row]));
  return bots.map((bot) => {
    const usage = usageByBot.get(bot.agentId) || usageByBot.get(bot.declaredAgentId) || usageByBot.get(bot.name);
    return {
      ...bot, nativeUsage: usage ?? null,
      latestModel: usage?.latestModel ?? null, lastActivityAt: usage?.lastActivityAt ?? null,
      harnessType: usage?.harnesses.join(', ') || null, apiType: usage?.providers.join(', ') || null,
      totalRequests: usage?.calls ?? null, totalInputTokens: usage?.tokensIn ?? null,
      totalOutputTokens: usage?.tokensOut ?? null,
    };
  });
}
