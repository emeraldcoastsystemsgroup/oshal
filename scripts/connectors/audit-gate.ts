/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — connector structural-audit gate: run auditConnectorCatalog over swarm-apps/connectors/*.yaml and FAIL (exit 1) on any error-level issue, so a malformed/unsafe spec can't ship. Complements curation-audit (coverage) — this is correctness/safety.
 *
 * The audit itself already exists (auditSpec/auditConnectorCatalog — ADR-065) and runs during import
 * and doc-gen, but nothing FAILS a build on an error-level issue (bad shape, duplicate tool name, a
 * paginating resource with no pagination block). This wires it as a gate:
 *
 *   npx ts-node -r tsconfig-paths/register --transpile-only scripts/connectors/audit-gate.ts
 *
 * Exit 0 = every spec passes (warns allowed).  Exit 1 = ≥1 spec has an error-level issue.
 * --strict promotes warnings to failures too (opt-in; the default keeps warns advisory).
 */

import { auditConnectorCatalog, formatAudit, type ConnectorAudit } from '../../src/app/connectors/runtime/catalog-audit';

/** Counts error/warn issues across the audited catalog. */
function tally(audits: ConnectorAudit[]): { errors: number; warns: number; failing: ConnectorAudit[] } {
  let errors = 0;
  let warns = 0;
  const failing: ConnectorAudit[] = [];
  for (const a of audits) {
    const errN = a.issues.filter((i) => i.level === 'error').length;
    const warnN = a.issues.filter((i) => i.level === 'warn').length;
    errors += errN;
    warns += warnN;
    if (!a.pass) failing.push(a);
  }
  return { errors, warns, failing };
}

function main(): void {
  const strict = process.argv.includes('--strict');
  const quiet = process.argv.includes('--quiet'); // CI: skip the per-spec PASS dump, keep summary + failures
  const audits = auditConnectorCatalog();

  if (!quiet) process.stdout.write(formatAudit(audits) + '\n');

  if (audits.length === 0) {
    process.stderr.write('connector-audit-gate: no connector specs found under swarm-apps/connectors/\n');
    process.exitCode = 2;
    return;
  }

  const { errors, warns, failing } = tally(audits);
  process.stdout.write(`\nConnector audit gate — ${audits.length} specs: ${errors} error(s), ${warns} warning(s), ${failing.length} failing spec(s).\n`);

  const gateFails = failing.length > 0 || (strict && warns > 0);
  if (gateFails) {
    if (failing.length > 0) {
      process.stderr.write('\nBLOCKING error-level issues (fix before this ships):\n');
      for (const a of failing) {
        for (const i of a.issues.filter((x) => x.level === 'error')) {
          process.stderr.write(`  [error] ${a.provider}: ${i.message}\n`);
        }
      }
    }
    if (strict && warns > 0) process.stderr.write(`\n--strict: ${warns} warning(s) also fail the gate.\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`OK — all ${audits.length} connector specs pass the structural audit gate.\n`);
}

main();
