/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the rules every custom look must meet before a renderer draws it, shared by the look check behind resolveTheme (deck-themes) and the brand-look builder (brandTheme): Office-safe faces only, six-digit hex only, plain records holding exactly the expected fields, bounded one-line text, and one readable refusal type that is thrown and never turned into the default look (backlog 2026-09-14, approved 2026-09-22).
 */

/**
 * @description Faces that ship with Microsoft Office on BOTH Windows and macOS. A look may name
 * no other face: anything else silently substitutes when the file opens on the desktop and
 * reflows every line the renderer laid out. The ten built-in looks use only these.
 */
export const OFFICE_SAFE_FONTS: readonly string[] = Object.freeze([
  'Calibri', 'Cambria', 'Candara', 'Century Gothic', 'Consolas', 'Constantia', 'Corbel',
  'Garamond', 'Georgia', 'Trebuchet MS', 'Arial', 'Courier New',
]);

/** The code every look refusal carries, so a caller can tell it from a render failure. */
const REFUSAL_CODE = 'invalid_brand_look';

/**
 * @description A custom look the renderers will not draw, with a reason a person can read. It
 * is thrown, never swallowed into the default look: someone who asked for their brand must not
 * receive a different file that merely looks finished.
 */
export class BrandLookError extends TypeError {
  /** Stable code a route maps to a 400 response. */
  readonly code = REFUSAL_CODE;

  /**
   * @description Build the refusal.
   * @param reason - what is wrong, naming the field (never echoing the caller's value).
   */
  constructor(reason: string) {
    super(`Brand look refused: ${reason}`);
    this.name = 'BrandLookError';
  }
}

/**
 * @description Whether a caught error is a look refusal. Matched on the code rather than the
 * class, so it still holds when a package loaded a second copy of this module.
 * @param err - anything caught.
 * @returns true for a look refusal.
 */
export function isBrandLookError(err: unknown): err is BrandLookError {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === REFUSAL_CODE;
}

/**
 * @description Require a plain object holding exactly `keys` — no more, no fewer.
 * @param value - the candidate.
 * @param keys - the fields it must hold.
 * @param label - how the refusal names it.
 * @returns the value as a record.
 * @throws BrandLookError when it is not a plain object or its fields differ.
 */
export function lookRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const proto = value !== null && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  if (Array.isArray(value) || (proto !== Object.prototype && proto !== null)) {
    throw new BrandLookError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new BrandLookError(`${label} has an unsupported field`);
  const missing = keys.find((key) => !Object.prototype.hasOwnProperty.call(record, key));
  if (missing !== undefined) throw new BrandLookError(`${label} is missing "${missing}"`);
  return record;
}

/**
 * @description Read a six-digit hex color as bare uppercase hex — the form pptxgenjs, docx and
 * exceljs write. A name, a short form, a function or any string that could break out of an XML
 * attribute is refused, which is what keeps a look's colors out of the file's structure.
 * @param value - the candidate color.
 * @param label - how the refusal names it.
 * @param allowHash - true for brand input ('#7d2ae8' or '7d2ae8'); false for a built look.
 * @returns 'RRGGBB'.
 * @throws BrandLookError when it is not six hex digits.
 */
export function lookHex(value: unknown, label: string, allowHash: boolean): string {
  const shape = allowHash ? /^#?[0-9A-Fa-f]{6}$/ : /^[0-9A-Fa-f]{6}$/;
  if (typeof value !== 'string' || !shape.test(value)) throw new BrandLookError(`${label} must be a six-digit hex color`);
  return value.replace('#', '').toUpperCase();
}

/**
 * @description Require one of the Office-safe faces, spelled exactly as listed.
 * @param value - the candidate face.
 * @param label - how the refusal names it.
 * @returns the face.
 * @throws BrandLookError for any other face.
 */
export function lookFace(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OFFICE_SAFE_FONTS.includes(value)) {
    throw new BrandLookError(`${label} must be one of the Office fonts (${OFFICE_SAFE_FONTS.join(', ')})`);
  }
  return value;
}

/**
 * @description Require one line of display text within a length bound.
 * @param value - the candidate text.
 * @param max - the longest it may be.
 * @param label - how the refusal names it.
 * @returns the text.
 * @throws BrandLookError for a non-string, an over-long string or a control character.
 */
export function lookText(value: unknown, max: number, label: string): string {
  const control = (text: string) => [...text].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
  if (typeof value !== 'string' || value.length > max || control(value)) {
    throw new BrandLookError(`${label} must be one line of at most ${max} characters`);
  }
  return value;
}
