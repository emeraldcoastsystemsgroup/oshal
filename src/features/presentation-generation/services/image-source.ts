/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — resolves a slide's `#image:` to a safe inline data URI before it reaches a layout. Two problems this closes: (1) pptxgenjs fetches a remote `path` ITSELF from the api container, so an author-supplied URL is a server-side request to an arbitrary host — SSRF straight at the cloud metadata endpoint; (2) it embeds whatever comes back without checking, so a 404 HTML page becomes a corrupt .jpg inside the deck. Anything that fails a check is dropped, and the image layouts already degrade to a typographic treatment.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Hardened the fetch. Was: a hand-rolled private-IP check (weaker than the platform's), a validate-then-fetch that left a DNS-rebind window, and an unbounded arrayBuffer() read that a lying/absent Content-Length turned into a memory-exhaustion DoS. Now: reuse the sanctioned @/shared/security ssrf-guard; connect over node:http(s) with a connect-time `lookup` that re-validates the resolved IP (so the address we VALIDATE is the address we CONNECT to — closes the rebind TOCTOU); refuse redirects; and stream the body with a hard byte cap that aborts the request the moment it is exceeded.
 */

import http from 'http';
import https from 'https';
import { lookup as dnsLookup, type LookupOneOptions } from 'dns';
import { createChildLogger } from '@/shared/logger';
import { assertPublicHttpUrl, isPrivateIp } from '@/shared/security/ssrf-guard';
import type { RenderableSlide } from '@/shared/types';

const logger = createChildLogger({ module: 'pptx-image-source' });

/** Hard cap on a fetched image. Bigger than this and the deck stops being emailable anyway. */
const MAX_BYTES = 8 * 1024 * 1024;
/** A slow host must not hang a deck the user is waiting on. */
const TIMEOUT_MS = 6_000;

/** Magic-byte signatures for the raster formats PowerPoint renders reliably. */
const SIGNATURES: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: (b) => b.subarray(0, 6).toString('latin1').startsWith('GIF8') },
  { mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

/**
 * @description Identify an image by its CONTENT, not its URL or its Content-Type header.
 * A server can claim `image/jpeg` and return an error page; PowerPoint then shows a broken
 * slide the user can't explain. Sniffing the bytes is the only honest check.
 * @param buf - the fetched bytes.
 * @returns the detected MIME type, or null when the bytes are not a supported image.
 */
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  return SIGNATURES.find((s) => s.test(buf))?.mime ?? null;
}

/** Pass through an author-supplied `data:image/...;base64,...` after sniffing its payload. */
function fromDataUri(src: string): string | null {
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(src.trim());
  if (!m) return null;
  let buf: Buffer;
  try { buf = Buffer.from(m[2], 'base64'); } catch { return null; }
  if (buf.length > MAX_BYTES) return null;
  const mime = sniffImageMime(buf);
  return mime ? `data:${mime};base64,${buf.toString('base64')}` : null;
}

/**
 * A DNS `lookup` that re-validates the resolved address AT CONNECT TIME and refuses private
 * ones. Passed to http(s).request, so the address the socket connects to is the exact address
 * this function approved — there is no second, unchecked resolution. That is what closes the
 * DNS-rebind window `assertPublicHttpUrl` alone leaves open (validate one lookup, then let
 * fetch resolve again to whatever the attacker's DNS now returns).
 */
const safeLookup: typeof dnsLookup = ((hostname: string, options: unknown, cb: unknown) => {
  const callback = (typeof options === 'function' ? options : cb) as
    (err: NodeJS.ErrnoException | null, address: string, family: number) => void;
  // Force a single address regardless of what the caller asked for — we only connect to one,
  // and `all:true` would change the callback shape.
  const opts: LookupOneOptions = { ...(typeof options === 'object' && options ? options as LookupOneOptions : {}), all: false };
  dnsLookup(hostname, opts, (err, address, family) => {
    if (err) { callback(err, '', 0); return; }
    if (isPrivateIp(address)) {
      callback(Object.assign(new Error('resolved to a private address'), { code: 'EAI_BLOCKED' }), '', 0);
      return;
    }
    callback(null, address, family);
  });
}) as typeof dnsLookup;

/**
 * @description Fetch an image over http(s) under the DoS guards: redirects are refused (a
 * validated URL must not 3xx to the metadata endpoint), and the body is streamed under a hard
 * byte cap that destroys the request the instant it is crossed (an absent or lying
 * Content-Length must not let a host stream unbounded data into the api container's memory).
 * The connect-time `safeLookup` re-validates any HOSTNAME's resolved IP; IP-literal hosts skip
 * lookup entirely and are the caller's responsibility to pre-check (`resolveImage` does, via
 * `assertPublicHttpUrl`). Exported for direct testing of the cap; callers use `resolveImage`.
 * @param rawUrl - an http(s) URL already asserted public.
 * @returns the sniffed image bytes + mime, or null when dropped.
 */
export function fetchCapped(rawUrl: string): Promise<{ mime: string; buf: Buffer } | null> {
  return new Promise((resolve) => {
    let url: URL;
    try { url = new URL(rawUrl); } catch { resolve(null); return; }
    const mod = url.protocol === 'https:' ? https : http;

    const req = mod.request(url, { method: 'GET', timeout: TIMEOUT_MS, lookup: safeLookup }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 || status < 200) { res.destroy(); resolve(null); return; } // no redirects, no errors
      if (Number(res.headers['content-length'] || 0) > MAX_BYTES) { req.destroy(); resolve(null); return; }

      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (c: Buffer) => {
        total += c.length;
        if (total > MAX_BYTES) { req.destroy(); resolve(null); return; } // abort mid-stream, never buffer it all
        chunks.push(c);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const mime = sniffImageMime(buf);
        resolve(mime ? { mime, buf } : null);
      });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

/** Fetch a remote image, refusing internal hosts and non-image payloads. */
async function fromUrl(src: string): Promise<string | null> {
  try {
    // Protocol + hostname denylist + an all-addresses pre-check (the platform SSRF guard). The
    // connect-time `safeLookup` is what actually enforces it against rebinding; this rejects the
    // obvious cases early and consistently with the rest of the app.
    await assertPublicHttpUrl(src);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'image fetch refused — url failed the SSRF guard');
    return null;
  }
  const got = await fetchCapped(src);
  if (!got) {
    logger.warn({ host: safeHost(src) }, 'image fetch dropped — unreachable, too large, refused, or not an image');
    return null;
  }
  return `data:${got.mime};base64,${got.buf.toString('base64')}`;
}

/** Host for a log line, without leaking the full (possibly credentialed) URL. */
function safeHost(src: string): string {
  try { return new URL(src).host; } catch { return '?'; }
}

/**
 * @description Resolve one image reference to an inline data URI, or null.
 * @param src - a `data:` URI or an http(s) URL from `#image:` / `slide.image`.
 * @returns a sniffed, size-capped `data:` URI, or null when it is unsafe or not an image.
 */
export async function resolveImage(src?: string): Promise<string | null> {
  const s = String(src ?? '').trim();
  if (!s) return null;
  if (/^data:/i.test(s)) return fromDataUri(s);
  return fromUrl(s);
}

/**
 * @description Resolve every slide's image up front, concurrently, so layouts stay synchronous
 * draw functions and never see a URL. A slide whose image is unsafe, unreachable, or not
 * actually an image comes back with `image` cleared — the image layouts already fall back to a
 * typographic treatment, so the deck still renders.
 * @param slides - the authored slides.
 * @returns the same slides with `image` either an inline data URI or absent.
 */
export async function resolveSlideImages(slides: RenderableSlide[]): Promise<RenderableSlide[]> {
  const refs = slides.map((s) => s.image ?? /^#image:\s*(.+)$/im.exec(String(s.content ?? ''))?.[1]);
  if (!refs.some(Boolean)) return slides;

  const resolved = await Promise.all(refs.map((r) => (r ? resolveImage(r) : Promise.resolve(null))));
  const dropped = refs.filter((r, i) => r && !resolved[i]).length;
  if (dropped) logger.warn({ dropped }, 'slide images dropped — rendering those slides without an image');

  return slides.map((s, i) => {
    const img = resolved[i];
    if (!refs[i]) return s;
    const next = { ...s, image: img ?? undefined };
    // Strip the directive too, so the parser can't hand a layout the raw URL we just refused.
    if (!img && s.content) next.content = String(s.content).replace(/^#image:\s*.+$/gim, '');
    return next;
  });
}
