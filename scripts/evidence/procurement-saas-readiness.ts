/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add Change Log header; docs/ path references updated in the 2026-07-04 docs consolidation
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | buyer-admin-console gate: track the audit panel's intentional rename audit-export -> audit-search (commit a5ba244b) so the completed console no longer reports as a blocker
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Fix stale "13-category" label -> "15-category" (harness grew 13->15 on 2026-06-30 by adding the Agent-Cluster Steps + Any-Bot Runtime differentiator axes); the stale label was feeding a recurring "how many categories" confusion
 */
/**
 * Evidence-backed readiness gate for the two market gaps that cannot be closed
 * by the 15-category proof harness alone:
 *
 * - Enterprise procurement readiness.
 * - Public self-serve SaaS readiness.
 *
 * These scores are intentionally stricter than "a route exists." Missing buyer
 * artifacts, managed-service controls, and self-serve lifecycle pieces remain
 * blockers even when the local proof wall is healthy.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type GateKind = 'fileExists' | 'fileContains' | 'evidenceFile' | 'manual';
type GateStatus = 'pass' | 'missing';
type TrackStatus = 'ready' | 'pilot-ready' | 'partial' | 'blocked';

interface BaseGateSpec {
  id: string;
  label: string;
  kind: GateKind;
  weight: number;
  live?: boolean;
  missingMeans: string;
  nextMove: string;
}

interface FileExistsGateSpec extends BaseGateSpec {
  kind: 'fileExists';
  file: string;
}

interface FileContainsGateSpec extends BaseGateSpec {
  kind: 'fileContains';
  file: string;
  patterns: Array<string | RegExp>;
}

interface EvidenceFileGateSpec extends BaseGateSpec {
  kind: 'evidenceFile';
  prefix: string;
  patterns?: Array<string | RegExp>;
}

interface ManualGateSpec extends BaseGateSpec {
  kind: 'manual';
}

type GateSpec = FileExistsGateSpec | FileContainsGateSpec | EvidenceFileGateSpec | ManualGateSpec;

export interface ReadinessTrackSpec {
  id: 'enterprise-procurement' | 'public-self-serve-saas';
  title: string;
  currentMarketScore: number;
  targetMarketScore: number;
  definitionOfDone: string;
  gates: GateSpec[];
}

export interface GateResult {
  id: string;
  label: string;
  kind: GateKind;
  weight: number;
  status: GateStatus;
  live: boolean;
  evidence: string;
  missingMeans: string;
  nextMove: string;
}

export interface ReadinessTrackResult {
  id: ReadinessTrackSpec['id'];
  title: string;
  score: number;
  currentMarketScore: number;
  targetMarketScore: number;
  status: TrackStatus;
  definitionOfDone: string;
  gates: GateResult[];
  blockers: GateResult[];
}

export interface ProcurementSaasReadinessReport {
  generatedAt: string;
  generatedDate: string;
  repoRoot: string;
  guardrail: string;
  totals: {
    tracks: number;
    averageScore: number;
    ready: number;
    pilotReady: number;
    partial: number;
    blocked: number;
  };
  tracks: ReadinessTrackResult[];
}

interface BuildOptions {
  now?: Date;
  dateStamp?: string;
}

interface CliOptions {
  json: boolean;
  dryRun: boolean;
  outDir: string;
  dateStamp?: string;
}

const LIVE_PROOF_MAX_AGE_HOURS = positiveInt(process.env.PROCUREMENT_SAAS_EVIDENCE_MAX_LIVE_AGE_HOURS) ?? 168;
const LIVE_PROOF_MARKER = /Proof[- ]?Tier:\s*\*{0,2}\s*live\b/i;

export function getReadinessTrackSpecs(): ReadinessTrackSpec[] {
  return [
    {
      id: 'enterprise-procurement',
      title: 'Enterprise Procurement Readiness',
      currentMarketScore: 68,
      targetMarketScore: 90,
      definitionOfDone:
        'A buyer can approve a pilot or purchase after reviewing isolation, RBAC, audit, security, compliance, deployment, support, and admin controls without requiring shell access.',
      gates: [
        evidenceGate(
          'two-user-isolation-live',
          'Two-user isolation is live-proved under app-role RLS/GUC posture',
          'live-two-user-isolation-',
          3,
          // Require both layers from prove-own-data-live: the RLS exclusion matrix and the
          // signed-in route fixture directly observed in Postgres. An old loopback/RLS-only
          // document must not satisfy procurement evidence.
          [/cannot read/i, /cross-user/i, /signed-in route/i, /Postgres/i],
          'A procurement reviewer cannot trust multi-user or tenant safety.',
          'Keep the proof fresh and extend it to connector records, artifacts, workflows, and admin views.',
        ),
        fileContainsGate(
          'rls-posture-api',
          'Governance posture route exposes RLS stage and control blockers',
          'src/app/routes/audit-export-routes.ts',
          1.5,
          ['buildRlsPostureSnapshot', 'releaseReady', 'blockers'],
          'Admins cannot inspect isolation posture from the product.',
          'Surface the posture snapshot in the admin console and include it in procurement export.',
        ),
        fileContainsGate(
          'audit-export-api',
          'Audit export route exists and is RBAC-gated',
          'src/app/routes/audit-export-routes.ts',
          1.5,
          ['/audit/export', 'rbacMiddleware', 'Permission.AuditExport'],
          'A buyer cannot answer who did what, when, and export it.',
          'Add admin UI for audit search/export and include CSV/JSON samples in the security packet.',
        ),
        fileContainsGate(
          'rbac-policy',
          'RBAC roles and policy enforcement scaffolding exist',
          'src/features/governance/rbac/policy.ts',
          1,
          ['resolveRole', 'isEnforcementEnabled', 'rbacMiddleware'],
          'Governance depends on scattered auth checks instead of a permission model.',
          'Turn RBAC enforcement on in staged/prod and prove admin/member/viewer negative paths.',
        ),
        fileExistsGate(
          'security-control-evidence',
          'Security control evidence maps access control and SSRF guarantees',
          'docs/security/security-control-evidence.md',
          2,
          'Security claims are not packaged for buyer review.',
          'Expand this into a buyer-facing security packet with diagrams and subprocessors.',
        ),
        evidenceGate(
          'risky-write-guards-live',
          'Risky write guards are live-proved',
          'risky-write-guards-',
          2,
          // (/no-device-write/i dropped at the home carve, ADR-085 Wave 2; /no-charge/i is
          //  historical - both guards ship in store packages now.)
          [/no-send/i, /no-charge/i, /no-post/i],
          'High-risk tools could appear able to mutate without proof of explicit approval.',
          'Keep guard proofs fresh and add provider-specific sandbox write previews.',
        ),
        evidenceGate(
          'data-export-delete-live',
          'Data export/delete path is live-proved',
          'data-export-delete-',
          1.5,
          [/export/i, /delete/i, /Postgres/i, /oshal_app/i],
          'Privacy and deletion promises are not demonstrable.',
          'Expose export/delete in admin and user settings with audit receipts.',
        ),
        evidenceGate(
          'backup-restore-live',
          'Backup and restore proof exists',
          'backup-restore-',
          1,
          [/backup/i, /restore/i],
          'A buyer cannot trust recovery posture.',
          'Automate scheduled backup verification and include RPO/RTO targets.',
        ),
        evidenceGate(
          'hosted-enough-live',
          'Hosted-enough deployment proof exists for design partners',
          'hosted-enough-',
          1,
          [/dns/i, /tls/i, /ingress/i],
          'There is no credible hosted pilot path.',
          'Promote this to managed DB, monitoring, and public ingress proof for self-serve.',
        ),
        evidenceGate(
          'connector-live-reads',
          'At least five credentialed connector reads are live-proved',
          'connector-five-live-reads-',
          1,
          [/6 pass|5 pass/i],
          'Buyer cannot trust connector claims beyond static catalog entries.',
          'Raise the bar to 15 read connectors and five sandbox write-preview connectors.',
        ),
        fileExistsGate(
          'operator-connector-action-list',
          'Operator connector app/key responsibility list exists',
          'docs/setup/operator-connector-action-list-2026-06-23.md',
          1,
          'Provider setup ownership is unclear.',
          'Convert the list into admin UI status plus smoke-test receipts.',
        ),
        evidenceGate(
          'cost-control-live',
          'Cost control proof exists',
          'token-chase-demo-',
          1,
          [/estimated/i, /actual/i, /cost/i],
          'Budget predictability is not buyer-visible.',
          'Add per-tenant budgets, alerts, and admin cost rollups.',
        ),
        fileContainsGate(
          'buyer-admin-console',
          'Single buyer-grade admin console is complete',
          'src/pages/admin/index.html',
          2,
          [
            'data-admin-console="buyer-grade"',
            'data-admin-section="identity-rbac"',
            'data-admin-section="tenant-isolation"',
            'data-admin-section="connectors"',
            'data-admin-section="audit-search"',
            'data-admin-section="cost-governance"',
            'data-admin-section="procurement-readiness"',
          ],
          'Admins still need multiple surfaces and sometimes shell/docs to answer core governance questions.',
          'Keep deepening this console with editable policy controls and live screenshots.',
        ),
        fileContainsGate(
          'scim-provisioning',
          'SCIM or equivalent automated user provisioning is documented and tested',
          'docs/enterprise/scim-provisioning-bridge-2026-06-23.md',
          1.5,
          ['OIDC group/role claim mapping', 'Full SCIM is still open work', 'src/features/governance/rbac/claims.test.ts'],
          'Enterprise IT cannot automate joiner/mover/leaver lifecycle.',
          'Implement full SCIM user/group lifecycle before broad enterprise self-serve.',
        ),
        fileContainsGate(
          'permission-aware-rag-foundation',
          'Permission-aware RAG ACL filter foundation is documented and tested',
          'docs/enterprise/permission-aware-rag-foundation-2026-06-23.md',
          1,
          ['permission-filter.ts', 'rag-permission-filter.spec.ts', 'Full permission-aware RAG remains a gap'],
          'Protected retrieval has no reusable ACL filter foundation.',
          'Wire this foundation through ingestion, vector metadata, query-time filters, and citations.',
        ),
        evidenceGate(
          'permission-aware-rag-live',
          'Native source-ACL mapping + cross-user retrieval denial is live-proved',
          'permission-aware-rag-',
          2.5,
          [/cross-user/i, /denied/i],
          'Retrieval could return documents a source system would not have shown the caller.',
          'Keep the live cross-user proof fresh and extend the source-ACL mapper to more providers.',
        ),
        manualGate(
          'permission-aware-rag-source-oauth',
          'Live source-ACL SYNC from a credentialed connector + citation-basis output',
          1.5,
          'Source ACLs are mapped from fixtures/ingest, not yet auto-synced from a live connector OAuth read.',
          'Perform a credentialed Drive/Slack/GitHub read that auto-syncs native ACLs at ingest, add permission-drift + deleted-doc handling, and emit citations carrying source path + permission basis.',
        ),
        fileContainsGate(
          'procurement-security-packet',
          'Pilot procurement security packet is assembled',
          'docs/enterprise/procurement-security-packet-2026-06-23.md',
          1.5,
          ['Product Boundary', 'Current Security Controls', 'Open Procurement Gaps'],
          'Security evidence is internal and fragmented.',
          'Keep turning this into a full buyer packet with legal DPA, subprocessor list, audit samples, and external assessment plan.',
        ),
        fileContainsGate(
          'sla-support-posture',
          'SLA, support, incident, and escalation posture is defined',
          'docs/operations/support-sla-incident-posture-2026-06-23.md',
          1.5,
          ['Severity Model', 'Incident Response', 'Procurement Answer'],
          'A buyer cannot understand operational responsibility after purchase.',
          'Promote this from design-partner posture to public SaaS SLA after managed monitoring and status communication land.',
        ),
      ],
    },
    {
      id: 'public-self-serve-saas',
      title: 'Public Self-Serve SaaS Readiness',
      currentMarketScore: 66,
      targetMarketScore: 90,
      definitionOfDone:
        'A stranger can sign up, choose a plan, connect core providers, complete first value, recover from failures, and trust the hosted service without operator intervention.',
      gates: [
        evidenceGate(
          'hosted-enough-live',
          'Hosted-enough deployment proof exists',
          'hosted-enough-',
          2,
          [/dns/i, /tls/i, /ingress/i],
          'There is no internet-reachable path for non-local users.',
          'Turn hosted-enough into a repeatable public deployment profile with managed services.',
        ),
        fileContainsGate(
          'deployment-models',
          'Deployment models document local, tunneled, and Kubernetes paths',
          'docs/deployment-models.md',
          1.5,
          ['Zero-keys demo', 'Tunneled prod', 'Kubernetes'],
          'A new operator cannot choose the right install path.',
          'Add a public hosted path with managed DB, ingress, DNS, and monitoring steps.',
        ),
        evidenceGate(
          'local-boot-live',
          'One-command local boot proof exists',
          'local-boot-',
          1.5,
          [/health/i, /cockpit/i],
          'The first install path is not repeatable.',
          'Keep the boot proof fresh and add Windows/macOS packaging checks.',
        ),
        evidenceGate(
          'first-run-live',
          'Clean-account first-run reaches first value',
          'first-run-clean-account-',
          2,
          [/first value/i, /connector/i],
          'A new user cannot reliably reach first value.',
          'Make the welcome flow an end-to-end wizard with account, model, connector, and first task steps.',
        ),
        fileContainsGate(
          'welcome-flow',
          'Welcome flow gates provider and connector setup',
          'src/pages/welcome/welcome.js',
          1,
          ['confirmConnected', 'provider', 'connector'],
          'A new user has to discover setup across scattered surfaces.',
          'Add progress state and restartable checklist persistence.',
        ),
        fileContainsGate(
          'connector-marketplace-api',
          'Connector marketplace API exposes browse and enable controls',
          'src/app/routes/connector-marketplace-routes.ts',
          1.5,
          ['/marketplace', 'enable', 'disable'],
          'Users cannot self-serve connector discovery.',
          'Add setup-status filters, top-picks, icons, and provider-specific connect flows.',
        ),
        fileExistsGate(
          'operator-connector-list',
          'Operator connector action list separates platform keys from user credentials',
          'docs/setup/operator-connector-action-list-2026-06-23.md',
          1,
          'Users may be asked to do provider-app work they should not do.',
          'Convert this into product copy and admin setup status.',
        ),
        evidenceGate(
          'backup-restore-live',
          'Backup and restore proof exists',
          'backup-restore-',
          1,
          [/backup/i, /restore/i],
          'Hosted users cannot trust recovery.',
          'Automate backups for hosted profile and publish restore runbooks.',
        ),
        evidenceGate(
          'surface-polish-live',
          'Surface render polish proof exists',
          'surface-polish-pass-',
          1,
          [/surfaces ok|Status: passed/i],
          'Pages may fail to render or leak raw bot output.',
          'Upgrade this from render health to strict UX quality gates.',
        ),
        evidenceGate(
          'clickthrough-live',
          'Critical app clickthrough proof exists',
          'app-clickthrough-polish-',
          1,
          [/Rides/i, /Eats/i, /Shopping/i, /Workflow Studio/i],
          'Core product apps may render but not complete a user loop.',
          'Require realistic task-loop proof for every flagship screen.',
        ),
        evidenceGate(
          'performance-live',
          'Performance baseline proof exists',
          'performance-baseline-',
          1,
          [/p95/i, /cockpit/i],
          'Hosted users may hit slow or frozen screens without visibility.',
          'Expose p95 and error-rate trends in operations.',
        ),
        fileContainsGate(
          'real-auth-hosted',
          'Hosted profile documents real OIDC and session secret requirements',
          'docs/deployment-models.md',
          1,
          ['MOCK_OIDC=false', 'OIDC_CLIENT_ID', 'SESSION_SECRET'],
          'Public hosting could accidentally use mock auth or weak sessions.',
          'Add preflight blocks that refuse public exposure with mock auth or missing secrets.',
        ),
        fileContainsGate(
          'cloudflared-profile',
          'Cloudflared hosted profile is wired in compose',
          'docker-compose.oshal-local.yml',
          1,
          ['cloudflared', 'profiles', 'tunnel'],
          'There is no repeatable tunnel-backed pilot mode.',
          'Add public-domain health checks and a hosted preflight script.',
        ),
        fileContainsGate(
          'tenant-bootstrap-api',
          'Authenticated tenant bootstrap API exists',
          'src/app/routes/tenant-routes.ts',
          1,
          ['POST /api/tenants', 'caller becomes admin', 'createTenant'],
          'Users cannot create a tenant/space after first login.',
          'Wire this into public signup and first-admin onboarding.',
        ),
        fileContainsGate(
          'public-plan-catalog',
          'Public plan catalog and quota helper are implemented',
          'src/features/saas/plans.ts',
          1,
          ['PUBLIC_PLAN_CATALOG', 'evaluatePlanLimits', 'monthlyTokenBudgetUsd'],
          'Self-serve pricing and limits are not modeled.',
          'Wire the catalog to checkout, tenant records, runtime quota enforcement, and admin usage views.',
        ),
        fileContainsGate(
          'public-self-serve-foundation-doc',
          'Public self-serve foundation doc names open lifecycle gaps',
          'docs/saas/public-self-serve-foundation-2026-06-23.md',
          1,
          ['Public Signup Still Required', 'Billing Still Required', 'Managed Hosting Still Required'],
          'The SaaS work queue is not productized.',
          'Promote the open gaps into code and live evidence.',
        ),
        manualGate(
          'public-self-signup',
          'Public self-signup and tenant creation are productized',
          2,
          'Strangers cannot create accounts and tenant spaces without operator help.',
          'Build signup, email verification, tenant bootstrap, and first admin setup.',
        ),
        manualGate(
          'billing-checkout',
          'Billing checkout, subscription state, and payment recovery are implemented',
          2,
          'Self-serve users cannot subscribe, upgrade, downgrade, or recover payment failures.',
          'Add Stripe or invoice checkout, subscription records, webhooks, and payment-failure handling.',
        ),
        manualGate(
          'runtime-quota-enforcement',
          'Plan quotas are enforced in hosted runtime paths',
          2,
          'Plans exist but do not yet throttle hosted usage.',
          'Apply plan limits to seats, connectors, monthly tasks, token spend, and high-risk action access.',
        ),
        manualGate(
          'managed-db-scaling',
          'Managed database, queue, worker, and scaling profile is proved',
          2,
          'The hosted path is still closer to operated design-partner mode than true SaaS.',
          'Document and test managed Postgres, Redis/queue, worker autoscale, migrations, and rollback.',
        ),
        manualGate(
          'production-monitoring',
          'Production monitoring, alerting, and status communication are ready',
          1.5,
          'Outages would depend on manual log watching.',
          'Add dashboards, alert rules, error budgets, status page, and on-call runbook.',
        ),
        manualGate(
          'onboarding-emails-invites',
          'Onboarding email, tenant invites, and lifecycle messaging exist',
          1.5,
          'Users need operator guidance for setup, invites, and recovery.',
          'Implement invite emails, connector reminders, failed setup recovery, and welcome sequence.',
        ),
      ],
    },
  ];
}

export function buildProcurementSaasReadiness(
  repoRoot = process.cwd(),
  options: BuildOptions = {},
): ProcurementSaasReadinessReport {
  const now = options.now || new Date();
  const generatedDate = options.dateStamp || formatDateStamp(now);
  const tracks = getReadinessTrackSpecs().map((track) => evaluateTrack(repoRoot, track, now));
  const averageScore = Math.round(tracks.reduce((sum, track) => sum + track.score, 0) / tracks.length);

  return {
    generatedAt: formatTimestamp(now),
    generatedDate,
    repoRoot,
    guardrail:
      'Manual buyer/SaaS lifecycle gaps stay missing until an implementation or operator-facing evidence artifact exists. Live proof is considered stale after ' +
      `${LIVE_PROOF_MAX_AGE_HOURS} hours.`,
    totals: {
      tracks: tracks.length,
      averageScore,
      ready: tracks.filter((track) => track.status === 'ready').length,
      pilotReady: tracks.filter((track) => track.status === 'pilot-ready').length,
      partial: tracks.filter((track) => track.status === 'partial').length,
      blocked: tracks.filter((track) => track.status === 'blocked').length,
    },
    tracks,
  };
}

export function renderProcurementSaasReadinessMarkdown(report: ProcurementSaasReadinessReport): string {
  const lines: string[] = [
    '# Enterprise Procurement And Public Self-Serve SaaS Readiness',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '**Proof-Tier:** live - generated from repo evidence plus explicit manual market blockers.',
    '',
    `Guardrail: ${report.guardrail}`,
    '',
    '## Summary',
    '',
    '| Track | Score | Gap Analysis Score | Target | Status | Top Blocker |',
    '|---|---:|---:|---:|---|---|',
  ];

  for (const track of report.tracks) {
    lines.push(
      `| ${track.title} | ${track.score} | ${track.currentMarketScore} | ${track.targetMarketScore} | ${track.status} | ${track.blockers[0]?.label ?? 'none'} |`,
    );
  }

  lines.push('', '## Tracks', '');

  for (const track of report.tracks) {
    lines.push(
      `### ${track.title}`,
      '',
      `Score: ${track.score}/100. Gap-analysis score: ${track.currentMarketScore}/100. Target: ${track.targetMarketScore}/100. Status: ${track.status}.`,
      '',
      `Definition of done: ${track.definitionOfDone}`,
      '',
      '| Gate | Status | Weight | Evidence | Next Move |',
      '|---|---|---:|---|---|',
    );

    for (const gate of track.gates) {
      lines.push(
        `| ${gate.label}${gate.live ? ' live' : ''} | ${gate.status} | ${gate.weight} | ${gate.evidence} | ${gate.status === 'pass' ? gate.nextMove : `${gate.missingMeans} ${gate.nextMove}`} |`,
      );
    }

    lines.push('', 'Top blockers:', '');
    if (track.blockers.length === 0) {
      lines.push('- none');
    } else {
      for (const blocker of track.blockers.slice(0, 5)) {
        lines.push(`- ${blocker.label}: ${blocker.nextMove}`);
      }
    }
    lines.push('');
  }

  lines.push(
    '## Immediate Work Queue',
    '',
    '1. Wire permission-aware RAG through source ACL sync, vector metadata, query-time filters, citations, and cross-user negative live tests.',
    '2. Productize public self-signup: IdP account creation, email verification, tenant bootstrap, first admin, invite flow, and first-value wizard.',
    '3. Add billing checkout, subscription state, payment recovery, and hosted runtime quota enforcement.',
    '4. Prove managed hosted operations: managed DB, queue/worker scaling, monitoring, alerting, backups, restore, rollback, and status communication.',
    '5. Deepen the buyer-grade Admin Console with editable policy controls, audit search, connector smoke receipts, and live screenshot evidence.',
    '6. Promote the pilot procurement/support packets into full legal/security packets with DPA, subprocessor table, external assessment plan, and public SLA posture.',
    '',
  );

  return `${lines.join('\n')}\n`;
}

export function writeProcurementSaasReadiness(
  report: ProcurementSaasReadinessReport,
  outDir = path.join(report.repoRoot, 'docs/evidence'),
): { markdownPath: string; jsonPath: string } {
  mkdirSync(outDir, { recursive: true });
  const basename = `procurement-saas-readiness-${report.generatedDate}`;
  const markdownPath = path.join(outDir, `${basename}.md`);
  const jsonPath = path.join(outDir, `${basename}.json`);
  writeFileSync(markdownPath, renderProcurementSaasReadinessMarkdown(report), 'utf8');
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { markdownPath, jsonPath };
}

function evaluateTrack(repoRoot: string, spec: ReadinessTrackSpec, now: Date): ReadinessTrackResult {
  const gates = spec.gates.map((gate) => evaluateGate(repoRoot, gate, now));
  const totalWeight = gates.reduce((sum, gate) => sum + gate.weight, 0);
  const earnedWeight = gates.reduce((sum, gate) => sum + (gate.status === 'pass' ? gate.weight : 0), 0);
  const score = totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0;
  const blockers = gates
    .filter((gate) => gate.status !== 'pass')
    .sort((a, b) => b.weight - a.weight);

  return {
    id: spec.id,
    title: spec.title,
    score,
    currentMarketScore: spec.currentMarketScore,
    targetMarketScore: spec.targetMarketScore,
    status: statusFor(score),
    definitionOfDone: spec.definitionOfDone,
    gates,
    blockers,
  };
}

function evaluateGate(repoRoot: string, spec: GateSpec, now: Date): GateResult {
  switch (spec.kind) {
    case 'fileExists': {
      return gateResult(spec, existsSync(path.join(repoRoot, spec.file)), spec.file);
    }
    case 'fileContains': {
      const content = readIfExists(path.join(repoRoot, spec.file));
      const passed = content !== null && spec.patterns.every((pattern) => matches(content, pattern));
      return gateResult(spec, passed, spec.file);
    }
    case 'evidenceFile': {
      const evidence = findEvidence(repoRoot, spec, now);
      return gateResult(spec, evidence !== null, evidence ?? `docs/evidence/${spec.prefix}*.md`);
    }
    case 'manual':
      return gateResult(spec, false, 'manual implementation evidence required');
    default:
      return assertNever(spec);
  }
}

function findEvidence(repoRoot: string, spec: EvidenceFileGateSpec, now: Date): string | null {
  const evidenceDir = path.join(repoRoot, 'docs/evidence');
  if (!existsSync(evidenceDir)) return null;
  const candidates = readdirSync(evidenceDir)
    .filter((entry) => entry.startsWith(spec.prefix) && (entry.endsWith('.md') || entry.endsWith('.json')))
    .sort()
    .reverse();

  for (const candidate of candidates) {
    const absolute = path.join(evidenceDir, candidate);
    if (!statSync(absolute).isFile()) continue;
    const content = readIfExists(absolute);
    if (content === null) continue;
    if (spec.live && !LIVE_PROOF_MARKER.test(content)) continue;
    if (spec.live && !isFreshLiveProof(content, now)) continue;
    if (spec.patterns && !spec.patterns.every((pattern) => matches(content, pattern))) continue;
    return normalizeSlashes(path.join('docs/evidence', candidate));
  }

  return null;
}

function gateResult(spec: GateSpec, passed: boolean, evidence: string): GateResult {
  return {
    id: spec.id,
    label: spec.label,
    kind: spec.kind,
    weight: spec.weight,
    status: passed ? 'pass' : 'missing',
    live: spec.live === true,
    evidence: normalizeSlashes(evidence),
    missingMeans: spec.missingMeans,
    nextMove: spec.nextMove,
  };
}

function fileExistsGate(
  id: string,
  label: string,
  file: string,
  weight: number,
  missingMeans: string,
  nextMove: string,
): FileExistsGateSpec {
  return { id, label, kind: 'fileExists', file, weight, missingMeans, nextMove };
}

function fileContainsGate(
  id: string,
  label: string,
  file: string,
  weight: number,
  patterns: Array<string | RegExp>,
  missingMeans: string,
  nextMove: string,
): FileContainsGateSpec {
  return { id, label, kind: 'fileContains', file, patterns, weight, missingMeans, nextMove };
}

function evidenceGate(
  id: string,
  label: string,
  prefix: string,
  weight: number,
  patterns: Array<string | RegExp>,
  missingMeans: string,
  nextMove: string,
): EvidenceFileGateSpec {
  return { id, label, kind: 'evidenceFile', prefix, patterns, weight, live: true, missingMeans, nextMove };
}

function manualGate(
  id: string,
  label: string,
  weight: number,
  missingMeans: string,
  nextMove: string,
): ManualGateSpec {
  return { id, label, kind: 'manual', weight, missingMeans, nextMove };
}

function statusFor(score: number): TrackStatus {
  if (score >= 90) return 'ready';
  if (score >= 75) return 'pilot-ready';
  if (score >= 60) return 'partial';
  return 'blocked';
}

function readIfExists(file: string): string | null {
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8');
}

function isFreshLiveProof(content: string, now: Date): boolean {
  const timestamp = extractEvidenceTimestamp(content);
  if (!timestamp) return false;
  const ageMs = now.getTime() - timestamp.getTime();
  const maxAgeMs = LIVE_PROOF_MAX_AGE_HOURS * 60 * 60 * 1000;
  const futureToleranceMs = 5 * 60 * 1000;
  return ageMs >= -futureToleranceMs && ageMs <= maxAgeMs;
}

function extractEvidenceTimestamp(content: string): Date | null {
  const match = content.match(/^(?:Generated|Validated(?:-At| At)?|Date):\s*(.+)$/mi);
  if (!match) return null;
  const raw = match[1].trim();
  const withCentralOffset = raw.replace(/\s+CT$/i, ' -05:00');
  const candidates = [
    raw,
    withCentralOffset,
    raw.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{2}:\d{2})$/, '$1T$2$3'),
    withCentralOffset.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+([+-]\d{2}:\d{2})$/, '$1T$2:00$3'),
  ];
  for (const candidate of candidates) {
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return new Date(parsed);
  }
  return null;
}

function matches(content: string, pattern: string | RegExp): boolean {
  return typeof pattern === 'string' ? content.includes(pattern) : pattern.test(content);
}

function formatTimestamp(date: Date): string {
  return `${formatDateStamp(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${formatOffset(date)}`;
}

function formatDateStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatOffset(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function positiveInt(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled readiness gate: ${JSON.stringify(value)}`);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    dryRun: false,
    outDir: path.join(process.cwd(), 'docs/evidence'),
    dateStamp: process.env.OSHAL_EVIDENCE_DATE,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--out-dir') {
      options.outDir = next ? path.resolve(next) : options.outDir;
      index += 1;
    } else if (arg === '--date') {
      options.dateStamp = next;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp(): void {
  console.log([
    'Usage: npx ts-node -r tsconfig-paths/register --transpile-only scripts/evidence/procurement-saas-readiness.ts [options]',
    '',
    'Options:',
    '  --json             Print the report as JSON instead of Markdown.',
    '  --dry-run          Do not write docs/evidence artifacts.',
    '  --out-dir <path>   Output directory. Defaults to docs/evidence.',
    '  --date <YYYY-MM-DD> Override the generated artifact date stamp.',
  ].join('\n'));
}

async function runCli(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = buildProcurementSaasReadiness(process.cwd(), { dateStamp: options.dateStamp });
  const rendered = options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderProcurementSaasReadinessMarkdown(report);

  if (!options.dryRun) {
    const written = writeProcurementSaasReadiness(report, options.outDir);
    console.error(`Wrote ${normalizeSlashes(path.relative(process.cwd(), written.markdownPath))}`);
    console.error(`Wrote ${normalizeSlashes(path.relative(process.cwd(), written.jsonPath))}`);
  }

  process.stdout.write(rendered);
}

if (require.main === module) {
  void runCli().catch((error) => {
    console.error(`ERROR procurement-saas-readiness failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
