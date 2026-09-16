#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The registry install is the DEFAULT install, and nothing told anyone when the image behind it had stopped moving. Publishing to GHCR happens only inside the manual-only CI workflow, so `latest` rots silently: on 2026-09-16 a remote box installed with the documented one-liner and came up on a 2026-07-26 image — 983 commits and 5,057 files behind main. It had no App Loader (that page first shipped 2026-09-09) and no install step in its wizard (2026-09-11), so the operator on it reported missing FEATURES rather than a stale image, and the diagnosis cost a day. This module is the check that would have said so in one line at pull time. Verdict logic is pure and unit-tested; the CLI is a thin wrapper so both installers share one rule instead of each growing their own date arithmetic.
 */

'use strict';

/** Default: an image this far behind the current code is worth a warning. */
const DEFAULT_WARN_DAYS = 7;
/** Default: an image this far behind is refused unless the caller overrides. */
const DEFAULT_REFUSE_DAYS = 30;
/** The repository the published image is built from. */
const DEFAULT_REPO = 'emeraldcoastsystemsgroup/oshal';

/**
 * @description Parse an ISO-8601 timestamp into epoch ms, tolerating the absent/garbage
 * values the callers genuinely produce — `docker image inspect` on a missing label emits an
 * empty string, and an unreachable API yields undefined. Returning null rather than NaN keeps
 * every caller on one explicit "we could not tell" branch.
 * @param value - candidate timestamp
 * @returns epoch milliseconds, or null when the value is not a usable timestamp
 */
function parseTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @description Classify how far a pulled image lags the repository it is built from.
 *
 * Age is measured as **how much code the image is missing** (head commit date minus image
 * build date), NOT as wall-clock age. A repository that has not changed in two months should
 * not scold anyone for running a two-month-old image of it; an image built an hour before a
 * 900-commit day is the one worth flagging. An exact commit match short-circuits to current,
 * so a correctly-published image is never questioned on dates.
 *
 * Fails OPEN on missing inputs and CLOSED on a confirmed lag: being unable to check (offline,
 * air-gapped, rate-limited) must never block an install, while a measured 52-day gap should.
 * @param input - image and repository facts; `now` is injectable so the guard is deterministic
 * @returns verdict (`current` | `warn` | `refuse` | `unknown`), the measured lag, and the
 *          operator-facing message
 */
function classifyImageFreshness(input) {
  const {
    imageCreated, imageCommit, headCommit, headCommitDate,
    warnDays = DEFAULT_WARN_DAYS, refuseDays = DEFAULT_REFUSE_DAYS,
  } = input || {};

  const built = parseTimestamp(imageCreated);
  const head = parseTimestamp(headCommitDate);
  if (built === null || head === null) {
    return { verdict: 'unknown', behindDays: null, message: 'image freshness could not be checked (no build date or no network) — continuing' };
  }
  if (imageCommit && headCommit && imageCommit === headCommit) {
    return { verdict: 'current', behindDays: 0, message: 'image matches the current commit' };
  }

  const behindDays = Math.max(0, Math.floor((head - built) / 86400000));
  if (behindDays > refuseDays) {
    return { verdict: 'refuse', behindDays, message: staleMessage(behindDays, imageCommit, true) };
  }
  if (behindDays > warnDays) {
    return { verdict: 'warn', behindDays, message: staleMessage(behindDays, imageCommit, false) };
  }
  return { verdict: 'current', behindDays, message: `image is current (${behindDays}d behind the tip)` };
}

/**
 * @description Build the operator-facing explanation for a lagging image. It names the gap and
 * both ways out, because the failure this exists for was diagnosed as missing features rather
 * than as an old image — the message has to make the real cause impossible to misread.
 * @param behindDays - measured lag in days
 * @param imageCommit - the image's recorded source commit, when it carries one
 * @param refusing - whether the installer is about to stop
 * @returns the multi-line message
 */
function staleMessage(behindDays, imageCommit, refusing) {
  const head = refusing
    ? `REFUSING: the published image is ${behindDays} days behind this repository.`
    : `WARNING: the published image is ${behindDays} days behind this repository.`;
  return [
    head,
    imageCommit ? `  image was built from commit ${String(imageCommit).slice(0, 12)}` : '  image carries no source-commit label',
    '  Features added since then are simply ABSENT from it — not broken, not misconfigured.',
    '  Fix it one of two ways:',
    '    * publish a current image (Actions -> CI -> Run workflow on main), then re-run this installer; or',
    '    * install from source instead, which builds the current code:  --mode 2   (-Mode 2 on Windows)',
    refusing ? '  To install the old image anyway: --allow-stale-image   (-AllowStaleImage on Windows)' : '',
  ].filter(Boolean).join('\n');
}

/**
 * @description Read the tip commit of a branch from the public GitHub API. Any failure —
 * offline, rate-limited, private repo, DNS — resolves to nulls so the caller reports
 * `unknown` and continues; an install must not depend on reaching github.com.
 * @param repo - `owner/name`
 * @param branch - branch to read
 * @returns the tip commit sha and its committer date, or nulls
 */
async function fetchHead(repo, branch) {
  const empty = { headCommit: null, headCommitDate: null };
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/commits/${branch}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'oshal-installer' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return empty;
    const body = await res.json();
    return { headCommit: body?.sha || null, headCommitDate: body?.commit?.committer?.date || null };
  } catch {
    return empty;
  }
}

/**
 * @description CLI entry: classify the image the installer just pulled and exit 3 when it is
 * too far behind to install silently. Every other verdict exits 0 — this gate reports, it does
 * not own the decision, and the installer's override flag is honoured by the installer.
 * @param argv - raw process arguments
 * @returns process exit code
 */
async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1]; i += 1; }
  }
  const { headCommit, headCommitDate } = await fetchHead(args.repo || DEFAULT_REPO, args.branch || 'main');
  const result = classifyImageFreshness({
    imageCreated: args['image-created'], imageCommit: args['image-commit'], headCommit, headCommitDate,
    warnDays: Number(args['warn-days']) || DEFAULT_WARN_DAYS,
    refuseDays: Number(args['refuse-days']) || DEFAULT_REFUSE_DAYS,
  });
  if (result.verdict !== 'current') console.log(result.message);
  return result.verdict === 'refuse' ? 3 : 0;
}

module.exports = { classifyImageFreshness, parseTimestamp, DEFAULT_WARN_DAYS, DEFAULT_REFUSE_DAYS, DEFAULT_REPO };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch(() => process.exit(0));
}
