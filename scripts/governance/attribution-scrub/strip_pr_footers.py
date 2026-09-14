#!/usr/bin/env python3
"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Remove the "Generated with" model-tool footer and model co-author trailers from every pull-request description of a GitHub repository. Lists PRs through gh, re-reads each body immediately before patching so a concurrent edit is never clobbered, and re-reads after the PATCH to prove the footer is gone. Used on 233 PRs across three repos on 2026-09-12.

Strip model attribution lines from PR descriptions.

Usage:
    python strip_pr_footers.py <owner>/<repo> [--dry-run]

Requires gh authenticated as an account that can edit the repository's PRs.
"""
import json
import re
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8')

FOOT = re.compile(r'generated with \[?claude code|co-authored-by:.*anthropic|noreply@anthropic\.com', re.I)


def clean(body: str) -> str:
    """Drop every attribution line and collapse the blank run it leaves behind."""
    text = '\n'.join(line for line in body.splitlines() if not FOOT.search(line))
    return re.sub(r'\n{3,}', '\n\n', text).rstrip()


def gh(*args, stdin=None):
    """Run `gh api ...` and return stdout; raise with the API error text on failure."""
    r = subprocess.run(['gh', 'api', *args], capture_output=True, input=stdin, encoding='utf-8')
    if r.returncode:
        raise RuntimeError(r.stderr.strip()[:300])
    return r.stdout


def attributed_prs(full):
    """Numbers of every PR (any state) whose current body carries an attribution line."""
    out = gh('--paginate', f'repos/{full}/pulls?state=all&per_page=100', '--jq', '.[] | {number, body}')
    numbers = []
    for line in out.splitlines():
        d = json.loads(line)
        if any(FOOT.search(x) for x in (d.get('body') or '').splitlines()):
            numbers.append(d['number'])
    return numbers


def main():
    full, dry = sys.argv[1], '--dry-run' in sys.argv
    numbers = attributed_prs(full)
    edited, failed = 0, []
    for n in numbers:
        try:
            body = json.loads(gh(f'repos/{full}/pulls/{n}')).get('body') or ''
            new = clean(body)
            if new == body.rstrip():
                continue
            if not dry:
                gh('-X', 'PATCH', f'repos/{full}/pulls/{n}', '--input', '-', stdin=json.dumps({'body': new}))
                after = json.loads(gh(f'repos/{full}/pulls/{n}')).get('body') or ''
                if any(FOOT.search(x) for x in after.splitlines()):
                    failed.append((n, 'attribution still present after PATCH'))
                    continue
            edited += 1
        except Exception as e:  # report every failure; never skip silently
            failed.append((n, str(e)))
    print(f'[{full}] PRs with attribution: {len(numbers)}; edited: {edited}; failed: {len(failed)}'
          + (' (dry-run)' if dry else ''))
    for n, why in failed[:10]:
        print(f'   FAILED #{n}: {why}')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
