/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L5 (D5, D7): the Jarvis "next time I'm at X" intent, a deterministic matcher on the /ask path in the same family as the time-reminder intent (never a model turn, so a location sentence yields a predictable rule). "Remind me to buy milk next time I'm at the grocery store" resolves "the grocery store" to the person's saved places with that name or label (their own and their groups'), and arms a once-only reminder at each (up to five); with none, Jarvis offers to save the place the next time they are there (no category places in v1). "I'm at the grocery store, remind me next time to buy milk", "... next time I'm here" or "... at this store" uses the current fix: when the person's latest fix, fresh within OSHAL_LOCATION_HERE_MAX_AGE_SEC (default 300 s), already falls in a matching saved place the rule is armed there; otherwise Jarvis proposes a new place at that fix and asks them to confirm its name, label and radius ("yes", "call it ...", "make it 200 m", "cancel"). The proposal is held in memory for ten minutes per person and conversation, is cleared by the location state eraser, and a confirmed place is created with the reminder armed and the person seeded inside it, so it fires on the NEXT visit, not now. A fix stored at city or place-only precision cannot pin a place and is declined. Only a signed-in browser session with a verified issuer may use it (the same rule as every /api/location route); the service-secret rail and token sessions are told to use their browser. No coordinate, place geometry or reminder text is logged.
 *
 * @module app/location-jarvis-intent
 */

import type { Request } from 'express';
import { createChildLogger, locationSafeError } from '@/shared/logger';
import { getCaller } from '@/shared/middleware/authz';
import { getAuthenticatedPrincipalIssuer } from '@/shared/middleware/principal-issuer';
import { registerLocationStateEraser, withLocationOwnerSession, type LocationDb, type LocationPrincipal } from '@/features/location';
import { LOCATION_PLACE_DEFAULT_RADIUS_M, LOCATION_PLACE_RADIUS_M, createLocationPlace, parsePlaceInput } from './location-places';
import { LocationRequestError } from './location-request';
import { createLocationRule, parseRuleInput } from './location-rules';
import { locationSessionRail, presentsServiceRail } from './routes/location-session';

const log = createChildLogger({ module: 'location-jarvis-intent' });

/** @description How long a "save it here?" proposal waits for an answer. */
export const LOCATION_PROPOSAL_TTL_MS = 10 * 60_000;

/** @description Radius proposed for a place saved "here": about the stored fix's rounding plus room to enter. */
export const LOCATION_HERE_RADIUS_M = Object.freeze({ exact: LOCATION_PLACE_DEFAULT_RADIUS_M.person, block: 150 });

/** @description The most saved places one sentence arms a reminder at. */
const MAX_MATCHED_PLACES = 5;
const MAX_PENDING = 500;

/** @description What the parser read from a location reminder sentence. */
export interface LocationReminderParse {
  action: string;
  phrase: string;
  here: boolean;
  on: 'enter' | 'exit';
}

/** @description A reply to a pending "save it here?" proposal. */
export interface LocationProposalReply {
  reply: 'confirm' | 'cancel' | 'edit';
  name?: string;
  radiusM?: number;
}

/** @description One detected location turn. */
export type JarvisLocationTurn =
  | { kind: 'refused' }
  | ({ kind: 'reminder'; principal: LocationPrincipal; key: string } & LocationReminderParse)
  | ({ kind: 'reply'; principal: LocationPrincipal; key: string } & LocationProposalReply);

/** A proposal waiting for the person's answer. Held in memory only. */
interface PlaceProposal {
  principal: LocationPrincipal;
  center: { lat: number; lon: number };
  name: string;
  label: string;
  radiusM: number;
  action: string;
  on: 'enter' | 'exit';
  expiresAtMs: number;
}

const proposals = new Map<string, PlaceProposal>();

registerLocationStateEraser('jarvis-location-proposals', (principal) => {
  for (const [key, proposal] of proposals) {
    if (proposal.principal.sub === principal.sub && proposal.principal.principalIssuer === principal.principalIssuer) proposals.delete(key);
  }
});

const CUE = /\bremind me\b|\bset (?:a |up a )?reminder\b/i;
const HERE_PHRASE = /^(?:here|back here|this (?:store|shop|place|spot))$/i;
const IM_AT = /^\s*i(?:'m|\s+am|m)\s+(?:at|in)\s+(.+?)\s*[,;.!]\s*(?:please\s+)?(?:remind me|set (?:a )?reminder)\s+(?:the\s+)?next\s+time(?:\s+i(?:'m|\s+am|m)?\s+(?:here|back|back here))?\s*(?:to|that|about)?\s+(.+)$/i;
const TRIGGER = /\b(?:the\s+)?(?:next\s+time|when(?:ever)?)\s+i(?:'m|\s+am|m)?\s+(?:(?:next|back)\s+)?(?:(at|in|get\s+to|arrive\s+at|reach|leave)\s+(.+?)|(here|back\s+here)|(?:get|arrive)\s+(home))(?=\s*(?:[,;.!?]|$|\s+(?:to|and|please)\s+|\s+remind\b))/i;

/**
 * @description Normalise quotes and spacing.
 * @param message - The raw message.
 * @returns The text.
 */
function normalise(message: string): string {
  return String(message || '').replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}

/**
 * @description Strip reminder scaffolding from what is left once the place clause is removed.
 * @param text - The residue.
 * @returns The thing to be reminded of.
 */
function actionFrom(text: string): string {
  return text
    .replace(/^\s*please\s+/i, ' ')
    .replace(/\b(?:can you|could you|please)\s+/gi, ' ')
    .replace(/\bremind me\s*(?:the\s+)?(?:next\s+time\s*)?(?:to\s+|that\s+|about\s+)?/i, ' ')
    .replace(/\bset (?:a |up a )?reminder\s*(?:to|for)?\s*/i, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:.!-]+|[\s,;:.!?-]+$/g, '')
    .replace(/^to\s+/i, '')
    .trim();
}

/**
 * @description Parse a location reminder sentence (ADR-169 L5). Conservative: an explicit
 * "remind me"/"reminder" cue AND a place clause ("next time I'm at X", "when I get to X",
 * "when I leave X", "next time I'm here", or a leading "I'm at X, remind me next time ...").
 * @param message - The message.
 * @returns The parse, or null when the sentence is not a location reminder.
 */
export function parseLocationReminder(message: string): LocationReminderParse | null {
  const text = normalise(message);
  if (!text || text.length > 400 || !CUE.test(text)) return null;
  const imAt = IM_AT.exec(text);
  if (imAt) {
    return { action: actionFrom(imAt[2]), phrase: imAt[1].trim(), here: true, on: 'enter' };
  }
  const trigger = TRIGGER.exec(text);
  if (!trigger) return null;
  const phrase = (trigger[2] ?? trigger[4] ?? trigger[3] ?? '').replace(/[.!?]+$/, '').trim();
  const residue = `${text.slice(0, trigger.index)} ${text.slice(trigger.index + trigger[0].length)}`;
  return {
    action: actionFrom(residue),
    phrase,
    here: Boolean(trigger[3]) || HERE_PHRASE.test(phrase.replace(/^the\s+/i, '')),
    on: /^leave$/i.test(trigger[1] ?? '') ? 'exit' : 'enter',
  };
}

/**
 * @description A name and label for a place phrase: "the grocery store" is "Grocery store" (grocery);
 * "work" is "Work" (work); "this store" is "Store".
 * @param phrase - The phrase.
 * @returns Name and label.
 */
export function placeGuess(phrase: string): { name: string; label: 'home' | 'work' | 'grocery' | 'other' } {
  const bare = phrase.trim().replace(/^(?:the|my|our|a|an)\s+/i, '').replace(/[.!?,;]+$/, '').trim();
  const lower = bare.toLowerCase();
  const label = /\b(?:grocery|groceries|supermarket|market)\b/.test(lower) ? 'grocery'
    : /^(?:home|house)$/.test(lower) ? 'home' : /^(?:work|office)$/.test(lower) ? 'work' : 'other';
  const here = /^this (store|shop|place|spot)$/.exec(lower);
  const base = here ? here[1] : HERE_PHRASE.test(lower) || !bare ? 'Here' : bare;
  return { name: (base.charAt(0).toUpperCase() + base.slice(1)).slice(0, 120), label };
}

/**
 * @description Parse an answer to a pending proposal.
 * @param message - The message.
 * @returns The reply, or null when the message does not answer it.
 */
export function parseProposalReply(message: string): LocationProposalReply | null {
  const text = normalise(message);
  if (/^(?:no|nope|cancel|never ?mind|stop|don'?t)\b/i.test(text)) return { reply: 'cancel' };
  const named = /\b(?:call it|name it)\s+(?:"([^"]+)"|(.+?))\s*(?=$|[.!,;]|\s+and\s+(?:make|set|use)\b)/i.exec(text);
  const sized = /\b(\d{2,5})\s*(?:m|meters?|metres?)\b/i.exec(text);
  const out: LocationProposalReply = { reply: 'edit' };
  if (named) out.name = (named[1] ?? named[2]).trim().slice(0, 120);
  if (sized) out.radiusM = Number(sized[1]);
  if (/^(?:yes|yeah|yep|sure|ok(?:ay)?|do it|save it|confirm|please do)\b/i.test(text)) return { ...out, reply: 'confirm' };
  return named || sized ? out : null;
}

/**
 * @description The person a location turn acts for: an interactive browser session with a verified
 * issuer, never the service-secret rail or a token.
 * @param req - The /ask request.
 * @returns The principal, or null.
 */
function browserPrincipal(req: Request): LocationPrincipal | null {
  if (presentsServiceRail(req) || !locationSessionRail(req)) return null;
  const sub = getCaller(req).sub;
  const principalIssuer = getAuthenticatedPrincipalIssuer(req);
  return sub && principalIssuer ? { sub, principalIssuer } : null;
}

/**
 * @description The proposal key for a person's conversation.
 * @param principal - The person.
 * @param sessionId - The conversation.
 * @returns The key.
 */
function proposalKey(principal: LocationPrincipal, sessionId: string): string {
  return `${principal.principalIssuer}\n${principal.sub}\n${sessionId}`;
}

/**
 * @description A live proposal for a key, dropping it when expired.
 * @param key - The key.
 * @param nowMs - The clock.
 * @returns The proposal, or null.
 */
function liveProposal(key: string, nowMs: number): PlaceProposal | null {
  const found = proposals.get(key);
  if (!found) return null;
  if (found.expiresAtMs <= nowMs) { proposals.delete(key); return null; }
  return found;
}

/**
 * @description Detect a location turn on the /ask path. Synchronous and side-effect free: the work
 * happens in {@link runJarvisLocationTurn} inside the job.
 * @param message - The message.
 * @param req - The /ask request (for the browser-session principal).
 * @param sessionId - The conversation.
 * @param nowMs - The clock.
 * @returns The turn, or null when the message is not a location turn.
 */
export function detectJarvisLocationTurn(message: string, req: Request, sessionId: string, nowMs: number = Date.now()): JarvisLocationTurn | null {
  const reminder = parseLocationReminder(message);
  const principal = browserPrincipal(req);
  if (reminder) {
    return principal ? { kind: 'reminder', principal, key: proposalKey(principal, sessionId), ...reminder } : { kind: 'refused' };
  }
  if (!principal) return null;
  const key = proposalKey(principal, sessionId);
  if (!liveProposal(key, nowMs)) return null;
  const reply = parseProposalReply(message);
  return reply ? { kind: 'reply', principal, key, ...reply } : null;
}

/**
 * @description Arm a once-only reminder at each place.
 * @param db - The pool.
 * @param principal - The person.
 * @param placeIds - The places.
 * @param turn - The reminder.
 * @param seedInside - Whether the person is inside the place now.
 * @returns The rules' count.
 */
async function armReminders(db: LocationDb, principal: LocationPrincipal, placeIds: string[], turn: LocationReminderParse, seedInside: boolean): Promise<number> {
  for (const placeId of placeIds) {
    await createLocationRule(db, principal, parseRuleInput({ placeId, on: turn.on, repeat: 'once', action: { kind: 'remind', text: turn.action } }), { seedInside });
  }
  return placeIds.length;
}

/** The verb for a direction. */
const verbFor = (on: 'enter' | 'exit'): string => (on === 'enter' ? 'arrive at' : 'leave');

/**
 * @description "the grocery store": arm the reminder at the person's saved places of that name or label.
 * @param db - The pool.
 * @param turn - The reminder turn.
 * @returns The answer.
 */
async function reminderAtSavedPlaces(db: LocationDb, turn: Extract<JarvisLocationTurn, { kind: 'reminder' }>): Promise<string> {
  const guess = placeGuess(turn.phrase);
  const places = await withLocationOwnerSession(db, turn.principal, async (client) =>
    (await client.query('SELECT place_id, name, label FROM location_places ORDER BY name, place_id')).rows as Array<Record<string, unknown>>);
  const lower = guess.name.toLowerCase();
  const exact = places.filter((p) => String(p.name).toLowerCase() === lower);
  const byLabel = guess.label === 'other' ? [] : places.filter((p) => p.label === guess.label);
  const matched = (exact.length ? exact : byLabel.length ? byLabel : places.filter((p) => String(p.name).toLowerCase().includes(lower))).slice(0, MAX_MATCHED_PLACES);
  if (!matched.length) {
    return `You don't have a saved place called "${guess.name}" yet. When you're there, tell me "I'm at ${turn.phrase}, remind me next time to ${turn.action}" and I'll save it.`;
  }
  const count = await armReminders(db, turn.principal, matched.map((p) => String(p.place_id)), turn, false);
  log.info({ op: 'jarvis-reminder', outcome: 'armed', count }, 'location reminder armed from Jarvis');
  const names = matched.map((p) => String(p.name)).join(', ');
  return `Done. Next time you ${verbFor(turn.on)} ${names}, I'll remind you to ${turn.action}.`;
}

/**
 * @description The person's latest fix, if fresh, with the place it fell in.
 * @param db - The pool.
 * @param principal - The person.
 * @param nowMs - The clock.
 * @returns The fix or null.
 */
async function freshFix(db: LocationDb, principal: LocationPrincipal, nowMs: number): Promise<Record<string, unknown> | null> {
  const maxAge = Number(process.env.OSHAL_LOCATION_HERE_MAX_AGE_SEC);
  const maxAgeMs = (Number.isFinite(maxAge) && maxAge > 0 ? Math.min(maxAge, 3600) : 300) * 1000;
  const row = await withLocationOwnerSession(db, principal, async (client, who) => (await client.query(`SELECT c.lat, c.lon, c.precision_class,
      c.received_at, c.place_id, p.name AS place_name, p.label AS place_label
    FROM location_current c LEFT JOIN location_places p ON p.place_id = c.place_id
    WHERE c.tenant_id IS NULL AND c.owner_sub = $1 AND c.principal_issuer = $2 AND c.subject_ref = $1`, [who.sub, who.principalIssuer])).rows[0]);
  if (!row) return null;
  const received = row.received_at instanceof Date ? row.received_at.getTime() : new Date(String(row.received_at)).getTime();
  return nowMs - received <= maxAgeMs ? row : null;
}

/**
 * @description The words that propose saving a place.
 * @param p - The proposal.
 * @returns The question.
 */
function proposalText(p: PlaceProposal): string {
  return `I'll save where you are now as "${p.name}" (${p.label}, ${p.radiusM} m) and remind you to ${p.action} next time you ${verbFor(p.on)} it. `
    + 'Say "yes" to save it, "call it ..." to rename it, "make it 200 m" to change its size, or "cancel".';
}

/**
 * @description "here", "this store", "I'm at X": arm at the saved place the person is in, or propose a new one at their fix.
 * @param db - The pool.
 * @param turn - The reminder turn.
 * @param nowMs - The clock.
 * @returns The answer.
 */
async function reminderHere(db: LocationDb, turn: Extract<JarvisLocationTurn, { kind: 'reminder' }>, nowMs: number): Promise<string> {
  const fix = await freshFix(db, turn.principal, nowMs);
  if (!fix) return 'I don\'t have a recent position for you. Turn location on for this browser in Settings, Location, then ask me again while you\'re there.';
  const cls = String(fix.precision_class);
  if (fix.lat === null || fix.lon === null || (cls !== 'exact' && cls !== 'block')) {
    return `Your location is kept at ${cls} precision, which is too coarse to pin a place. Add the place in Settings, Location instead.`;
  }
  const guess = placeGuess(turn.phrase);
  const generic = HERE_PHRASE.test(turn.phrase.replace(/^the\s+/i, ''));
  const atSaved = fix.place_id && (generic || fix.place_label === guess.label || String(fix.place_name).toLowerCase() === guess.name.toLowerCase());
  if (atSaved) {
    await armReminders(db, turn.principal, [String(fix.place_id)], turn, true);
    return `You're at ${String(fix.place_name)}. Next time you ${verbFor(turn.on)} it, I'll remind you to ${turn.action}.`;
  }
  if (proposals.size >= MAX_PENDING) proposals.delete(proposals.keys().next().value as string);
  const proposal: PlaceProposal = {
    principal: turn.principal, center: { lat: Number(fix.lat), lon: Number(fix.lon) }, name: guess.name, label: guess.label,
    radiusM: cls === 'exact' ? LOCATION_HERE_RADIUS_M.exact : LOCATION_HERE_RADIUS_M.block,
    action: turn.action, on: turn.on, expiresAtMs: nowMs + LOCATION_PROPOSAL_TTL_MS,
  };
  proposals.set(turn.key, proposal);
  return proposalText(proposal);
}

/**
 * @description Answer a pending proposal: cancel it, change it, or save the place and arm the reminder.
 * @param db - The pool.
 * @param turn - The reply turn.
 * @param nowMs - The clock.
 * @returns The answer.
 */
async function answerProposal(db: LocationDb, turn: Extract<JarvisLocationTurn, { kind: 'reply' }>, nowMs: number): Promise<string> {
  const proposal = liveProposal(turn.key, nowMs);
  if (!proposal) return 'That suggestion has expired. Ask me again while you\'re there.';
  if (turn.reply === 'cancel') { proposals.delete(turn.key); return 'OK, I won\'t save it.'; }
  if (turn.name) proposal.name = turn.name;
  if (turn.radiusM !== undefined) {
    if (turn.radiusM < LOCATION_PLACE_RADIUS_M.min || turn.radiusM > LOCATION_PLACE_RADIUS_M.max) {
      return `A place can be ${LOCATION_PLACE_RADIUS_M.min} m to ${LOCATION_PLACE_RADIUS_M.max} m across. ${proposalText(proposal)}`;
    }
    proposal.radiusM = turn.radiusM;
  }
  if (turn.reply === 'edit') return proposalText(proposal);
  proposals.delete(turn.key);
  const place = await createLocationPlace(db, turn.principal, parsePlaceInput({ name: proposal.name, label: proposal.label,
    radiusM: proposal.radiusM, center: proposal.center }, 'create'));
  await armReminders(db, turn.principal, [place.placeId], { action: proposal.action, phrase: proposal.name, here: true, on: proposal.on }, true);
  log.info({ op: 'jarvis-here', outcome: 'saved', placeId: place.placeId }, 'location place saved and reminder armed from Jarvis');
  return `Saved "${place.name}". Next time you ${verbFor(proposal.on)} it, I'll remind you to ${proposal.action}.`;
}

/**
 * @description Carry out a detected location turn and answer in words. Never throws: a refusal from
 * the location services is answered with its own message, anything else with a retry line.
 * @param db - The app pool.
 * @param turn - The turn {@link detectJarvisLocationTurn} returned.
 * @param nowMs - The clock.
 * @returns The answer to show and speak.
 */
export async function runJarvisLocationTurn(db: LocationDb, turn: JarvisLocationTurn, nowMs: number = Date.now()): Promise<string> {
  if (turn.kind === 'refused') return 'I can set location reminders only from oshal open in your signed-in browser. Ask me there.';
  try {
    if (turn.kind === 'reply') return await answerProposal(db, turn, nowMs);
    if (turn.action.length < 3) return 'What should I remind you about when you get there?';
    return turn.here ? await reminderHere(db, turn, nowMs) : await reminderAtSavedPlaces(db, turn);
  } catch (error) {
    if (error instanceof LocationRequestError) return `I couldn't set that up: ${error.message}`;
    log.error({ op: 'jarvis-turn', outcome: 'failed', err: locationSafeError(error) }, 'location Jarvis turn failed');
    return 'I couldn\'t set that location reminder up just now. Try again in a moment.';
  }
}

/**
 * @description Drop every pending proposal (tests).
 * @returns Nothing.
 */
export function clearLocationProposals(): void {
  proposals.clear();
}
