/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Per-app desktop launch helpers (electron-free so unit specs can import them): --app / --make-shortcuts argv parsing, cockpit app-name sanitizing, per-app cockpit path building, and shortcut display-name prettifying. Consumed by main.ts (launch + second-instance forwarding + shortcut writer) and cockpit-window.ts (per-app windows).
 */

/**
 * @description Validates a cockpit app/manifest name from an untrusted source (CLI args,
 * a second-instance argv). Manifest names are lowercase kebab identifiers; anything else
 * (path fragments, query injections, empty values) resolves to undefined so a bad flag
 * can never steer the window to an unintended URL.
 *
 * @param value - Raw candidate app name
 * @returns The normalized (lowercased) name when valid; otherwise undefined
 */
export function sanitizeCockpitAppName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

/**
 * @description Builds the cockpit path for a named app. The `?app=` query is the
 * platform's whole app identity (URL-as-truth), so this is the only thing that
 * distinguishes one desktop "application" from another — same shell, different manifest.
 *
 * @param appName - A sanitized cockpit app name
 * @returns The cockpit path carrying the app query
 */
export function buildCockpitAppPath(appName: string): string {
  return `/cockpit/?app=${encodeURIComponent(appName)}`;
}

/**
 * @description Extracts the `--app=<name>` launch flag from an argv list (last one wins,
 * matching how Chromium-style flags override). Used both for the first launch and for
 * argv forwarded by a second instance to the one that holds the single-instance lock.
 *
 * @param argv - Process argv (or forwarded second-instance argv)
 * @returns The sanitized app name when present and valid; otherwise undefined
 */
export function parseLaunchAppArg(argv: readonly string[]): string | undefined {
  let found: string | undefined;
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith('--app=')) {
      const candidate = sanitizeCockpitAppName(arg.slice('--app='.length));
      if (candidate) {
        found = candidate;
      }
    }
  }
  return found;
}

/**
 * @description Extracts the `--make-shortcuts=<a,b,c>` flag: a comma-separated list of
 * app names to write desktop shortcuts for. Invalid entries are dropped (not fatal) so
 * one typo doesn't abort the batch; duplicates collapse.
 *
 * @param argv - Process argv
 * @returns Sanitized, de-duplicated app names; empty array when the flag is absent
 */
export function parseMakeShortcutsArg(argv: readonly string[]): string[] {
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith('--make-shortcuts=')) {
      const names = arg.slice('--make-shortcuts='.length).split(',')
        .map((name) => sanitizeCockpitAppName(name))
        .filter((name): name is string => Boolean(name));
      return Array.from(new Set(names));
    }
  }
  return [];
}

/**
 * @description Turns a kebab-case app name into a human shortcut title
 * (e.g. "intelligent-trades" → "Intelligent Trades", "dnd" → "Dnd" — short names the
 * caller wants styled differently can pass an explicit title instead).
 *
 * @param appName - A sanitized cockpit app name
 * @returns Title-cased display name for window titles and .lnk filenames
 */
export function prettifyAppTitle(appName: string): string {
  return appName
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
