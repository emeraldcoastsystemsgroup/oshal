/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Shared reply-hygiene helper for consumer concierge surfaces (strip raw JSON envelopes/debug text before display).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add mandatory CHANGE LOG header (was missing on the original commit).
 */

/**
 * Shared reply hygiene for consumer concierge surfaces.
 *
 * The concierge bots are prompted to return JSON envelopes. If a provider stalls,
 * truncates, or ignores the format, the UI must not show raw envelope/debug text.
 */

const ENVELOPE_KEY = /"?\b(say|show|add|remember|checkout|pickup|dropoff|rideType|showOptions|book)\b"?\s*:/i;

export function cleanConciergeReply(value: unknown, fallback = ''): string {
  const text = String(value ?? '').trim();
  if (!text) return fallback;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  if (looksLikeEnvelope(candidate)) {
    const parsed = parseLikelyJson(candidate);
    if (parsed && typeof parsed.say === 'string' && parsed.say.trim()) {
      return cleanConciergeReply(parsed.say, fallback);
    }
    return fallback;
  }

  return text;
}

function looksLikeEnvelope(text: string): boolean {
  if (!text) return false;
  if (text.startsWith('{') && ENVELOPE_KEY.test(text)) return true;
  if (text.startsWith('{') && text.endsWith('}')) return true;
  return false;
}

function parseLikelyJson(text: string): any | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
