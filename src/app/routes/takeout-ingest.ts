/**
 * Takeout ingestion spine — the generic "unzip a Google Takeout archive and pull out the
 * slices we know how to use" layer (ADR-038 storage). It is deliberately app-agnostic: it
 * only extracts the file contents for known slice patterns and tags each with a `kind`/`app`;
 * the caller (takeout-routes) routes each slice to the owning app's ingest function.
 *
 * Extraction is SELECTIVE and streamed (yauzl, lazyEntries) so a multi-GB archive is read
 * entry-by-entry and only the matched files are pulled into memory — we never inflate the
 * whole Takeout. Two sources: an in-memory Buffer (browser upload) or a file path (a large
 * archive downloaded from the user's Dropbox to a temp file).
 *
 * No slices are registered today: the v1 YouTube watch-history slice left with the
 * youtube-kids carve (ADR-085). Adding a lens = one KNOWN_SLICES entry + a route case;
 * no change to the extractor.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — selective streamed extraction of known Takeout slices (yauzl) from a Buffer or a file path; v1 slice = YouTube watch-history.json. Flags HTML-format history so the surface can ask for a JSON re-export.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 1 carve #2: removed the youtube-watch-history slice + its HTML hint — youtube-kids carved to the store (no app literals in the kernel). Extractor unchanged; KNOWN_SLICES is empty until the next lens (or package-contributed registration) lands.
 *
 * @module takeout-ingest
 */

import * as yauzl from 'yauzl';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'takeout-ingest' });

/** A slice of a Takeout archive this platform knows how to consume. */
export interface TakeoutSliceSpec {
  kind: string;   // stable id the router switches on (e.g. 'location-history')
  app: string;    // owning app/manifest name
  label: string;  // human label for the surface
  match: RegExp;  // tested against the zip entry's full path
}

/** The known slices. Order matters only for display; matching is independent. */
export const KNOWN_SLICES: TakeoutSliceSpec[] = [];

/** A known slice whose contents were pulled out of the archive. */
export interface ExtractedSlice {
  kind: string;
  app: string;
  label: string;
  fileName: string;
  content: string;
}

/** Result of scanning one archive. `htmlHits` flags slices present only in HTML format. */
export interface TakeoutScan {
  slices: ExtractedSlice[];
  htmlHits: string[];
}

/** Entry paths that indicate a known slice was exported as HTML instead of JSON. */
const HTML_HINTS: RegExp[] = [];

/**
 * @description Walks an opened zip entry-by-entry, reading only the entries that match a
 * known slice into memory; everything else is skipped. Also records HTML-format hits.
 * @param zip - An opened yauzl ZipFile (must be opened with lazyEntries:true).
 * @returns The matched slices plus any HTML-only slice hits.
 */
function harvest(zip: yauzl.ZipFile): Promise<TakeoutScan> {
  return new Promise((resolve, reject) => {
    const slices: ExtractedSlice[] = [];
    const htmlHits: string[] = [];
    zip.on('error', reject);
    zip.on('end', () => resolve({ slices, htmlHits }));
    zip.on('entry', (entry: yauzl.Entry) => {
      const name = entry.fileName.replace(/\\/g, '/'); // normalize separators (some zips use backslashes)
      if (/\/$/.test(name)) { zip.readEntry(); return; } // directory entry
      if (HTML_HINTS.some((r) => r.test(name))) htmlHits.push(name);
      const spec = KNOWN_SLICES.find((s) => s.match.test(name));
      if (!spec) { zip.readEntry(); return; }
      zip.openReadStream(entry, (err, rs) => {
        if (err || !rs) { logger.warn({ err, name }, 'openReadStream failed; skipping slice'); zip.readEntry(); return; }
        const chunks: Buffer[] = [];
        rs.on('data', (c: Buffer) => chunks.push(c));
        rs.on('error', (e) => { logger.warn({ err: e, name }, 'slice read error; skipping'); zip.readEntry(); });
        rs.on('end', () => {
          slices.push({ kind: spec.kind, app: spec.app, label: spec.label, fileName: name, content: Buffer.concat(chunks).toString('utf8') });
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
}

/**
 * @description Extracts known Takeout slices from an in-memory zip (browser upload path).
 * @param buf - The raw zip archive bytes.
 * @returns The matched slices + HTML hits. Rejects if the buffer is not a valid zip.
 */
export function extractTakeoutSlicesFromBuffer(buf: Buffer): Promise<TakeoutScan> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) { reject(err || new Error('not a zip archive')); return; }
      harvest(zip).then(resolve, reject);
    });
  });
}

/**
 * @description Extracts known Takeout slices from a zip on disk (Dropbox-pickup path — a
 * large archive is downloaded to a temp file and streamed, never held whole in memory).
 * @param filePath - Absolute path to the zip archive.
 * @returns The matched slices + HTML hits. Rejects if the file is not a valid zip.
 */
export function extractTakeoutSlicesFromFile(filePath: string): Promise<TakeoutScan> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) { reject(err || new Error('not a zip archive')); return; }
      harvest(zip).then(resolve, reject);
    });
  });
}
