/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L5, the Jarvis "next time I'm at X" intent without a database: the deterministic parser reads the action, the place phrase, "here"/"this store" and the direction from the sentence shapes the ADR names ("remind me to buy milk next time I'm at the grocery store", "I'm at the grocery store, remind me next time to buy milk", "when I leave home", "next time I'm here", "when I get home"), and declines a time reminder, a sentence with no reminder cue and a sentence with no place clause, so the time-reminder intent keeps them. The place guess turns "the grocery store" into "Grocery store" (grocery), "the office" into "Office" (work), "this store" into "Store" and "here" into "Here". A proposal reply reads yes/no, "call it ..." and "make it 200 m" together. Turn detection admits only an interactive browser session with a verified issuer: the service-secret rail, an asserted-subject header, a personal access token, a TV token, a guest token and a session without an issuer are each refused, and a refused turn answers with the "ask me from your signed-in browser" line without touching a database. A reply with no pending proposal is not a turn.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | "Where am I": the parser takes the live phrasing ("Where am i ... what is my location") and its close variants and declines a calendar, weather or reminder sentence; a browser person gets a where turn, every other rail a where-specific refusal answered without a database; and describeFixAge words a position's age.
 */

import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  clearLocationProposals, describeFixAge, detectJarvisLocationTurn, parseLocationReminder, parseProposalReply, parseWhereAmI, placeGuess,
  runJarvisLocationTurn,
} from '@/app/location-jarvis-intent';

const ISSUER = 'https://login.oshal.example.com';
const SECRET = 'fixture-service-secret-value';

/** A request as the authentication rails leave it, with the given req.oidc shape and headers. */
function request(oidc: Record<string, unknown> | null, headers: Record<string, string> = {}): Request {
  return { headers, get: (name: string) => headers[name.toLowerCase()], ...(oidc ? { oidc: { isAuthenticated: () => true, ...oidc } } : {}) } as unknown as Request;
}

const BROWSER = { idToken: 'eyJhbGciOiJSUzI1NiJ9.fixture.sig', idTokenClaims: { iss: ISSUER, sub: 'person-a' }, user: { sub: 'person-a' } };

beforeAll(() => { vi.stubEnv('SWARM_SERVICE_SECRET', SECRET); vi.stubEnv('MOCK_OIDC', 'false'); });
afterAll(() => { vi.unstubAllEnvs(); clearLocationProposals(); });

describe('parseLocationReminder: the sentence shapes ADR-169 names', () => {
  it('reads "remind me to X next time I\'m at Y"', () => {
    expect(parseLocationReminder('Remind me to buy milk next time I\'m at the grocery store'))
      .toEqual({ action: 'buy milk', phrase: 'the grocery store', here: false, on: 'enter' });
    expect(parseLocationReminder('remind me to buy milk next time I’m at the grocery store.'))
      .toEqual({ action: 'buy milk', phrase: 'the grocery store', here: false, on: 'enter' });
  });

  it('reads the leading "I\'m at Y, remind me next time to X" as "here"', () => {
    expect(parseLocationReminder('I\'m at the grocery store, remind me next time to buy milk'))
      .toEqual({ action: 'buy milk', phrase: 'the grocery store', here: true, on: 'enter' });
    expect(parseLocationReminder('I am at work. Please remind me the next time I\'m here to submit my timesheet'))
      .toEqual({ action: 'submit my timesheet', phrase: 'work', here: true, on: 'enter' });
  });

  it('reads "here" and "this store" as the current fix, and "leave" as an exit', () => {
    expect(parseLocationReminder('next time I\'m here remind me to check the tyre pressure')).toMatchObject({ here: true, phrase: 'here', on: 'enter', action: 'check the tyre pressure' });
    expect(parseLocationReminder('remind me to grab the receipt next time I\'m at this store')).toMatchObject({ here: true, phrase: 'this store', on: 'enter' });
    expect(parseLocationReminder('remind me to take the bins out when I leave home')).toMatchObject({ here: false, phrase: 'home', on: 'exit', action: 'take the bins out' });
    expect(parseLocationReminder('when I get home remind me to feed the dog')).toMatchObject({ here: false, phrase: 'home', on: 'enter', action: 'feed the dog' });
  });

  it('declines a time reminder, a sentence with no cue and a sentence with no place clause', () => {
    expect(parseLocationReminder('remind me to call mum at 5pm')).toBeNull();
    expect(parseLocationReminder('remind me tomorrow to water the plants')).toBeNull();
    expect(parseLocationReminder('buy milk next time I\'m at the store')).toBeNull();
    expect(parseLocationReminder('what is next time I\'m at the store')).toBeNull();
    expect(parseLocationReminder('')).toBeNull();
    expect(parseLocationReminder(`remind me ${'x'.repeat(400)} next time I'm at home`)).toBeNull();
  });
});

describe('placeGuess and parseProposalReply', () => {
  it('names and labels a place from its phrase', () => {
    expect(placeGuess('the grocery store')).toEqual({ name: 'Grocery store', label: 'grocery' });
    expect(placeGuess('my supermarket')).toEqual({ name: 'Supermarket', label: 'grocery' });
    expect(placeGuess('home')).toEqual({ name: 'Home', label: 'home' });
    expect(placeGuess('the office')).toEqual({ name: 'Office', label: 'work' });
    expect(placeGuess('this store')).toEqual({ name: 'Store', label: 'other' });
    expect(placeGuess('here')).toEqual({ name: 'Here', label: 'other' });
    expect(placeGuess('the dentist.')).toEqual({ name: 'Dentist', label: 'other' });
  });

  it('reads an answer to a "save it here?" proposal', () => {
    expect(parseProposalReply('yes')).toEqual({ reply: 'confirm' });
    expect(parseProposalReply('OK, save it')).toEqual({ reply: 'confirm' });
    expect(parseProposalReply('cancel')).toEqual({ reply: 'cancel' });
    expect(parseProposalReply('no thanks')).toEqual({ reply: 'cancel' });
    expect(parseProposalReply('call it Corner shop')).toEqual({ reply: 'edit', name: 'Corner shop' });
    expect(parseProposalReply('make it 200 m')).toEqual({ reply: 'edit', radiusM: 200 });
    expect(parseProposalReply('yes, call it "Corner shop" and make it 200 metres')).toEqual({ reply: 'confirm', name: 'Corner shop', radiusM: 200 });
    expect(parseProposalReply('what time is it')).toBeNull();
  });
});

describe('detectJarvisLocationTurn: only a signed-in browser session', () => {
  const sentence = 'remind me to buy milk next time I\'m at the grocery store';

  it('yields a reminder turn for the browser person, keyed on the conversation', () => {
    const turn = detectJarvisLocationTurn(sentence, request(BROWSER), 'conv-1');
    expect(turn).toMatchObject({ kind: 'reminder', principal: { sub: 'person-a', principalIssuer: ISSUER }, action: 'buy milk', phrase: 'the grocery store', here: false, on: 'enter' });
    expect((turn as { key: string }).key).toContain('conv-1');
  });

  it('refuses the service rail, an asserted subject, a token session and a session without an issuer', () => {
    const refused = [
      request(BROWSER, { 'x-service-secret': SECRET }),
      request(BROWSER, { 'x-oshal-user-sub': 'person-a' }),
      request({ idToken: 'cli-token', user: { iss: ISSUER, sub: 'person-a' } }),
      request({ idToken: 'tv-token', user: { iss: ISSUER, sub: 'person-a' } }),
      request({ idToken: 'guest-token', user: { iss: 'urn:oshal:guest', sub: 'guest-1' } }),
      request({ idToken: 'eyJhbGciOiJSUzI1NiJ9.fixture.sig', idTokenClaims: { sub: 'person-a' }, user: { sub: 'person-a' } }),
      request(null),
    ];
    for (const req of refused) expect(detectJarvisLocationTurn(sentence, req, 'conv-1')).toEqual({ kind: 'refused' });
  });

  it('is not a turn for an ordinary message, nor for a reply with no pending proposal', () => {
    expect(detectJarvisLocationTurn('what is the weather like', request(BROWSER), 'conv-1')).toBeNull();
    expect(detectJarvisLocationTurn('yes', request(BROWSER), 'conv-1')).toBeNull();
    expect(detectJarvisLocationTurn('remind me to call mum at 5pm', request(BROWSER), 'conv-1')).toBeNull();
  });

  it('answers a refused turn without a database', async () => {
    const db = { connect: async () => { throw new Error('the pool must not be reached'); } };
    expect(await runJarvisLocationTurn(db as never, { kind: 'refused' })).toBe('I can set location reminders only from oshal open in your signed-in browser. Ask me there.');
  });
});

describe('"where am I": the person\'s own position, asked on its own', () => {
  it('reads the live phrasing and its close variants', () => {
    for (const ask of ['Where am i ... what is my location', 'where am I?', 'Where am I right now', 'what\'s my location',
      'What is my current location?', 'Jarvis, where am I', 'can you tell me where I am', 'do you know my location', 'my location']) {
      expect(parseWhereAmI(ask)).toBe(true);
    }
  });

  it('declines a calendar, weather, reminder or directions sentence', () => {
    for (const ask of ['where am I meeting Sam tomorrow', 'where am I supposed to be at 3', 'what is the weather where I am',
      'remind me to buy milk next time I\'m at the grocery store', 'how far is my location from the airport', 'where is my car']) {
      expect(parseWhereAmI(ask)).toBe(false);
    }
  });

  it('is a where turn for the browser person and a where-specific refusal on every other rail', async () => {
    expect(detectJarvisLocationTurn('where am I?', request(BROWSER), 'conv-1'))
      .toEqual({ kind: 'where', principal: { sub: 'person-a', principalIssuer: ISSUER } });
    for (const req of [request(BROWSER, { 'x-service-secret': SECRET }), request({ idToken: 'cli-token', user: { iss: ISSUER, sub: 'person-a' } }), request(null)]) {
      expect(detectJarvisLocationTurn('where am I?', req, 'conv-1')).toEqual({ kind: 'refused', about: 'where' });
    }
    const db = { connect: async () => { throw new Error('the pool must not be reached'); } };
    expect(await runJarvisLocationTurn(db as never, { kind: 'refused', about: 'where' }))
      .toBe('I can tell where you are only from oshal open in your signed-in browser. Ask me there.');
  });

  it('words a position\'s age', () => {
    expect([20_000, 4 * 60_000, 60 * 60_000, 3 * 3600_000, 50 * 3600_000].map(describeFixAge))
      .toEqual(['just now', '4 min', '1 hour', '3 hours', '2 days']);
  });
});
