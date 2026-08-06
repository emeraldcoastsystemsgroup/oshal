/**
 * Takeout ingestion spine: selectively extract active package-owned slices from a Google
 * Takeout archive. Package manifests contribute literal suffixes; this kernel layer retains
 * every archive safety decision and never imports an application.
 *
 * Extraction is streamed with yauzl/lazyEntries. Only a matched entry is inflated, every entry
 * has a declared uncompressed ceiling, duplicate slice entries are rejected, and total retained
 * data is bounded. The browser and Dropbox paths share this exact implementation.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | Initial selective Takeout extraction with YouTube history support.
 * 2   | maintainer@emeraldcoastsystemsgroup.com     | Remove the carved youtube-kids literal from the kernel.
 * 3   | maintainer@emeraldcoastsystemsgroup.com     | Accept active package specs; add literal matching, traversal rejection, duplicate detection, and zip-bomb byte fences.
 *
 * @module takeout-ingest
 */

import * as yauzl from 'yauzl';

/** Maximum aggregate UTF-8 source bytes retained from one archive scan. */
const MAX_RETAINED_BYTES = 256 * 1024 * 1024;

/** One active package-owned slice the archive scanner may extract. */
export interface TakeoutSliceSpec {
  /** Stable id unique across active applications. */
  kind: string;
  /** Owning manifest/application name. */
  app: string;
  /** Human label returned to the caller. */
  label: string;
  /** Case-insensitive literal suffix for the JSON archive entry. */
  pathSuffix: string;
  /** Optional HTML counterpart used to explain a required JSON re-export. */
  htmlPathSuffix?: string;
  /** Maximum uncompressed bytes accepted for this one entry. */
  maxBytes: number;
}

/** A known slice whose contents passed the archive guards. */
export interface ExtractedSlice {
  kind: string;
  app: string;
  label: string;
  fileName: string;
  content: string;
}

/** Result of scanning one archive. `htmlHits` reports known data exported in HTML format. */
export interface TakeoutScan {
  slices: ExtractedSlice[];
  htmlHits: string[];
}

/** Typed size failure so HTTP routes can return 413 rather than misreporting a bad zip. */
export class TakeoutSliceTooLargeError extends Error {
  readonly code = 'takeout_slice_too_large';

  constructor(readonly fileName: string, readonly maxBytes: number) {
    super(`Takeout entry exceeds its ${maxBytes}-byte uncompressed limit: ${fileName}`);
    this.name = 'TakeoutSliceTooLargeError';
  }
}

/** Reject archives with duplicate entries for one logical app/kind. */
export class DuplicateTakeoutSliceError extends Error {
  readonly code = 'duplicate_takeout_slice';

  constructor(readonly app: string, readonly kind: string) {
    super(`Takeout archive contains more than one ${app}/${kind} entry`);
    this.name = 'DuplicateTakeoutSliceError';
  }
}

/** A suffix match with an explicit segment boundary, not an arbitrary string tail. */
function matchesSuffix(entryName: string, suffix: string): boolean {
  const entry = entryName.toLowerCase();
  const expected = suffix.toLowerCase();
  return entry === expected || entry.endsWith(`/${expected}`);
}

/** Traversal-shaped names are never candidates, even though extraction never writes to disk. */
function isSafeEntryName(entryName: string): boolean {
  if (entryName.startsWith('/') || /^[A-Za-z]:\//.test(entryName) || entryName.includes('\0')) return false;
  return entryName.split('/').every((segment) => segment !== '' && segment !== '..' && segment !== '.');
}

/**
 * @description Walk an opened zip entry-by-entry, inflating only entries matching the supplied
 * active package specs. The returned promise rejects on malformed matched data; it never silently
 * hands a partial or oversized slice to an app.
 */
function harvest(zip: yauzl.ZipFile, specs: readonly TakeoutSliceSpec[]): Promise<TakeoutScan> {
  return new Promise((resolve, reject) => {
    const slices: ExtractedSlice[] = [];
    const htmlHits: string[] = [];
    const seenHtmlKinds = new Set<string>();
    const seen = new Set<string>();
    let retainedBytes = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      try { zip.close(); } catch { /* already closed */ }
      reject(error);
    };

    zip.once('error', (error) => fail(error));
    zip.once('end', () => {
      if (settled) return;
      settled = true;
      resolve({ slices, htmlHits });
    });
    zip.on('entry', (entry: yauzl.Entry) => {
      if (settled) return;
      const name = entry.fileName.replace(/\\/g, '/');
      if (name.endsWith('/') || !isSafeEntryName(name)) {
        zip.readEntry();
        return;
      }

      for (const spec of specs) {
        if (spec.htmlPathSuffix && matchesSuffix(name, spec.htmlPathSuffix)) {
          const htmlIdentity = `${spec.app}\0${spec.kind}`;
          if (!seenHtmlKinds.has(htmlIdentity)) {
            seenHtmlKinds.add(htmlIdentity);
            htmlHits.push(name);
          }
        }
      }

      const spec = specs.find((candidate) => matchesSuffix(name, candidate.pathSuffix));
      if (!spec) {
        zip.readEntry();
        return;
      }

      const identity = `${spec.app}\0${spec.kind}`;
      if (seen.has(identity)) {
        fail(new DuplicateTakeoutSliceError(spec.app, spec.kind));
        return;
      }
      if (entry.uncompressedSize > spec.maxBytes || retainedBytes + entry.uncompressedSize > MAX_RETAINED_BYTES) {
        fail(new TakeoutSliceTooLargeError(name, Math.min(spec.maxBytes, MAX_RETAINED_BYTES - retainedBytes)));
        return;
      }

      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          fail(error ?? new Error(`Unable to read Takeout entry: ${name}`));
          return;
        }
        const chunks: Buffer[] = [];
        let entryBytes = 0;
        stream.on('data', (chunk: Buffer | Uint8Array) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          entryBytes += buffer.length;
          if (entryBytes > spec.maxBytes || retainedBytes + entryBytes > MAX_RETAINED_BYTES) {
            stream.destroy(new TakeoutSliceTooLargeError(name, Math.min(spec.maxBytes, MAX_RETAINED_BYTES - retainedBytes)));
            return;
          }
          chunks.push(buffer);
        });
        stream.once('error', (streamError) => fail(streamError));
        stream.once('end', () => {
          if (settled) return;
          retainedBytes += entryBytes;
          seen.add(identity);
          slices.push({
            kind: spec.kind,
            app: spec.app,
            label: spec.label,
            fileName: name,
            content: Buffer.concat(chunks, entryBytes).toString('utf8'),
          });
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
}

/** Extract active package slices from an in-memory browser upload. */
export function extractTakeoutSlicesFromBuffer(
  buf: Buffer,
  specs: readonly TakeoutSliceSpec[],
): Promise<TakeoutScan> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error('Not a zip archive'));
        return;
      }
      harvest(zip, specs).then(resolve, reject);
    });
  });
}

/** Extract active package slices from a Dropbox-downloaded archive on disk. */
export function extractTakeoutSlicesFromFile(
  filePath: string,
  specs: readonly TakeoutSliceSpec[],
): Promise<TakeoutScan> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error('Not a zip archive'));
        return;
      }
      harvest(zip, specs).then(resolve, reject);
    });
  });
}
