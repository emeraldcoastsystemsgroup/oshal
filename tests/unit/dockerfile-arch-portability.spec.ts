/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the arm64 build (a source install on an arm64 Linux host died in the first stage). Pins the four defects: `ARG TARGETARCH=amd64` overrode BuildKit's own value; yq, kubectl and argocd URLs were hard-coded amd64; the gcompat confinement step hard-coded the x86-64 loader. The image-boundary companion is in Dockerfile.oshal itself: each downloaded CLI runs its version command inside its layer, so a wrong-architecture binary fails the BUILD (verified by an arm64 build of this change).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOCKERFILE = readFileSync(join(process.cwd(), 'Dockerfile.oshal'), 'utf8');
/** Instruction lines only (comments carry history that names the old URLs). */
const CODE = DOCKERFILE.split('\n').filter((l) => !/^\s*#/.test(l));

describe('Dockerfile.oshal builds for the host architecture', () => {
  it('never gives TARGETARCH a default (a default masks the value BuildKit supplies)', () => {
    const decls = CODE.filter((l) => /^\s*ARG\s+TARGETARCH\b/.test(l));
    expect(decls.length).toBeGreaterThan(0);
    for (const d of decls) expect(d.trim()).toBe('ARG TARGETARCH');
  });

  it('has no hard-coded amd64/x86-64 download outside an explicit per-architecture choice', () => {
    const archSpecific = CODE.filter((l) => /(linux[/_-]amd64|_amd64\b|linux-x64|x86_64-linux|ld-linux-x86-64)/.test(l));
    for (const line of archSpecific) {
      const allowed = /^\s*ARG\s+AGY_AMD64_/.test(line)          // paired with AGY_ARM64_* and chosen by case
        || /^\s*amd64\)/.test(line)                              // the antigravity case arm
        || /x86_64\)/.test(line)                                 // the gcompat case arm
        || /for alias in .*ld-linux-x86-64\.so\.2/.test(line);   // the "no alias survived" assertion
      expect(allowed, `architecture-specific line outside a per-arch choice: ${line.trim()}`).toBe(true);
    }
  });

  it('selects yq, kubectl and argocd by TARGETARCH and proves each one runs in its layer', () => {
    expect(DOCKERFILE).toMatch(/yq_linux_\$\{TARGETARCH:-amd64\}[^\n]*\n[^\n]*yq --version/);
    expect(DOCKERFILE).toMatch(/bin\/linux\/\$\{TARGETARCH:-amd64\}\/kubectl[^\n]*\n[^\n]*kubectl version --client/);
    expect(DOCKERFILE).toMatch(/argocd-linux-\$\{TARGETARCH:-amd64\}[^\n]*\n[^\n]*argocd version --client/);
  });

  it('confines gcompat per architecture and keeps the alias-removal assertion', () => {
    expect(DOCKERFILE).toContain('arch="$(apk --print-arch)"');
    expect(DOCKERFILE).toContain('aarch64) test -e /lib/ld-linux-aarch64.so.1 ;;');
    expect(DOCKERFILE).toContain('Unsupported gcompat architecture');
    expect(DOCKERFILE).toMatch(/glibc alias \/lib\/\$alias survived/);
  });
});
