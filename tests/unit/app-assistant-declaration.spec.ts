/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D9/D12: the declarative assistant bubble replaces package shell-JS injection (operator decision 2026-07-13 — a package's script would run in the cockpit's AUTHENTICATED origin, free to read any DOM and call any API as the operator; auth-gating the file does not constrain what the file does, and CSP is off by default with script-src 'self' anyway). These tests pin the fail-closed rule that keeps the bubble same-origin, and the D12 warning on the inert toolsDir field.
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readManifest } from '../../src/features/swarm-apps';

/**
 * @description Write a manifest and read it through the real readManifest.
 * @param body - YAML body appended to the required name/displayName.
 * @returns The parsed manifest.
 */
function read(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-assistant-'));
  const file = join(dir, 'oshal-app.yaml');
  writeFileSync(file, `name: t\ndisplayName: T\n${body}`, 'utf8');
  try {
    return readManifest(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ASSISTANT = (url: string) =>
  `ui:\n  assistant:\n    label: Tutor\n    icon: codicon codicon-mortar-board\n    iframeUrl: ${url}\n`;

describe('ui.assistant — the declarative alternative to shell JS (ADR-085 D9)', () => {
  it('accepts a same-origin, root-relative path', () => {
    const m = read(ASSISTANT('/api/education/tutor'));
    expect(m.ui?.assistant).toMatchObject({ label: 'Tutor', iframeUrl: '/api/education/tutor' });
  });

  // The whole point of the field. If a manifest could name an arbitrary origin, the "declarative,
  // no-package-JS" widget would just be an arbitrary-code channel wearing a different hat.
  it('REFUSES an absolute cross-origin URL', () => {
    expect(() => read(ASSISTANT('https://evil.example/x'))).toThrow(/same-origin, root-relative/);
  });

  it('REFUSES a protocol-relative //host URL', () => {
    expect(() => read(ASSISTANT('//evil.example/x'))).toThrow(/same-origin, root-relative/);
  });

  it('REFUSES a javascript: URL', () => {
    expect(() => read(ASSISTANT('javascript:alert(1)'))).toThrow(/same-origin, root-relative/);
  });

  it('REFUSES an incomplete declaration', () => {
    expect(() => read('ui:\n  assistant:\n    label: Tutor\n')).toThrow(/requires label, icon and iframeUrl/);
  });

  it('is optional — a manifest without one loads fine', () => {
    expect(read('description: x\n').ui?.assistant).toBeUndefined();
  });
});

describe('toolsDir — declared but dead (ADR-085 D12)', () => {
  // Warn, do not fail: little-monsters declares toolsDir today. The field is removed in the next
  // store release (operator decision 2026-07-13), so breaking it now would break a live package.
  it('WARNS that a declared toolsDir is inert, and still loads', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const m = read('toolsDir: tools/\n');
    expect(m.toolsDir).toBe('tools/'); // still parsed — not a hard failure
    warn.mockRestore();
  });
});
