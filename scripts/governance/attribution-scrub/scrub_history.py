#!/usr/bin/env python3
"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | Message-only history rewrite that strips model co-author trailers and "Generated with" model-tool footers from every branch and tag of a BARE clone. Rewrites only the attributed commits and their descendants, so untouched (signed) history keeps its SHAs; trees are never modified and the run refuses to report success unless every rewritten ref has an identical tree and zero attribution remains. Used for the 2026-09-12 scrub of oshal, oshal-applications and oshal-app-private (docs/runbooks/model-attribution-scrub.md).

Strip model attribution from commit messages on every ref of a bare clone.

Usage:
    python scrub_history.py <bare-repo-dir> [--dry-run]
    python scrub_history.py --self-test

Writes <bare-repo-dir>/../<name>.commit-map (old new per line) on success, which
repoint_local.py consumes. Requires git and git-filter-repo (Python package).
"""
import os
import re
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8')

# A trailer at a model vendor's no-reply address, and the markdown footer the harness appends.
# Both are anchored to full lines so prose that merely mentions the words is never touched.
TRAILER = re.compile(rb'^[ \t]*Co-Authored-By:[^\n]*<noreply@anthropic\.com>[ \t]*\r?\n?', re.I | re.M)
GENERATED = re.compile(rb'^[^\n]*Generated with \[Claude Code\]\([^)\n]*\)[ \t]*\r?\n?', re.I | re.M)


def clean_message(msg: bytes) -> bytes:
    """Return the message with attribution lines removed, or the identical bytes when clean."""
    if not (TRAILER.search(msg) or GENERATED.search(msg)):
        return msg
    out = TRAILER.sub(b'', msg)
    out = GENERATED.sub(b'', out)
    out = re.sub(rb'\n{3,}', b'\n\n', out)  # collapse blank runs the removal created
    return out.rstrip() + b'\n' if out.strip() else out


def git(repo, *args, binary=False):
    """Run git inside the bare clone and return stdout (text unless binary=True)."""
    r = subprocess.run(['git', *args], cwd=repo, capture_output=True, check=True)
    return r.stdout if binary else r.stdout.decode('utf-8', 'replace')


def load_graph(repo):
    """Return ({commit: [parents]}, {attributed commits}) over refs/heads and refs/tags."""
    raw = git(repo, 'log', '--all', '-z', '--format=%H%x1f%P%x1f%B', binary=True)
    parents, attributed = {}, set()
    for rec in raw.split(b'\0'):
        if not rec.strip():
            continue
        h, p, body = rec.split(b'\x1f', 2)
        h = h.decode()
        parents[h] = p.decode().split()
        if clean_message(body) != body:
            attributed.add(h)
    return parents, attributed


def rewrite_set(parents, attributed):
    """Attributed commits plus every descendant, and the boundary parents just outside it."""
    children = {}
    for c, ps in parents.items():
        for p in ps:
            children.setdefault(p, []).append(c)
    D, stack = set(attributed), list(attributed)
    while stack:
        c = stack.pop()
        for ch in children.get(c, []):
            if ch not in D:
                D.add(ch)
                stack.append(ch)
    boundary = sorted({p for c in D for p in parents[c] if p not in D})
    return D, boundary


def verify(repo, refs, cmap_path):
    """Return (attribution-left count, mismatches) after the rewrite; also persists the map."""
    left = git(repo, 'log', '--all', '-z', '--format=%H%x1f%B', binary=True)
    bad = [rec for rec in left.split(b'\0') if rec.strip()
           and clean_message(rec.split(b'\x1f', 1)[1]) != rec.split(b'\x1f', 1)[1]]
    cmap = dict(line.split() for line in open(cmap_path).read().splitlines()[1:])
    mismatches = []
    for sha, ref in refs:
        new = git(repo, 'rev-parse', ref).strip()
        if sha in cmap and cmap[sha] != new:
            mismatches.append((ref, 'ref not at mapped commit'))
        elif sha not in cmap and new != sha:
            mismatches.append((ref, 'untouched ref moved'))
        if git(repo, 'rev-parse', sha + '^{tree}') != git(repo, 'rev-parse', new + '^{tree}'):
            mismatches.append((ref, 'TREE CHANGED'))
    return len(bad), mismatches, cmap


def self_test():
    """Pin clean_message on the shapes the harness produces; exit non-zero on any drift."""
    addr = b'<noreply@' + b'anthropic.com>'
    foot = b'Generated with [Claude' + b' Code](https://example.invalid/x)'
    cases = [
        (b'fix: a\n\nbody\n\nCo-Authored-By: Some Model ' + addr + b'\n', b'fix: a\n\nbody\n'),
        (b'fix: b\n\nCo-authored-by: Some Model ' + addr + b'\nCo-authored-by: A Person <a@example.com>\n',
         b'fix: b\n\nCo-authored-by: A Person <a@example.com>\n'),
        (b'feat: c\n\nbody\n\n\xf0\x9f\xa4\x96 ' + foot + b'\n', b'feat: c\n\nbody\n'),
        (b'docs: mentions Co-Authored-By trailers and anthropic.com in prose\n', None),
    ]
    failures = 0
    for msg, want in cases:
        got = clean_message(msg)
        expected = msg if want is None else want
        if got != expected:
            failures += 1
            print('SELF-TEST FAIL', msg[:40], '->', got)
    print(f'self-test: {len(cases) - failures}/{len(cases)} passed')
    return 1 if failures else 0


def main():
    if '--self-test' in sys.argv:
        return self_test()
    repo = os.path.abspath(sys.argv[1])
    dry = '--dry-run' in sys.argv
    name = os.path.basename(repo)[:-4] if repo.endswith('.git') else os.path.basename(repo)
    parents, attributed = load_graph(repo)
    print(f'[{name}] commits reachable: {len(parents)}; attributed: {len(attributed)}')
    if not attributed:
        print(f'[{name}] nothing to do')
        return 0
    D, boundary = rewrite_set(parents, attributed)
    refs = [line.split() for line in git(repo, 'for-each-ref', '--format=%(objectname) %(refname)',
                                         'refs/heads', 'refs/tags').splitlines()]
    tips = [r for sha, r in refs if sha in D]
    print(f'[{name}] rewrite set: {len(D)} commits; boundary parents: {len(boundary)}; '
          f'refs rewritten: {len(tips)}; refs untouched: {len(refs) - len(tips)}')
    if dry:
        print('  tips:', ' '.join(tips))
        print('  boundary:', ' '.join(boundary))
        return 0
    os.chdir(repo)  # filter-repo operates on the PROCESS CWD - never run this from a working clone
    import git_filter_repo as fr  # noqa: E402  (imported late so --dry-run/--self-test need no install)
    argv = ['--force', '--partial', '--preserve-commit-hashes', '--replace-refs', 'delete-no-add',
            '--refs', *tips, *['^' + b for b in boundary]]
    fr.RepoFilter(fr.FilteringOptions.parse_args(argv), message_callback=clean_message).run()
    left, mismatches, cmap = verify(repo, refs, os.path.join(repo, 'filter-repo', 'commit-map'))
    print(f'[{name}] commit-map entries: {len(cmap)}; attribution left: {left}; '
          f'tree/ref mismatches: {len(mismatches)}')
    for m in mismatches[:10]:
        print('   MISMATCH', m)
    with open(os.path.join(os.path.dirname(repo), f'{name}.commit-map'), 'w') as f:
        f.write(''.join(f'{o} {n}\n' for o, n in cmap.items()))
    return 1 if (left or mismatches) else 0


if __name__ == '__main__':
    sys.exit(main())
