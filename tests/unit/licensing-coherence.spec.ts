/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Licensing-coherence guard. The licensing surface drifted in three ways at once and nothing caught any of them: CONTRIBUTING declared inbound contributions AGPL-only (which would permanently bar contributed code from the commercial exception), no NOTICE existed so a fork had no attribution record to preserve, and CONTRIBUTING claimed main was a protected branch while GitHub reported no protection at all. This spec pins the invariants that make the open-core license story hold together, and fails loudly if any single surface is edited out of agreement with the others.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';

const REPO_ROOT = resolve(__dirname, '../..');

/** The declared license, in the one form every surface must agree on. */
const SPDX = 'AGPL-3.0-or-later';

/**
 * @description Read a repo-relative text file for assertion.
 * @param rel Repo-relative path.
 * @returns File contents as UTF-8.
 */
function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

/**
 * @description Collect the relative markdown links in a document so the guard can
 *              prove the licensing surface does not point at files that don't exist.
 *              A dangling link in a license document is a compliance gap, not a typo:
 *              the obligations it describes become unfindable.
 * @param body Markdown source.
 * @param fromRel Repo-relative path of the document, used to resolve links.
 * @returns Repo-relative paths the document links to.
 */
function relativeLinkTargets(body: string, fromRel: string): string[] {
  const fromDir = dirname(join(REPO_ROOT, fromRel));
  const targets: string[] = [];
  for (const match of body.matchAll(/\]\((?!https?:|mailto:|#)([^)#\s]+)/g)) {
    targets.push(resolve(fromDir, match[1]));
  }
  return targets;
}

/** Every file that makes a licensing claim, and therefore must stay in agreement. */
const LICENSING_SURFACE = [
  'LICENSE',
  'NOTICE',
  'CLA.md',
  'docs/legal/licensing.md',
  'docs/legal/README.md',
];

describe('licensing surface exists', () => {
  it.each(LICENSING_SURFACE)('%s is present', (rel) => {
    expect(existsSync(join(REPO_ROOT, rel)), `${rel} is missing`).toBe(true);
  });

  it('LICENSE is the AGPL v3 text, not a placeholder or a different license', () => {
    const license = read('LICENSE');
    expect(license).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
    expect(license).toContain('Version 3');
    // Section 13 is the network clause — the reason this project chose AGPL over GPL.
    expect(license).toMatch(/Remote Network Interaction/i);
  });

  it('package.json declares exactly the license the LICENSE file contains', () => {
    const pkg = JSON.parse(read('package.json')) as { license?: string };
    expect(pkg.license).toBe(SPDX);
  });
});

describe('NOTICE carries the attribution record a fork must preserve', () => {
  const notice = read('NOTICE');

  it('names the copyright holder', () => {
    expect(notice).toMatch(/Copyright \(c\) \d{4} Emerald Coast Systems Group/);
  });

  it('points at the license and the canonical explainer', () => {
    expect(notice).toContain('LICENSE');
    expect(notice).toContain('docs/legal/licensing.md');
  });

  it('states the obligations that survive a fork', () => {
    expect(notice).toMatch(/section 5\(a\)/);
    expect(notice).toMatch(/section 13/);
  });

  it('reserves the project name separately from the code grant', () => {
    expect(notice).toMatch(/TRADEMARK/);
    expect(notice).toMatch(/section 7\(e\)/);
  });

  it('states what third-party material is and is not carried in this tree', () => {
    expect(notice).toMatch(/THIRD-PARTY MATERIAL/);
    expect(notice).toMatch(/node_modules\/ is untracked/);
  });
});

describe('inbound contribution terms keep the commercial exception possible', () => {
  const cla = read('CLA.md');

  it('CLA grants sublicensing — without it, contributed code can never ship commercially', () => {
    expect(cla).toMatch(/sublicense/i);
    expect(cla).toMatch(/right to license Your\s+Contribution/i);
  });

  it('CLA includes a patent grant and an employer-rights representation', () => {
    expect(cla).toMatch(/patent license/i);
    expect(cla).toMatch(/employer/i);
  });

  it('CLA promises the public project stays AGPL — the grant is additive, not a takeover', () => {
    expect(cla).toMatch(/remains AGPL-3\.0-or-later|public project remains AGPL/i);
  });

  it('CONTRIBUTING routes contributors to the CLA rather than declaring them AGPL-only', () => {
    const contributing = read('CONTRIBUTING.md');
    expect(contributing).toContain('CLA.md');
    // The exact regression this guard exists for: the old wording made every
    // contribution inbound-AGPL with no further grant.
    expect(contributing).not.toMatch(
      /you agree your contributions are licensed under the\s+GNU Affero/i,
    );
  });

  it('the PR template asks for the agreement in a readable, checkable form', () => {
    const template = read('.github/PULL_REQUEST_TEMPLATE.md');
    expect(template).toContain('CLA.md');
    expect(template).toMatch(/Signed-off-by/);
  });
});

describe('the license is not quietly narrowed', () => {
  /**
   * The maintainer considered and rejected a source-available model. AGPL permits
   * commercial and in-production use, and the docs say so out loud. If a
   * restriction like this ever appears on a licensing surface, either the license
   * changed (and every surface plus package.json must change with it) or somebody
   * added an unenforceable clause. Both need a human.
   */
  const PROHIBITIONS = [
    /for non-?commercial use only/i,
    /may not (be )?use[d]? in production/i,
    /you may not reverse.?engineer/i,
    /no commercial use/i,
  ];

  it.each(LICENSING_SURFACE.filter((f) => f !== 'LICENSE'))(
    '%s imposes no field-of-use restriction',
    (rel) => {
      const body = read(rel);
      for (const pattern of PROHIBITIONS) {
        expect(body, `${rel} matched ${pattern}`).not.toMatch(pattern);
      }
    },
  );

  it('licensing.md affirms production and corporate use explicitly', () => {
    const doc = read('docs/legal/licensing.md');
    expect(doc).toMatch(/inside a company, in production/i);
    expect(doc).toMatch(/copyleft,\s*\n?\s*not non-commercial/i);
  });

  it('licensing.md is honest that functionality itself is not protected', () => {
    const doc = read('docs/legal/licensing.md');
    expect(doc).toMatch(/102\(b\)/);
  });
});

describe('the licensing docs are reachable and their links resolve', () => {
  it('docs/README.md indexes the legal topic folder', () => {
    expect(read('docs/README.md')).toContain('legal/README.md');
  });

  it('README links attribution, licensing detail, and the CLA', () => {
    const readme = read('README.md');
    expect(readme).toContain('(NOTICE)');
    expect(readme).toContain('docs/legal/licensing.md');
    expect(readme).toContain('(CLA.md)');
  });

  it.each(['docs/legal/licensing.md', 'docs/legal/README.md', 'CLA.md'])(
    '%s has no dangling relative links',
    (rel) => {
      const missing = relativeLinkTargets(read(rel), rel).filter((p) => !existsSync(p));
      expect(missing, `dangling links in ${rel}`).toEqual([]);
    },
  );
});
