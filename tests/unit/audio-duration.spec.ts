/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1b guard for measureAudioSeconds, the clip duration speech-to-text spend is priced on. Built byte by byte from the container specifications, never from a recording: a 16 kHz 16-bit WAV (exact, and a streamed one whose data size is unknown), an Ogg Opus stream (the last page's granule at 48 kHz less the OpusHead pre-skip), a WebM that writes Info.Duration, and a WebM as MediaRecorder writes it (unknown-size Segment and Cluster, no Duration: the last SimpleBlock's absolute timecode). An MP3, a truncated header and random bytes answer null — never a guess.
 */

import { describe, expect, it } from 'vitest';
import { measureAudioSeconds } from '@/features/voice-providers';

/** A PCM WAV of `seconds` at 16 kHz mono 16-bit; `streamed` writes the unknown data size a live recorder uses. */
function wav(seconds: number, streamed = false): Buffer {
  const data = Buffer.alloc(Math.round(16_000 * 2 * seconds));
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(16_000, 12); fmt.writeUInt32LE(32_000, 16);
  fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'ascii');
  dataHeader.writeUInt32LE(streamed ? 0xffffffff : data.length, 4);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii'); riff.writeUInt32LE(4 + fmt.length + 8 + data.length, 4); riff.write('WAVE', 8, 'ascii');
  return Buffer.concat([riff, fmt, dataHeader, data]);
}

/** One Ogg page carrying `payload` at granule position `granule`. */
function oggPage(granule: bigint, payload: Buffer): Buffer {
  const header = Buffer.alloc(27);
  header.write('OggS', 0, 'ascii');
  header.writeBigInt64LE(granule, 6);
  header.writeUInt8(1, 26);
  return Buffer.concat([header, Buffer.from([Math.min(255, payload.length)]), payload]);
}

/** An Ogg Opus stream of `seconds` with a 312-sample pre-skip. */
function oggOpus(seconds: number): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'ascii'); head.writeUInt8(1, 8); head.writeUInt8(1, 9); head.writeUInt16LE(312, 10); head.writeUInt32LE(48_000, 12);
  return Buffer.concat([oggPage(0n, head), oggPage(0n, Buffer.from('OpusTags')), oggPage(BigInt(seconds * 48_000 + 312), Buffer.alloc(40))]);
}

/** An EBML element: id bytes, a size vint, the payload. `unknown` writes the all-ones 8-byte size. */
function el(id: number[], payload: Buffer, unknown = false): Buffer {
  const size = unknown ? Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) : Buffer.from([0x08 /* 5-byte vint */, 0, 0, 0, 0]);
  if (!unknown) size.writeUInt32BE(payload.length, 1);
  return Buffer.concat([Buffer.from(id), size, payload]);
}
const uint = (value: number, bytes: number): Buffer => { const b = Buffer.alloc(bytes); b.writeUIntBE(value, 0, bytes); return b; };
const block = (relative: number): Buffer => { const b = Buffer.alloc(8); b.writeUInt8(0x81, 0); b.writeInt16BE(relative, 1); b.writeUInt8(0x80, 3); return el([0xa3], b); };
const EBML_HEADER = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], Buffer.from('webm')));

/** A WebM whose Info carries Duration (ms at the default 1 ms timecode scale). */
function webmWithDuration(ms: number): Buffer {
  const duration = Buffer.alloc(8); duration.writeDoubleBE(ms, 0);
  const info = el([0x15, 0x49, 0xa9, 0x66], Buffer.concat([el([0x2a, 0xd7, 0xb1], uint(1_000_000, 3)), el([0x44, 0x89], duration)]));
  return Buffer.concat([EBML_HEADER, el([0x18, 0x53, 0x80, 0x67], info, true)]);
}

/** A WebM as MediaRecorder writes it: unknown-size Segment and Clusters, no Duration. */
function webmRecorded(): Buffer {
  const info = el([0x15, 0x49, 0xa9, 0x66], el([0x2a, 0xd7, 0xb1], uint(1_000_000, 3)));
  const tracks = el([0x16, 0x54, 0xae, 0x6b], Buffer.from('track-entry'));
  const first = el([0x1f, 0x43, 0xb6, 0x75], Buffer.concat([el([0xe7], uint(0, 2)), block(0), block(500), block(980)]), true);
  const second = el([0x1f, 0x43, 0xb6, 0x75], Buffer.concat([el([0xe7], uint(1000, 2)), block(0), block(960)]), true);
  return Buffer.concat([EBML_HEADER, el([0x18, 0x53, 0x80, 0x67], Buffer.concat([info, tracks, first, second]), true)]);
}

describe('measureAudioSeconds (ADR-173 S1b: STT spend is audio seconds times the unit price)', () => {
  it('a WAV is exact, and a streamed WAV with an unknown data size is measured from its bytes', () => {
    expect(measureAudioSeconds(wav(1.5), 'audio/wav')).toBe(1.5);
    expect(measureAudioSeconds(wav(2.25, true), 'audio/wav')).toBe(2.25);
  });

  it('Ogg Opus is the last granule at 48 kHz less the pre-skip', () => {
    expect(measureAudioSeconds(oggOpus(2), 'audio/ogg')).toBe(2);
  });

  it('a WebM with Info.Duration uses it', () => {
    expect(measureAudioSeconds(webmWithDuration(2500), 'audio/webm')).toBe(2.5);
  });

  it('a MediaRecorder WebM (unknown sizes, no Duration) is the last block\'s absolute timecode', () => {
    expect(measureAudioSeconds(webmRecorded(), 'audio/webm;codecs=opus')).toBe(1.96);
  });

  it('answers null rather than guessing for MP3, a truncated header and random bytes', () => {
    expect(measureAudioSeconds(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200)]), 'audio/mpeg')).toBeNull();
    expect(measureAudioSeconds(wav(1).subarray(0, 20), 'audio/wav')).toBeNull();
    expect(measureAudioSeconds(Buffer.from('not audio at all, just words'), 'audio/webm')).toBeNull();
    expect(measureAudioSeconds(Buffer.alloc(0), 'audio/wav')).toBeNull();
  });
});
