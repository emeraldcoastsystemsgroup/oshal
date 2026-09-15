/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Entra/local identity bridge decision record: the ADR exists with Context/Decision/Consequences and an as-built status, is indexed, ADR-126 points at it, the operator guide links back and no longer claims no ADR exists, and every flag, table and refusal code the record names is still present in the shipped middleware it describes. The composition shipped 2026-08-17 with its design intent living only in two change-log headers and .env.example.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..');
const ADR_DIR = join(REPO_ROOT, 'docs', 'adr');
const GUIDE_PATH = join(REPO_ROOT, 'docs', 'security', 'entra-local-hybrid.md');
const ADR_126 = '126-multi-provider-oidc-login.md';

/** The middleware pair the record describes; the ADR is only as-built while both still exist. */
const SHIPPED_SOURCES = [
  join(REPO_ROOT, 'src', 'app', 'middleware', 'entra-local-identity-bridge.ts'),
  join(REPO_ROOT, 'src', 'app', 'middleware', 'application-auth.ts'),
];

/**
 * Identifiers the decision turns on. Each must appear in the ADR *and* in the shipped
 * middleware, so renaming a flag, the link table or a refusal code in code goes red here
 * instead of leaving the record quietly describing a deployment that no longer exists.
 */
const AS_BUILT_IDENTIFIERS = [
  'ENTRA_LOCAL_AUTH_HYBRID',
  'ENTRA_LOCAL_IDENTITY_BRIDGE',
  'ENTRA_LOCAL_IDENTITY_EMAILS',
  'MICROSOFT_TENANT_ID',
  'oshal_external_identity_links',
  'identity_not_provisioned',
  'identity_bridge_unavailable',
];

const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/**
 * @description Reads the body of a `##` section, up to the next heading of the same or higher level.
 * @param text - The markdown source.
 * @param title - Heading text, matched case-insensitively at the start of the heading.
 * @returns The section body, or null when there is no such section.
 */
function section(text: string, title: string): string | null {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${title}\\b`, 'i').test(line));
  if (start < 0) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

/**
 * @description Reads the ADR's status line: the `Status:` metadata line plus its continuations.
 * @param text - The markdown source.
 * @returns The status text, or '' when the record carries none.
 */
function statusLine(text: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => /^\s*(?:\*\*)?Status(?:\*\*)?\s*:/i.test(line));
  if (at < 0) return '';
  const out = [lines[at]];
  for (const line of lines.slice(at + 1)) {
    if (!line.trim() || /^#/.test(line) || /^\s*(?:\*\*)?[A-Z][\w /-]{1,40}(?:\*\*)?\s*:/.test(line)) break;
    out.push(line);
  }
  return out.join('\n');
}

/**
 * @description Collects the relative link targets of a markdown file, ignoring anchors and URLs.
 * @param text - The markdown source.
 * @returns One repo-relative-resolved absolute path per link.
 */
function relativeLinkTargets(text: string, fromFile: string): string[] {
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^(?:https?:|mailto:|#)/.test(target))
    .map((target) => resolve(dirname(fromFile), target.split('#')[0]));
}

const bridgeAdrFiles = readdirSync(ADR_DIR).filter((f) => /^\d{3}-entra-local-identity-bridge\.md$/.test(f));

describe('the Entra/local identity bridge has a decision record that matches what shipped', () => {
  it('exactly one NNN-entra-local-identity-bridge.md exists in docs/adr', () => {
    expect(bridgeAdrFiles).toHaveLength(1);
  });

  it('records Context, Decision and Consequences', () => {
    const text = read(join(ADR_DIR, bridgeAdrFiles[0]));
    for (const title of ['Context', 'Decision', 'Consequences']) {
      expect(section(text, title)?.trim() ?? '', `## ${title}`).not.toBe('');
    }
  });

  it('carries an as-built status line, not a proposal', () => {
    const status = statusLine(read(join(ADR_DIR, bridgeAdrFiles[0])));
    expect(status).not.toBe('');
    expect(status).toMatch(/accepted/i);
    expect(status).toMatch(/as-built|built|shipped/i);
    expect(status).not.toMatch(/\bproposed\b|\bsupersed/i);
  });

  it('names the three decisions the operator guide alone does not carry', () => {
    const text = read(join(ADR_DIR, bridgeAdrFiles[0])).toLowerCase();
    // link-once with no unlink/expiry rail, the allowlist gating only the first link,
    // and an invited account accepted on link with its password invite left intact.
    expect(text).toMatch(/link[- ]once/);
    expect(text).toMatch(/unlink/);
    expect(text).toMatch(/first[- ]link|first link|first-time link/);
    expect(text).toMatch(/invite/);
  });

  it('every identifier it names is still present in the middleware it describes', () => {
    const adr = read(join(ADR_DIR, bridgeAdrFiles[0]));
    const shipped = SHIPPED_SOURCES.map((path) => {
      expect(existsSync(path), path).toBe(true);
      return read(path);
    }).join('\n');
    const missingFromAdr = AS_BUILT_IDENTIFIERS.filter((id) => !adr.includes(id));
    const missingFromSource = AS_BUILT_IDENTIFIERS.filter((id) => !shipped.includes(id));
    expect(missingFromAdr).toEqual([]);
    expect(missingFromSource).toEqual([]);
  });

  it('every relative link in the record resolves on disk', () => {
    const file = join(ADR_DIR, bridgeAdrFiles[0]);
    const dead = relativeLinkTargets(read(file), file).filter((target) => !existsSync(target));
    expect(dead).toEqual([]);
  });

  it('is indexed in docs/adr/README.md', () => {
    const rows = read(join(ADR_DIR, 'README.md'))
      .split('\n')
      .filter((line) => /^\|\s*\[/.test(line) && line.includes(`(${bridgeAdrFiles[0]})`));
    expect(rows).toHaveLength(1);
  });

  it('ADR-126, which scoped LOCAL_AUTH out, points at it', () => {
    expect(read(join(ADR_DIR, ADR_126))).toContain(`(${bridgeAdrFiles[0]})`);
  });

  it('the operator guide links it back and no longer says no ADR exists', () => {
    const guide = read(GUIDE_PATH);
    expect(guide).toContain(`../adr/${bridgeAdrFiles[0]}`);
    expect(guide).not.toMatch(/no dedicated adr exists/i);
  });

  it('the readers above are not vacuous', () => {
    expect(section('# t\n\n## Context\nbody\n\n## Decision\nd\n', 'Context')?.trim()).toBe('body');
    expect(section('# t\n\n## Decision\nd\n', 'Consequences')).toBeNull();
    expect(statusLine('# t\n\nDate: 2026-01-01\nStatus: **Accepted — as-built.**\n\n## Context\n')).toContain('Accepted');
    expect(statusLine('# t\n\n## Context\n')).toBe('');
    expect(relativeLinkTargets('[a](https://x/y) [b](#z) [c](../p/q.md)', join(ADR_DIR, 'x.md')))
      .toEqual([resolve(ADR_DIR, '..', 'p', 'q.md')]);
  });
});
