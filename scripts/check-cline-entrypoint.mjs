#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Image/container probe for the Cline fallback entrypoint. The JS ProviderFailoverProvider hands every Codex refusal to cline-cli, and on 2026-09-17 that fallback died on every ticket with `spawnSync /usr/local/lib/node_modules/cline/bin/.cline ENOENT` - a file that EXISTS. cline 3.x ships a Bun-compiled glibc executable and the musl base had no /lib64/ld-linux-x86-64.so.2, so the kernel reported the missing interpreter as ENOENT on the binary. No gate saw it: the image built, the stack was healthy, chat answered through the ADR-127 hosted retry, and only a ticket that needed the fallback found out. This probe runs the REAL launcher (`cline --version`) inside the artifact that ships - `--image <tag>` before any container is touched, or `--container <name>` on a running one - and names the failure shape it finds, so scripts/oshal-deploy.sh refuses an image whose fallback brain cannot start.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** @description Where the cline launcher caches the platform executable it spawns. */
export const CLINE_CACHED_BINARY = '/usr/local/lib/node_modules/cline/bin/.cline';
/** @description The glibc program interpreter the Bun-compiled cline executable is linked against. */
export const GLIBC_LOADER = '/lib64/ld-linux-x86-64.so.2';
/** @description glibc aliases gcompat drops into musl's default search path; their presence is the unconfined shape. */
export const GLIBC_ALIASES = ['/lib/libc.so.6', '/lib/libm.so.6', '/lib/libpthread.so.0'];

/**
 * @description The one-line shell body executed inside the artifact. It is a flat `;` chain on
 * purpose: no heredoc, no here-string, nothing a classic builder or a Windows-hosted docker.exe
 * could mangle. It never exits non-zero itself - the verdict is decided from the report on this
 * side, so a probe that could not run is distinguishable from a probe that ran and found a fault.
 * @returns {string} A POSIX sh script safe to pass as one `sh -c` argument.
 */
export function buildProbeScript() {
  const parts = [
    `out=$(cline --version 2>&1); rc=$?`,
    `printf 'CLINE_PROBE_RC=%s\\n' "$rc"`,
    `printf 'CLINE_PROBE_OUT_BEGIN\\n%s\\nCLINE_PROBE_OUT_END\\n' "$out"`,
    `[ -e "${CLINE_CACHED_BINARY}" ] && printf 'CLINE_PROBE_BIN=present\\n' || printf 'CLINE_PROBE_BIN=missing\\n'`,
    `[ -e "${GLIBC_LOADER}" ] && printf 'CLINE_PROBE_LOADER=present\\n' || printf 'CLINE_PROBE_LOADER=missing\\n'`,
    `aliases=""; for a in ${GLIBC_ALIASES.join(' ')}; do [ -e "$a" ] && aliases="$aliases $a"; done`,
    `printf 'CLINE_PROBE_ALIASES=%s\\n' "$aliases"`,
    `printf 'CLINE_PROBE_LIBC=%s\\n' "$(ls /lib/ld-musl-* 2>/dev/null | head -n1)"`,
  ];
  return parts.join('; ');
}

/**
 * @description Parses the marker lines the probe script prints into a structured report.
 * @param {string} raw Combined stdout of the probe run.
 * @returns {{rc: number|null, out: string, bin: string, loader: string, aliases: string[], libc: string}}
 */
export function parseProbeReport(raw) {
  const text = String(raw ?? '').replace(/\r\n/g, '\n');
  const field = (name) => {
    const m = text.match(new RegExp(`^${name}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  };
  const outMatch = text.match(/CLINE_PROBE_OUT_BEGIN\n([\s\S]*?)\nCLINE_PROBE_OUT_END/);
  const rcText = field('CLINE_PROBE_RC');
  return {
    rc: rcText === '' ? null : Number(rcText),
    out: outMatch ? outMatch[1].trim() : '',
    bin: field('CLINE_PROBE_BIN'),
    loader: field('CLINE_PROBE_LOADER'),
    aliases: field('CLINE_PROBE_ALIASES').split(/\s+/).filter(Boolean),
    libc: field('CLINE_PROBE_LIBC'),
  };
}

/**
 * @description Turns a probe report into a verdict. Every failure names the shape it found, because
 * `Cline CLI exited with code 1` told nobody anything for weeks. `requireConfined` is the image
 * contract (Dockerfile.oshal removes the glibc aliases); a hot-fixed running container is allowed
 * to be unconfined, so callers pass false for `--container`.
 * @param {ReturnType<typeof parseProbeReport>} report Parsed probe output.
 * @param {{requireConfined?: boolean}} [opts] Verdict options.
 * @returns {{ok: boolean, code: string, message: string}} The verdict and its reason.
 */
export function classifyProbe(report, opts = {}) {
  const requireConfined = opts.requireConfined !== false;
  const version = (report.out.match(/^(\d+\.\d+\.\d+\S*)\s*$/m) || [])[1] || '';
  const isMusl = report.libc.includes('ld-musl');

  if (report.rc === null) {
    return { ok: false, code: 'probe-did-not-run', message: 'the probe produced no report: docker could not run the artifact or `sh` is missing in it' };
  }
  if (report.rc === 0 && version) {
    if (requireConfined && report.aliases.length > 0) {
      return {
        ok: false,
        code: 'unconfined-glibc-aliases',
        message: `cline ${version} starts, but glibc aliases are in musl's default search path (${report.aliases.join(', ')}): a node process can now dlopen glibc-only native addons it must refuse - the Dockerfile.oshal contract removes them`,
      };
    }
    const shape = report.aliases.length > 0 ? 'unconfined gcompat' : (report.loader === 'present' ? 'confined gcompat loader' : 'native');
    return { ok: true, code: 'starts', message: `cline ${version} starts (${shape})` };
  }
  if (/ENOENT/.test(report.out) && report.bin === 'present' && report.loader === 'missing') {
    return {
      ok: false,
      code: 'glibc-binary-no-loader',
      message: `the launcher reports ENOENT on ${CLINE_CACHED_BINARY}, which EXISTS: it is a glibc executable and ${GLIBC_LOADER} is absent${isMusl ? ' on this musl base' : ''} - the kernel is reporting the missing program interpreter (fix: the confined gcompat layer in Dockerfile.oshal)`,
    };
  }
  if (/ENOENT/.test(report.out) && report.bin === 'missing') {
    return { ok: false, code: 'binary-missing', message: `${CLINE_CACHED_BINARY} is not present and the launcher found no platform package: the npm install did not cache a cline executable` };
  }
  if (/Error relocating|symbol not found/.test(report.out)) {
    return { ok: false, code: 'glibc-symbols-unresolved', message: `the loader is present but glibc symbols are unresolved: ${firstLine(report.out)}` };
  }
  return { ok: false, code: 'exit-nonzero', message: `cline --version exited ${report.rc}${version ? '' : ' without printing a version'}: ${firstLine(report.out) || '(no output)'}` };
}

/**
 * @description The first non-empty, non-advisory line of the launcher output, for a one-line reason.
 * @param {string} out Launcher output.
 * @returns {string} A single line or the empty string.
 */
function firstLine(out) {
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/cannot read the OS trust store/.test(l))[0] || '';
}

/**
 * @description Runs the probe script inside an image (`docker run`) or a running container
 * (`docker exec`) and returns the raw report text. Throws when docker itself cannot start the
 * artifact, so the caller can distinguish "no verdict" from "verdict: broken".
 * @param {{image?: string, container?: string, runner?: (file: string, args: string[]) => string}} target Where to probe.
 * @returns {string} Combined probe output.
 */
export function runProbe(target) {
  const runner = target.runner || ((file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }));
  const script = buildProbeScript();
  if (target.container) {
    return runner('docker', ['exec', target.container, 'sh', '-c', script]);
  }
  if (target.image) {
    return runner('docker', ['run', '--rm', '--memory', '256m', '--entrypoint', 'sh', target.image, '-c', script]);
  }
  throw new Error('runProbe needs an image or a container');
}

/**
 * @description CLI entry: `--image <tag>` or `--container <name>`, optional `--quiet`.
 * Exit 0 = the fallback entrypoint starts. Exit 1 = it does not (reason on stderr).
 * Exit 2 = usage error or docker could not run the artifact.
 * @param {string[]} argv Process arguments after the script path.
 * @returns {number} The process exit code.
 */
export function main(argv) {
  const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const image = flag('--image');
  const container = flag('--container');
  const quiet = argv.includes('--quiet');
  if ((!image && !container) || (image && container)) {
    process.stderr.write('usage: check-cline-entrypoint.mjs (--image <tag> | --container <name>) [--quiet]\n');
    return 2;
  }
  const where = image ? `image ${image}` : `container ${container}`;
  let raw;
  try {
    raw = runProbe({ image, container });
  } catch (err) {
    const detail = String(err?.stderr || err?.message || err).trim().split('\n').slice(-1)[0];
    process.stderr.write(`cline entrypoint probe: could not run the probe in ${where}: ${detail}\n`);
    return 2;
  }
  const verdict = classifyProbe(parseProbeReport(raw), { requireConfined: Boolean(image) });
  const line = `cline entrypoint probe [${where}] ${verdict.ok ? 'PASS' : 'FAIL'} (${verdict.code}): ${verdict.message}\n`;
  if (verdict.ok) { if (!quiet) process.stdout.write(line); return 0; }
  process.stderr.write(line);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
