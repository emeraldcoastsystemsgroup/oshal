#!/usr/bin/env python3
"""
CHANGE LOG
-----------------------------------------------------------------------------
SEQ                 | AUTHOR                                      | DESCRIPTION
-----------------------------------------------------------------------------
1 | maintainer@emeraldcoastsystemsgroup.com   | After a history rewrite has been force-pushed, move a WORKING clone's local branches onto the rewritten history without touching the checkout, the index or any file: a tip that appears in the commit-map is re-pointed with update-ref; a branch carrying unpushed commits has those commits rebuilt (same tree, author, committer and dates, cleaned message) on the mapped parents; a branch unrelated to the rewritten range is left alone and reported. Every move asserts the old and new trees are identical. Written for the shared multi-agent checkouts, where a checkout or reset would destroy someone else's work (CLAUDE.md Rule 0).

Re-point a working clone's local branches onto rewritten history (pointer-only).

Usage:
    python repoint_local.py <working-clone> <commit-map> <old-refs.txt> [--dry-run]

<commit-map>   written by scrub_history.py (old new per line)
<old-refs.txt> `git for-each-ref --format='%(objectname) %(refname)' refs/heads refs/tags`
               captured in the bare clone BEFORE the rewrite (defines what was pushed)
"""
import os
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scrub_history import clean_message  # noqa: E402  (same regexes as the rewrite)


def git(repo, *args, binary=False, env=None, stdin=None):
    """Run git in the working clone; never a command that touches the worktree or index."""
    r = subprocess.run(['git', *args], cwd=repo, capture_output=True, check=True,
                       env={**os.environ, **(env or {})}, input=stdin)
    return r.stdout if binary else r.stdout.decode('utf-8', 'replace').strip()


def rebuild(repo, commit, cmap):
    """Create a copy of `commit` with mapped parents and a cleaned message; same tree and identities."""
    meta = git(repo, 'log', '-1', '--date=raw',
               '--format=%an%x1f%ae%x1f%ad%x1f%cn%x1f%ce%x1f%cd%x1f%P%x1f%T', commit).split('\x1f')
    an, ae, ad, cn, ce, cd, parents, tree = meta
    parents = parents.split()
    msg = git(repo, 'log', '-1', '--format=%B', commit, binary=True)
    new_parents = [cmap.get(p, p) for p in parents]
    new_msg = clean_message(msg)
    if new_parents == parents and new_msg == msg:
        return commit
    env = {'GIT_AUTHOR_NAME': an, 'GIT_AUTHOR_EMAIL': ae, 'GIT_AUTHOR_DATE': ad,
           'GIT_COMMITTER_NAME': cn, 'GIT_COMMITTER_EMAIL': ce, 'GIT_COMMITTER_DATE': cd}
    args = ['commit-tree', tree]
    for p in new_parents:
        args += ['-p', p]
    return git(repo, *args, env=env, stdin=new_msg)


def target_for(repo, tip, cmap, old_tips, dry):
    """Where a local branch tip should move, or None when the branch is unrelated to the rewrite."""
    if tip in cmap:
        return cmap[tip], 0
    walk = git(repo, 'rev-list', '--reverse', '--topo-order', tip, *['^' + t for t in old_tips]).split()
    touches = any(p in cmap for c in walk for p in git(repo, 'log', '-1', '--format=%P', c).split())
    if not walk or not touches:
        return None, 0
    if dry:
        return tip, len(walk)
    local = dict(cmap)
    for c in walk:
        local[c] = rebuild(repo, c, local)
    return local[tip], len(walk)


def main():
    repo, cmap_path, oldrefs_path = sys.argv[1:4]
    dry = '--dry-run' in sys.argv
    cmap = dict(line.split() for line in open(cmap_path).read().split('\n') if line.strip())
    old_tips = [line.split()[0] for line in open(oldrefs_path).read().splitlines() if line.strip()]
    branches = [line.split() for line in git(repo, 'for-each-ref', '--format=%(objectname) %(refname)',
                                             'refs/heads').splitlines()]
    moved, rebuilt, alone = 0, [], []
    for tip, ref in branches:
        target, unpushed = target_for(repo, tip, cmap, old_tips, dry)
        if target is None:
            alone.append(ref)
            continue
        if unpushed:
            rebuilt.append((ref, unpushed))
        if target == tip and not dry:
            continue
        if not dry:
            old_tree = git(repo, 'rev-parse', tip + '^{tree}')
            new_tree = git(repo, 'rev-parse', target + '^{tree}')
            assert old_tree == new_tree, f'{ref}: tree mismatch {old_tree} vs {new_tree}'
            git(repo, 'update-ref', '-m', 'attribution scrub: re-point onto rewritten history', ref, target, tip)
        moved += 1
    print(f'[{os.path.basename(repo)}] branches: {len(branches)}; re-pointed: {moved} '
          f'(rebuilt unpushed commits on {len(rebuilt)}); left alone: {len(alone)}'
          + (' (dry-run)' if dry else ''))
    for ref, n in rebuilt:
        print(f'   rebuilt {n} unpushed commit(s): {ref}')
    for ref in alone:
        print(f'   left alone (unrelated to the rewritten range): {ref}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
