/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | New. One definition of the config-response redaction placeholder and the two operations each config partition needs around it: strip a stored placeholder on read so a corrupted value reads as absent (warned once per store per process), and resolve a posted placeholder against the SAME partition's stored value (keep what is stored at exactly that path, or drop the key when nothing is stored there).
 */

/**
 * @description The literal every config GET writes in place of a credential-bearing value. A page
 * that saves what it loaded posts this string back, so a save handler must read it as "keep what is
 * stored here", never as a new value.
 */
export const REDACTED_CONFIG_PLACEHOLDER = '[REDACTED]';

/** Marks a posted placeholder that has nothing stored behind it; the key is omitted from the save. */
const DROPPED = Symbol('dropped-redacted-config-placeholder');

/** Stores whose current placeholder paths were already reported at warn level in this process. */
const reportedPlaceholderStores = new Set<string>();

/**
 * @description Whether a read that removed stored placeholders should log at warn level. True once per
 * process for each distinct store and set of paths, so a corrupted value that remains until the next save
 * does not repeat the warning on every read (readers call these loaders on many requests).
 * @param store - Identifies the store (its file path)
 * @param removedPaths - The placeholder paths the read removed
 * @returns True the first time this store reports these paths; false afterwards
 */
export function shouldWarnRedactedPlaceholders(store: string, removedPaths: readonly string[]): boolean {
  const key = `${store}\u0000${removedPaths.join(',')}`;
  if (reportedPlaceholderStores.has(key)) return false;
  reportedPlaceholderStores.add(key);
  return true;
}

/**
 * @description Result of removing stored placeholders from a config document.
 */
export interface StrippedConfigPlaceholders<T> {
  /** Fresh copy of the document with every placeholder leaf removed. */
  value: T;
  /** Dotted paths of the removed leaves (paths only, never values). */
  removedPaths: string[];
}

/**
 * @description Result of resolving the placeholders in one posted partition.
 */
export interface ResolvedConfigPlaceholders {
  /** Posted document with each placeholder replaced by the stored value, or omitted. */
  value: Record<string, unknown>;
  /** Dotted paths whose stored value was kept. */
  restoredPaths: string[];
  /** Dotted paths that had nothing stored behind them and were omitted. */
  droppedPaths: string[];
}

/**
 * @description Whether a value is the response-redaction placeholder.
 * @param value - Any config value
 * @returns True only for the exact placeholder literal
 */
export function isRedactedConfigPlaceholder(value: unknown): boolean {
  return value === REDACTED_CONFIG_PLACEHOLDER;
}

/**
 * @description Removes every leaf equal to the placeholder. A stored placeholder is the residue of an
 * earlier save that wrote a redacted response back; it never was the operator's value, so readers
 * must see the key as absent (and fall back to env/defaults) and the next save must not keep it.
 * @param value - Parsed config document
 * @returns A copy without placeholder leaves and the paths that were removed
 */
export function stripRedactedConfigPlaceholders<T>(value: T): StrippedConfigPlaceholders<T> {
  const removedPaths: string[] = [];
  return { value: stripNode(value, '', removedPaths) as T, removedPaths };
}

/**
 * @description Resolves the placeholders in one posted partition against that SAME partition's
 * stored document. A placeholder keeps the stored value at exactly its path; with nothing stored
 * there (or only a stored placeholder) the key is omitted, never rejected, because GET redacts by
 * key name whatever the value is. Every non-placeholder value passes through unchanged.
 * @param incoming - Posted partition (settings, secrets, MCP document or one service config)
 * @param stored - What that partition holds now, already read through its stripping loader
 * @returns The document to persist plus the restored and dropped paths
 */
export function resolveRedactedConfigPlaceholders(
  incoming: Record<string, unknown>,
  stored: unknown,
): ResolvedConfigPlaceholders {
  const restoredPaths: string[] = [];
  const droppedPaths: string[] = [];
  const value = resolveNode(incoming, stored, '', restoredPaths, droppedPaths) as Record<string, unknown>;
  return { value, restoredPaths, droppedPaths };
}

/**
 * @description Recursive worker for {@link stripRedactedConfigPlaceholders}.
 * @param value - Current node
 * @param nodePath - Dotted path of the node
 * @param removedPaths - Accumulator of removed leaf paths
 * @returns Copy of the node without placeholder leaves
 */
function stripNode(value: unknown, nodePath: string, removedPaths: string[]): unknown {
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    value.forEach((item, index) => {
      const itemPath = `${nodePath}[${index}]`;
      if (isRedactedConfigPlaceholder(item)) removedPaths.push(itemPath);
      else kept.push(stripNode(item, itemPath, removedPaths));
    });
    return kept;
  }
  if (isPlainRecord(value)) {
    const entries: Array<[string, unknown]> = [];
    for (const [key, item] of Object.entries(value)) {
      const itemPath = joinConfigPath(nodePath, key);
      if (isRedactedConfigPlaceholder(item)) removedPaths.push(itemPath);
      else entries.push([key, stripNode(item, itemPath, removedPaths)]);
    }
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * @description Recursive worker for {@link resolveRedactedConfigPlaceholders}. Arrays are matched by
 * index because GET preserves array order and length; objects by own key.
 * @param incoming - Posted node
 * @param stored - Stored node at the same path, or undefined
 * @param nodePath - Dotted path of the node
 * @param restoredPaths - Accumulator of restored paths
 * @param droppedPaths - Accumulator of dropped paths
 * @returns Resolved node, or the DROPPED marker
 */
function resolveNode(
  incoming: unknown,
  stored: unknown,
  nodePath: string,
  restoredPaths: string[],
  droppedPaths: string[],
): unknown {
  if (isRedactedConfigPlaceholder(incoming)) {
    if (stored === undefined || isRedactedConfigPlaceholder(stored)) {
      droppedPaths.push(nodePath);
      return DROPPED;
    }
    restoredPaths.push(nodePath);
    // A fresh copy, so the persisted document never aliases the merge base it was read from.
    return stripNode(stored, nodePath, []);
  }
  if (Array.isArray(incoming)) {
    const storedItems = Array.isArray(stored) ? stored : [];
    return incoming
      .map((item, index) => resolveNode(item, storedItems[index], `${nodePath}[${index}]`, restoredPaths, droppedPaths))
      .filter((item) => item !== DROPPED);
  }
  if (isPlainRecord(incoming)) {
    const storedRecord = isPlainRecord(stored) ? stored : {};
    const entries: Array<[string, unknown]> = [];
    for (const [key, item] of Object.entries(incoming)) {
      const storedItem = Object.prototype.hasOwnProperty.call(storedRecord, key) ? storedRecord[key] : undefined;
      const resolved = resolveNode(item, storedItem, joinConfigPath(nodePath, key), restoredPaths, droppedPaths);
      if (resolved !== DROPPED) entries.push([key, resolved]);
    }
    return Object.fromEntries(entries);
  }
  return incoming;
}

/**
 * @description Whether a value is a non-array object.
 * @param value - Candidate value
 * @returns True for plain JSON objects
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @description Appends one object key to a dotted config path.
 * @param parent - Parent path ('' at the document root)
 * @param key - Object key
 * @returns Joined path
 */
function joinConfigPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}
