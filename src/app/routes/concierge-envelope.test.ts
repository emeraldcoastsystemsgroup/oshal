import { describe, it, expect } from 'vitest';
import { extractEnvelopeJson, asStringArray, sayOr } from './concierge-envelope';
import { normTrack } from './spotify-client';

// These cover the fragile, silent-failure-prone pure logic behind the concierges:
// LLM-reply JSON extraction, array coercion, TMDB v3/v4 key detection, and the API
// normalizers. No DB / network — pure functions only.

describe('extractEnvelopeJson — pulls JSON out of whatever the model returns', () => {
  it('parses a bare JSON object', () => {
    expect(extractEnvelopeJson('{"say":"hi","show":["a"]}')).toEqual({ say: 'hi', show: ['a'] });
  });
  it('parses a ```json fenced block', () => {
    const t = 'Sure!\n```json\n{"say":"ok","show":[]}\n```\nthanks';
    expect(extractEnvelopeJson(t)).toEqual({ say: 'ok', show: [] });
  });
  it('parses an object wrapped in prose (first { … last })', () => {
    expect(extractEnvelopeJson('Here you go: {"say":"x"} — enjoy')).toEqual({ say: 'x' });
  });
  it('returns null on prose with no object', () => {
    expect(extractEnvelopeJson('I could not find anything.')).toBeNull();
  });
  it('returns null on malformed JSON (degrades, never throws)', () => {
    expect(extractEnvelopeJson('{"say": "oops", show: }')).toBeNull();
  });
  it('returns null on a top-level array (we want an object envelope)', () => {
    expect(extractEnvelopeJson('[1,2,3]')).toBeNull();
  });
  it('returns null on empty/whitespace input', () => {
    expect(extractEnvelopeJson('')).toBeNull();
    expect(extractEnvelopeJson('   ')).toBeNull();
  });
});

describe('asStringArray', () => {
  it('stringifies + drops empty strings (the contract; a literal null stringifies to "null", harmless)', () => {
    expect(asStringArray(['a', 1, '', 'b'])).toEqual(['a', '1', 'b']);
  });
  it('non-arrays → []', () => {
    expect(asStringArray('nope')).toEqual([]);
    expect(asStringArray(undefined)).toEqual([]);
    expect(asStringArray({})).toEqual([]);
  });
});

describe('sayOr', () => {
  it('uses the envelope say when present', () => {
    expect(sayOr({ say: 'hello' }, 'fb')).toBe('hello');
  });
  it('falls back when say is blank/missing/non-string', () => {
    expect(sayOr({ say: '   ' }, 'fb')).toBe('fb');
    expect(sayOr({}, 'fb')).toBe('fb');
    expect(sayOr({ say: 42 } as never, 'fb')).toBe('fb');
    expect(sayOr(null, 'fb')).toBe('fb');
  });
});

// (The movies- and spotify-APP blocks — parseEnvelope(Movies/Spotify), isV4 TMDB key
//  detection, normTitle — moved to their store packages' tests at the ADR-085 Wave 2 carves.
//  normTrack stays: spotify-client.ts is CORE — the platform spotify connector runtime
//  imports it, so it never vendored.)

describe('normTrack (Spotify) — track normalization', () => {
  it('joins artists, picks album art, keeps the open-url', () => {
    const t = normTrack({
      id: 'abc', name: 'Song', uri: 'spotify:track:abc',
      artists: [{ name: 'A' }, { name: 'B' }],
      album: { name: 'Alb', images: [{ url: 'big' }, { url: 'small' }] },
      external_urls: { spotify: 'https://open.spotify.com/track/abc' },
    });
    expect(t).toMatchObject({ id: 'abc', title: 'Song', artist: 'A, B', album: 'Alb', imageUrl: 'small', url: 'https://open.spotify.com/track/abc' });
  });
  it('synthesizes a uri/url from id when missing, tolerates no artists', () => {
    const t = normTrack({ id: 'xyz', name: 'Solo' });
    expect(t.uri).toBe('spotify:track:xyz');
    expect(t.url).toBe('https://open.spotify.com/track/xyz');
    expect(t.artist).toBe('Unknown');
  });
});

