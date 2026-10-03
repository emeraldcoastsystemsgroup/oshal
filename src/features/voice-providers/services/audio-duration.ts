/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1b (D4): speech-to-text spend is the call's audio seconds times the provider's unit price, so the seconds are measured here from the clip itself, independent of any vendor: WAV from its RIFF header (exact), Ogg from the last page's granule position (Opus at 48 kHz less its pre-skip, Vorbis at its own rate), and WebM/Matroska — what a browser's MediaRecorder sends — from Info.Duration when present, else the last block's timecode. Anything else (MP3, MP4) answers null rather than a guess, and the recorder logs the call as unpriced. Read-only over the bytes; never throws.
 */

/**
 * @description Measure an audio clip's duration from its container (ADR-173 S1b spend).
 * @module features/voice-providers/services/audio-duration
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'audio-duration' });

const OPUS_GRANULE_RATE = 48_000;

/** @description WAV: data chunk bytes over the fmt chunk's byte rate. */
function wavSeconds(audio: Buffer): number | null {
  if (audio.length < 12 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') return null;
  let byteRate = 0;
  for (let offset = 12; offset + 8 <= audio.length;) {
    const id = audio.toString('ascii', offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 20 <= audio.length) byteRate = audio.readUInt32LE(offset + 16);
    if (id === 'data') {
      const bytes = size === 0xffffffff || offset + 8 + size > audio.length ? audio.length - offset - 8 : size;
      return byteRate > 0 ? bytes / byteRate : null;
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

/** @description Ogg: the last page's granule position, in the codec's own clock. */
function oggSeconds(audio: Buffer): number | null {
  if (audio.length < 27 || audio.toString('ascii', 0, 4) !== 'OggS') return null;
  const last = audio.lastIndexOf('OggS');
  if (last < 0 || last + 14 > audio.length) return null;
  const granule = Number(audio.readBigInt64LE(last + 6));
  const opus = audio.indexOf('OpusHead');
  if (opus >= 0 && opus + 12 <= audio.length) {
    const preSkip = audio.readUInt16LE(opus + 10);
    return Math.max(0, granule - preSkip) / OPUS_GRANULE_RATE;
  }
  const vorbis = audio.indexOf('\u0001vorbis', 0, 'latin1');
  if (vorbis >= 0 && vorbis + 16 <= audio.length) {
    const rate = audio.readUInt32LE(vorbis + 12);
    return rate > 0 ? granule / rate : null;
  }
  return null;
}

/** One EBML header: the element id, its data offset and size (null = unknown size). */
interface EbmlHeader { id: number; dataStart: number; size: number | null }

/** @description Read one EBML variable-length integer; marker bit removed when `strip`. */
function readVint(audio: Buffer, offset: number, strip: boolean): { value: number; length: number; allOnes: boolean } | null {
  const first = audio[offset];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length < 1 || length > 8 || offset + length > audio.length) return null;
  let value = strip ? first & (0xff >> length) : first;
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i += 1) {
    value = value * 256 + audio[offset + i];
    allOnes = allOnes && audio[offset + i] === 0xff;
  }
  return { value, length, allOnes };
}

/** @description The header of the EBML element at `offset`. */
function readEbmlHeader(audio: Buffer, offset: number): EbmlHeader | null {
  const id = readVint(audio, offset, false);
  if (!id) return null;
  const size = readVint(audio, offset + id.length, true);
  if (!size) return null;
  return { id: id.value, dataStart: offset + id.length + size.length, size: size.allOnes ? null : size.value };
}

const EBML = { segment: 0x18538067, cluster: 0x1f43b675, info: 0x1549a966, timecodeScale: 0x2ad7b1, duration: 0x4489,
  timecode: 0xe7, simpleBlock: 0xa3, blockGroup: 0xa0, block: 0xa1 } as const;
/** Elements whose children are walked in place (their size may be unknown in a live recording). */
const CONTAINERS: ReadonlySet<number> = new Set([EBML.segment, EBML.cluster, EBML.info, EBML.blockGroup]);

/** @description An unsigned big-endian integer of `size` bytes. */
function readUint(audio: Buffer, start: number, size: number): number {
  let value = 0;
  for (let i = 0; i < size && start + i < audio.length; i += 1) value = value * 256 + audio[start + i];
  return value;
}

/** @description WebM/Matroska: Info.Duration when written, else the last block's absolute timecode. */
function webmSeconds(audio: Buffer): number | null {
  if (audio.length < 4 || audio.readUInt32BE(0) !== 0x1a45dfa3) return null;
  let scale = 1_000_000;
  let duration: number | null = null;
  let cluster = 0;
  let lastBlock = -1;
  for (let offset = 0; offset < audio.length;) {
    const header = readEbmlHeader(audio, offset);
    if (!header) break;
    if (CONTAINERS.has(header.id)) { offset = header.dataStart; continue; }
    if (header.size === null) break;
    const { id, dataStart, size } = header;
    if (id === EBML.timecodeScale) scale = readUint(audio, dataStart, size) || scale;
    else if (id === EBML.duration && (size === 4 || size === 8) && dataStart + size <= audio.length) duration = size === 8 ? audio.readDoubleBE(dataStart) : audio.readFloatBE(dataStart);
    else if (id === EBML.timecode) cluster = readUint(audio, dataStart, size);
    else if ((id === EBML.simpleBlock || id === EBML.block) && dataStart + 4 <= audio.length) {
      const track = readVint(audio, dataStart, true);
      if (track && dataStart + track.length + 2 <= audio.length) lastBlock = Math.max(lastBlock, cluster + audio.readInt16BE(dataStart + track.length));
    }
    offset = dataStart + size;
  }
  const ticks = duration !== null && duration > 0 ? duration : lastBlock >= 0 ? lastBlock : null;
  return ticks === null ? null : (ticks * scale) / 1e9;
}

/**
 * @description The duration of an audio clip in seconds, from its container, or null when the
 * container is not one this measures (MP3, MP4) or the bytes do not parse.
 * @param audio - The clip.
 * @param mimeType - Its declared type (a hint; the bytes decide).
 * @returns Seconds, or null.
 */
export function measureAudioSeconds(audio: Buffer, mimeType = ''): number | null {
  try {
    const seconds = wavSeconds(audio) ?? oggSeconds(audio) ?? webmSeconds(audio);
    if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
    return Math.round(seconds * 1000) / 1000;
  } catch (err) {
    // Malformed bytes are "not measurable": the caller records the call as unpriced, and a
    // measurement must never fail a transcription.
    logger.error({ err, bytes: audio.length, mimeType }, 'Audio duration could not be read from the clip — spend is recorded unpriced');
    return null;
  }
}
