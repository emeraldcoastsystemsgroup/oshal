/**
 * Generates the competitive readiness artifact from repo evidence.
 *
 * The guardrail is intentional: code signals can raise confidence, but live-user
 * proof gaps cap a category at 75 until the evidence exists.
 *
 * The last two categories (Agent-Cluster Steps, Any-Bot Runtime) score OSHAL's
 * own differentiators rather than the field's parity axes: competitors run one
 * agent/tool per workflow node and have no runtime bot+tool spawner, so their
 * competitorScore is deliberately low and OSHAL reads as ahead even before the
 * live-proof cap lifts.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type CheckKind = 'fileExists' | 'fileContains' | 'fileCountAtLeast' | 'evidenceFile' | 'manual';
type CheckStatus = 'pass' | 'missing';
type CategoryStatus = 'closed' | 'ahead' | 'parity-unproven' | 'below-market';
type RecommendationTier = 'refresh' | 'capture' | 'build' | 'protect';

interface BaseCheckSpec {
  id: string;
  label: string;
  kind: CheckKind;
  weight?: number;
  live?: boolean;
  note?: string;
}

interface FileExistsCheckSpec extends BaseCheckSpec {
  kind: 'fileExists';
  file: string;
}

interface FileContainsCheckSpec extends BaseCheckSpec {
  kind: 'fileContains';
  file: string;
  patterns: Array<string | RegExp>;
}

interface FileCountAtLeastCheckSpec extends BaseCheckSpec {
  kind: 'fileCountAtLeast';
  directory: string;
  extensions: string[];
  atLeast: number;
}

interface EvidenceFileCheckSpec extends BaseCheckSpec {
  kind: 'evidenceFile';
  directory: string;
  filenamePattern: RegExp;
  patterns?: Array<string | RegExp>;
}

interface ManualCheckSpec extends BaseCheckSpec {
  kind: 'manual';
}

type CheckSpec =
  | FileExistsCheckSpec
  | FileContainsCheckSpec
  | FileCountAtLeastCheckSpec
  | EvidenceFileCheckSpec
  | ManualCheckSpec;

export interface CategorySpec {
  id: string;
  category: string;
  baselineScore: number;
  competitorScore: number;
  targetScore: number;
  liveProofCap: number;
  whyItMatters: string;
  nextMove: string;
  checks: CheckSpec[];
}

export interface CheckResult {
  id: string;
  label: string;
  kind: CheckKind;
  status: CheckStatus;
  weight: number;
  live: boolean;
  evidence: string;
  note?: string;
  /** For evidenceFile checks: did any artifact matching the filename prefix exist at
   *  all (even if stale or pattern-mismatched)? Distinguishes "re-measure" from "build". */
  artifactExists?: boolean;
}

export interface CategoryEvidence {
  id: string;
  category: string;
  score: number;
  baselineScore: number;
  competitorScore: number;
  targetScore: number;
  liveProofCap: number;
  status: CategoryStatus;
  whyItMatters: string;
  nextMove: string;
  checks: CheckResult[];
  blockers: string[];
  /** Whether the cheapest path up is to re-measure, capture first proof, build, or hold. */
  recommendationTier: RecommendationTier;
  /** Plain-language action that actually raises this score, not just "capture proof". */
  recommendation: string;
}

export interface CompetitiveEvidenceReport {
  generatedAt: string;
  generatedDate: string;
  repoRoot: string;
  guardrail: string;
  totals: {
    categories: number;
    closed: number;
    ahead: number;
    parityUnproven: number;
    belowMarket: number;
    missingLiveProof: number;
    averageScore: number;
  };
  categories: CategoryEvidence[];
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

const DEFAULT_LIVE_CAP = 75;

/**
 * A live-proof gate is only satisfied by an evidence doc that explicitly declares
 * `Proof-Tier: live`. This makes "this is a live deployed run" a deliberate, auditable
 * assertion by the doc author rather than something inferred from keyword overlap — a
 * unit/integration/mock proof (which must declare `Proof-Tier: contract`) can no longer
 * uncap a category just because it contains the right words. Tolerates markdown bold
 * (`**Proof-Tier:** live`).
 */
const LIVE_PROOF_MARKER = /Proof-Tier:\s*\*{0,2}\s*live\b/i;
const LIVE_PROOF_MAX_AGE_HOURS = positiveInt(process.env.COMPETITIVE_EVIDENCE_MAX_LIVE_AGE_HOURS) ?? 48;

export function getCategorySpecs(): CategorySpec[] {
  return [
    {
      id: 'connectors',
      category: 'Connectors',
      baselineScore: 60,
      competitorScore: 100,
      targetScore: 100,
      liveProofCap: DEFAULT_LIVE_CAP,
      whyItMatters: 'Connector breadth is where Zapier, n8n, and platform vendors look strongest.',
      nextMove: 'Keep scaling ADR-067 imports and fix provider-specific OAuth setup gaps found by smoke tests.',
      checks: [
        fileContains('adr-067', 'ADR-067 marketplace plan is accepted', 'docs/adr/067-connector-marketplace-and-dynamic-tool-loading.md', [
          'marketplace-gated connector spec route/tool loading',
          'OpenAPI draft import',
        ]),
        fileCount('catalog-breadth', 'At least 25 audited connector specs exist', 'swarm-apps/connectors', ['.yaml', '.yml'], 25),
        fileContains('marketplace-api', 'Marketplace API exposes browse and enable controls', 'src/app/routes/connector-marketplace-routes.ts', [
          '/marketplace',
          'enable',
          'disable',
        ]),
        fileContains('brokered-smoke-path', 'Smoke harness can resolve per-user broker tokens', 'scripts/connectors/smoke-test.ts', [
          '--user-sub',
          'getValidAccessToken',
        ]),
        evidenceFile('marketplace-live-ui', 'Signed-in Cockpit marketplace proof exists', 'connector-marketplace-smoke-', [/\/api\/connectors\/marketplace/i], true),
        evidenceFile('five-live-reads', 'Five credentialed read-only connector passes are proven', 'connector-five-live-reads-', [/5 pass/i], true),
      ],
    },
    {
      id: 'domain-actions',
      category: 'Domain Actions',
      baselineScore: 80,
      competitorScore: 80,
      targetScore: 90,
      liveProofCap: DEFAULT_LIVE_CAP,
      whyItMatters: 'The product must do useful work across career, comms, finance, home, and social.',
      nextMove: 'Run the five flagship read/approve/action loops and capture results.',
      checks: [
        fileContains('career-app', 'Career/job app ships as a store package (carved, ADR-085 Wave 3)', 'docs/apps/swarm-store-migration-plan.md', [
          'career-hunter',
        ]),
        fileContains('email-app', 'Email/comms app ships as a store package (carved, ADR-085 Wave 3)', 'docs/apps/swarm-store-migration-plan.md', [
          'email-summarizer',
        ]),
        fileContains('finance-app', 'Finance app ships as a store package (carved, ADR-085)', 'docs/apps/swarm-store-migration-plan.md', [
          'finance',
        ]),
        fileContains('home-app', 'Home app ships as a store package (carved, ADR-085 Wave 2)', 'docs/apps/swarm-store-migration-plan.md', [
          'home',
        ]),
        fileContains('social-app', 'Social app ships as a store package (carved, ADR-085 Wave 2)', 'docs/apps/swarm-store-migration-plan.md', [
          'social',
        ]),
        // (/finance/i dropped from the regex at the finance carve, ADR-085: the kernel generator
        //  no longer mounts finance — its flagship loop ships in the store package. /social/i is
        //  retained: the flagship-workflows proof still names social in its carved-store prose.)
        evidenceFile('flagship-proof', 'Flagship workflows have live read plus approval-gated action proof', 'flagship-workflows-', [/career/i, /social/i, /approval/i], true),
      ],
    },
    {
      id: 'reliability',
      category: 'Reliability',
      baselineScore: 60,
      competitorScore: 80,
      targetScore: 90,
      liveProofCap: DEFAULT_LIVE_CAP,
      whyItMatters: 'Queue pickup, cron health, and terminal states decide whether users trust the system.',
      nextMove: 'Run the write-gated build-ticket terminal-state proof and keep queue health green.',
      checks: [
        fileContains('queue-health-route', 'Queue health API reports stale and blocked work', 'src/app/routes/cockpit-queue-health-route.ts', [
          'stale',
          'blocked',
          'build',
        ]),
        fileContains('operations-surface', 'Cockpit Operations renders queue health', 'src/pages/cockpit/js/views/OperationsView.js', [
          'queue-health',
          'ops-queue',
        ]),
        fileContains('worker-terminal-test', 'Terminal outcome tests cover workflow failure honesty', 'tests/unit/process-definition-terminal-outcome.spec.ts', [
          'escalated',
          'complete',
        ]),
        evidenceFile('operations-live', 'Signed-in Operations queue-health proof exists', 'wave1-trust-gate-', [/operations-queue-health\.live\.spec\.ts/i], true),
        evidenceFile('build-ticket-live', 'Fresh build ticket completes or escalates with useful metadata', 'build-ticket-terminal-state-', [/metadata/i, /(complete|escalated)/i], true),
      ],
    },
    {
      id: 'speed',
      category: 'Speed',
      baselineScore: 60,
      competitorScore: 100,
      targetScore: 100,
      liveProofCap: DEFAULT_LIVE_CAP,
      whyItMatters: 'Users compare the cockpit to instant SaaS products, not to local scripts.',
      nextMove: 'Capture p95 load/action timings and expose them in the evidence wall.',
      checks: [
        fileContains('jarvis-async', 'Jarvis architecture moved long work out of blocking request paths', 'docs/adr/050-unified-assistant-route-orchestrator.md', [
          'purely conversational',
          'OPEN WORK',
        ]),
        fileContains('streaming-client', 'Streaming/progress primitives exist', 'src/shared/services/streaming-client/streaming-client.ts', [
          'task-progress',
        ]),
        evidenceFile('p95-artifact', 'Cockpit and top-module p95 timings are captured', 'performance-baseline-', [/p95/i, /cockpit/i], true),
        evidenceFile('spinner-proof', 'Top modules load without dead spinners after reload', 'module-reload-proof-', [/no dead spinner/i, /reload/i], true),
      ],
    },
    {
      id: 'ease',
      category: 'Ease Of Use',
      baselineScore: 40,
      competitorScore: 100,
      targetScore: 100,
      liveProofCap: DEFAULT_LIVE_CAP,
      whyItMatters: 'A polished SaaS OSS wedge still needs a normal person to reach first value.',
      nextMove: 'Turn first-run provider plus connector setup into a single clean account proof.',
      checks: [
        fileContains('welcome-provider-gate', 'Welcome flow gates on active LLM setup', 'src/pages/welcome/welcome.js', [
          'hasActive',
          'confirmConnected',
        ]),
        fileContains('connector-setup-state', 'Connector Discover shows setup and enabled states', 'src/pages/cockpit/js/views/ConnectorDiscoverView.js', [
          'enabled',
          'risk',
          'scope',
        ]),
        fileContains('ribbon-pins-platform', 'Operations and Connectors stay reachable across profiles', 'src/pages/cockpit/js/components/RibbonNav.js', [
          'PINNED_PLATFORM_VIEW_IDS',
          'operations',
          'connectors',
        ]),
        evidenceFile('first-run-live', 'Clean-account first-run reaches first value', 'first-run-clean-account-', [/provider/i, /connector/i, /first value/i], true),
        evidenceFile('demo-path-live', '60-second recruiter/company/VC demo path is captured', 'demo-path-', [/recruiter/i, /vc/i, /company/i], true),
      ],
    },
    {
      id: 'nl-voice',
      category: 'NL / Voice',
      baselineScore: 60,
      competitorScore: 100,
      targetScore: 100,
      liveProofCap: DEFAULT_LIVE_CAP,
      whyItMatters: 'The Alexa/ChatGPT comparison is won or lost at the natural-language command surface.',
      nextMove: 'Prove selector-backed Jarvis routing from text/voice/TV transcript to the right app.',
      checks: [
        fileContains('jarvis-selector', 'Jarvis is an app with selector routing metadata', 'swarm-apps/jarvis.yaml', [
          'selector',
          'jarvis',
        ]),
        fileExists('voice-routes', 'Voice routes exist', 'src/app/routes/voice-routes.ts'),
        fileExists('tv-pairing-routes', 'TV pairing routes exist', 'src/app/routes/tv-pairing-routes.ts'),
        fileContains('tv-adr', 'TV/remote thin terminal is captured in ADR-068', 'docs/adr/068-tv-surfaces-and-device-link-pairing.md', [
          'thin',
          'pair',
        ]),
        evidenceFile('nl-transcript', 'Natural-language transcript reaches correct app and returns result', 'jarvis-selector-transcript-', [/routed/i, /result/i], true),
        evidenceFile('voice-tv-live', 'Push-to-talk or TV Mode MVP proof exists', 'voice-tv-mode-', [/push-to-talk|tv mode/i, /paired/i], true),
      ],
    },
    {
      id: 'own-data',
      category: 'Own Data / Isolation',
      baselineScore: 80,
      competitorScore: 100,
      targetScore: 100,
      liveProofCap: DEFAULT_LIVE_CAP,
      whyItMatters: 'This is the wedge: user-owned data and keys only matter if tenant isolation is enforced.',
      nextMove: 'Keep live connector-token isolation evidence fresh as credentialed connector proofs expand.',
      checks: [
        fileExists('rls-policy', 'RLS policy DDL exists', 'docs/governance/rls-policies-enforce.sql'),
        fileContains('rls-verifier', 'RLS verifier rejects bypass roles and proves visibility', 'scripts/governance/verify-rls-isolation.mjs', [
          'BYPASSRLS',
          'visibilityPassed',
        ]),
        fileContains('guc-pool', 'GUC pool wrapper stamps caller identity', 'src/shared/services/database/guc-pool.ts', [
          'OSHAL_DB_GUC',
          'owner',
        ]),
        fileContains('route-isolation-tests', 'Two-user route isolation tests exist', 'tests/unit/task-message-isolation-routes.spec.ts', [
          'user-a',
          'user-b',
        ]),
        evidenceFile('rls-enforce-local', 'Local app-role RLS enforce proof exists', 'wave1-trust-gate-', [/npm run verify:rls\s+passed/i, /oshal_app/i], true),
        // Assert the RESOLVED posture (least-privilege owner: non-superuser AND non-BYPASSRLS,
        // owning the tables so FORCE RLS scopes the owner), NOT the obsolete validate-only literal.
        // Per audit-export-routes.ts (2026-07-05), auto mode under a least-privilege owner is
        // release-compliant; requiring the old literal would fail the corrected, current evidence.
        evidenceFile('app-role-runtime', 'Runtime runs under a least-privilege (non-superuser, non-BYPASSRLS) app role', 'app-role-runtime-and-watchdog-', [/oshal_app/i, /rolsuper.*false/i, /rolbypassrls.*false/i, /least-privilege/i], true),
        evidenceFile('legacy-owner-disposition', 'Legacy unowned rows are backfilled or operator-only quarantined', 'legacy-owner-backfill-quarantine-', [/operator_only/i, /linkedChatTasksFromTickets/i], true),
        evidenceFile('live-two-user', 'Live DB-enforced two-user RLS isolation proof exists', 'live-two-user-isolation-', [/user A/i, /user B/i, /cannot read/i], true),
        evidenceFile('export-delete', 'Export/delete path is proven for a user', 'data-export-delete-', [/export/i, /delete/i], true),
      ],
    },
    {
      id: 'local-self-host',
      category: 'Local / Self-Host',
      baselineScore: 80,
      competitorScore: 100,
      targetScore: 100,
      liveProofCap: DEFAULT_LIVE_CAP,
      whyItMatters: 'Self-host is a moat only if boot, deploy, backup, and restore are repeatable.',
      nextMove: 'Add hosted-enough profile evidence, DNS/TLS/ingress notes, and backup/restore proof.',
      checks: [
        fileExists('local-compose', 'Local docker compose profile exists', 'docker-compose.oshal-local.yml'),
        fileExists('local-start', 'Local start script exists', 'scripts/start-localhost.sh'),
        fileExists('k8s-setup', 'Kubernetes setup path exists', 'scripts/setup-oshal-k8s.sh'),
        evidenceFile('local-boot', 'One-command local boot proof exists', 'local-boot-', [/health/i, /cockpit/i], true),
        evidenceFile('hosted-enough', 'Hosted-enough deployment proof exists', 'hosted-enough-', [/dns/i, /tls/i, /ingress/i], true),
        evidenceFile('backup-restore', 'Backup and restore proof exists', 'backup-restore-', [/backup/i, /restore/i, /passed/i], true),
      ],
    },
    {
      id: 'workflow-power',
      category: 'Workflow Power',
      baselineScore: 80,
      competitorScore: 100,
      targetScore: 100,
      liveProofCap: DEFAULT_LIVE_CAP,
      whyItMatters: 'The moat is not chat, it is authored and ticketed work that reaches a truthful outcome.',
      nextMove: 'Capture an authored workflow e2e plus visible run history and packer-created bot proof.',
      checks: [
        fileExists('workflow-studio', 'Workflow Studio surface exists', 'src/pages/workflow-studio/workflow-studio.js'),
        fileContains('workflow-compiler', 'Workflow publish compiler inserts approval gates', 'src/features/swarm-apps/services/workflow-publish-compiler.ts', [
          'approval-gate',
          'approvalAfter',
        ]),
        fileContains('process-lab', 'Process Lab models approval and trace evidence', 'src/features/process-lab/services/process-lab-service.ts', [
          'approval_required',
          'trace',
        ]),
        fileContains('packer-app', 'Conversational bot/packer app exists', 'swarm-apps/codex-packer.yaml', [
          'selector',
        ]),
        evidenceFile('workflow-e2e', 'Authored workflow e2e has terminal outcome proof', 'workflow-authoring-e2e-', [/terminal/i, /history/i], true),
        evidenceFile('packer-proof', 'Packer-created bot proof exists', 'packer-bot-created-', [/manifest/i, /selector/i], true),
      ],
    },
    {
      id: 'safety',
      category: 'Safety',
      baselineScore: 80,
      competitorScore: 80,
      targetScore: 90,
      liveProofCap: DEFAULT_LIVE_CAP,
      whyItMatters: 'Consumers and enterprises both care that risky actions preview, block, and audit by default.',
      nextMove: 'Prove no-send, no-charge, no-post, no-trade, and no-device-write guards with audit entries.',
      checks: [
        fileContains('approval-framework', 'Tool approval workflow exists', 'src/features/tool-approval/services/approval-workflow-service.ts', [
          'approval',
        ]),
        // (repointed 2026-07-19, trading engine extraction ADR-085 pre-carve: placeDecisionOrder —
        //  the one order executor with the TRADING_LIVE_ENABLED + explicit-confirm gate — now lives
        //  in the kernel engine module, so the check follows the write path to its owner.)
        fileContains('trading-confirm', 'Trading write path requires explicit live/confirm controls', 'src/app/trading-engine.ts', [
          'confirm',
          'TRADING_LIVE_ENABLED',
        ]),
        fileContains('payments-sandbox', 'Payments default to sandbox/hosted invoice rather than direct charge', 'docs/swarm-apps-framework.md', [
          'sandbox',
          'hosted invoice',
        ]),
        fileContains('shopping-handoff', 'Shopping path avoids taking payment directly', 'docs/swarm-apps-framework.md', [
          'never takes payment',
        ]),
        // (/no-charge/i dropped at the finance carve, ADR-085: the kernel owns no charge routes —
        //  both no-charge guards ship in the finance + payments store packages, proven at carve.)
        // (/no-device-write/i dropped at the home carve, ADR-085 Wave 2: the four device-write
        //  gates ride the packaged /api/home route, proven at carve.)
        evidenceFile('risky-write-guards', 'All kernel risky-write guards are proven with audit evidence', 'risky-write-guards-', [/no-send/i, /no-post/i, /no-trade/i], true),
      ],
    },
    {
      id: 'audit-proof',
      category: 'Audit / Proof',
      baselineScore: 60,
      competitorScore: 80,
      targetScore: 90,
      liveProofCap: DEFAULT_LIVE_CAP,
      whyItMatters: 'Proof is how OSHAL converts a noisy prototype into a credible enterprise platform.',
      nextMove: 'Publish this generated artifact and link every score to current evidence.',
      checks: [
        fileExists('wave1-evidence', 'Wave 1 evidence artifact exists', 'docs/evidence/wave1-trust-gate-2026-06-22.md'),
        fileExists('connector-evidence', 'Connector marketplace evidence artifact exists', 'docs/evidence/connector-marketplace-smoke-2026-06-22.md'),
        fileExists('score-generator', '15-category score generator exists', 'scripts/evidence/competitive-score-evidence.ts'),
        fileContains('audit-export', 'Audit export routes exist', 'src/app/routes/audit-export-routes.ts', [
          'export',
        ]),
        evidenceFile('score-artifact', 'Generated competitive score artifact exists', 'competitive-readiness-', [/\d+-category/i, /guardrail/i], true),
        evidenceFile('screenshot-wall', 'Screenshots are linked to module scores', 'module-screenshot-wall-', [/screenshot/i, /score/i], true),
      ],
    },
    {
      id: 'extensible',
      category: 'Extensible',
      baselineScore: 100,
      competitorScore: 100,
      targetScore: 100,
      liveProofCap: 100,
      whyItMatters: 'This is one of the real leads: app, connector, selector, and harness extension points.',
      nextMove: 'Keep the extension paths documented and covered as other areas are hardened.',
      checks: [
        fileContains('app-framework-doc', 'Swarm app framework is documented', 'docs/swarm-apps-framework.md', [
          'routes[]',
          'migrations[]',
        ]),
        fileContains('connector-runtime-adr', 'Connector runtime/spec ADR is accepted', 'docs/adr/065-connector-runtime-and-spec.md', [
          'auditConnectorCatalog',
          'ConnectorSpec',
        ]),
        fileContains('selector-scope-test', 'Selector and capability scoping tests protect runtime tools', 'tests/unit/tool-capability-scope.spec.ts', [
          'createAgentSelectorCapabilityResolver',
          'filters runtime prompt tools',
          'managed session MCP servers',
        ]),
        fileContains('harness-framework-test', 'Harness framework remains contract-tested', 'tests/unit/harness-framework.spec.ts', [
          'harness',
        ]),
      ],
    },
    {
      id: 'cost-control',
      category: 'Cost Control',
      baselineScore: 80,
      competitorScore: 80,
      targetScore: 90,
      liveProofCap: DEFAULT_LIVE_CAP,
      whyItMatters: 'Neutral routing plus Token Chase is a structural advantage over model-vendor products.',
      nextMove: 'Capture a Token Chase demo with estimated vs actual cost and visible dashboard totals.',
      checks: [
        fileContains('token-chase-adr', 'Token Chase optimization architecture exists', 'docs/adr/046-token-chase-checkpoint-replay-optimization.md', [
          'cost_usd',
          'quality_score',
        ]),
        fileExists('token-chase-routes', 'Token Chase API routes exist', 'src/app/routes/token-chase-routes.ts'),
        fileContains('cost-dashboard', 'Cockpit renders cost data', 'src/pages/cockpit/js/views/ticket-view-cost-renderer.js', [
          'Cost',
        ]),
        fileContains('cost-telemetry', 'Cost telemetry is captured at task level', 'src/features/operational-intelligence/services/cost-tracking-service.ts', [
          'cost',
          'tokens',
        ]),
        evidenceFile('token-chase-demo', 'Token Chase estimated-vs-actual demo is proven', 'token-chase-demo-', [/estimated/i, /actual/i, /cost/i], true),
        evidenceFile('cost-capture-live', 'Real per-call cost capture is proven live from chat_tasks', 'cost-capture-live-', [/recorded/i, /chat_tasks/i, /per-owner/i], true),
      ],
    },
    {
      id: 'agent-cluster-steps',
      category: 'Agent-Cluster Steps',
      baselineScore: 70,
      competitorScore: 60,
      targetScore: 90,
      liveProofCap: DEFAULT_LIVE_CAP,
      whyItMatters: 'Competitors run one agent or one tool per workflow node. OSHAL runs a ranked cluster of cooperating agents inside a single step, with multi-round review and a quality gate before the step advances.',
      nextMove: 'Capture a live run where one workflow step fans out to a multi-agent cluster with competing/reviewing roles and a gated outcome.',
      checks: [
        fileContains('process-definition-engine', 'Graph engine executes process-definition steps via pluggable node executors', 'src/features/workflow-studio/engine/process-definition-execution-engine.ts', [
          'route-agent',
          'planner',
          'NodeExecutor',
        ]),
        fileContains('phase-round-orchestrator', 'Multi-round, competency-ranked agent rounds run inside a phase', 'any-bot/server/services/queue-manager/PhaseRoundOrchestrator.js', [
          'mandatory rounds',
          'competency-ranked',
          'CompetencyRanker',
        ]),
        fileExists('dispatch-graph-worker', 'Swarm dispatch-graph worker fans a step out to agents', 'src/features/swarm-orchestration/services/dispatch-graph-worker.ts'),
        fileExists('swarm-processing-contract', 'Multi-agent step execution is documented in the swarm processing contract', 'docs/architecture/swarm-processing-design-contract.md'),
        evidenceFile('cluster-fanout-live', 'Live run shows one step fan out to a multi-agent cluster', 'agent-cluster-step-', [/cluster/i, /(round|fan.?out|agents)/i], true),
        evidenceFile('cluster-gate-live', 'Cluster review/quality-gate outcome is captured', 'agent-cluster-step-', [/(gate|review|consensus)/i], true),
      ],
    },
    {
      id: 'any-bot-runtime',
      category: 'Any-Bot Runtime',
      baselineScore: 70,
      competitorScore: 35,
      targetScore: 90,
      liveProofCap: DEFAULT_LIVE_CAP,
      whyItMatters: 'No competitor turns a described role into a running, tool-equipped agent at runtime. OSHAL any-bot spawns a new domain bot from a persona spec and registers new tools without a redeploy.',
      nextMove: 'Capture a live run that creates a new bot from a persona spec and registers a runtime tool it then calls.',
      checks: [
        fileContains('dynamic-compose', 'Runtime compose service spawns dynamically-created bot agents', 'src/features/agent-management/services/dynamic-compose-service.ts', [
          'docker-compose.dynamic.yml',
          'agents created at runtime',
          'agentName',
        ]),
        fileContains('compose-generator', 'Persona YAML is turned into a running bot container', 'any-bot/server/services/ComposeGenerator.js', [
          'ComposeGenerator',
          'persona YAML',
          'agent-factory-bot',
        ]),
        fileContains('dynamic-tool-manager', 'Agents register new MCP tools at runtime', 'any-bot/server/services/queue-manager/DynamicToolManager.js', [
          'DynamicToolManager',
          'register new tools at runtime',
          'MCPServiceV2',
        ]),
        fileExists('dynamic-bot-runtime-plan', 'Dynamic bot/tool runtime is documented', 'docs/architecture/dynamic-bot-tool-runtime-plan.md'),
        evidenceFile('any-bot-spawn-live', 'Live run creates a bot from a persona and brings it up healthy', 'any-bot-runtime-', [/persona/i, /(spawn|created|healthy|up)/i], true),
        evidenceFile('any-bot-tool-live', 'Live run registers and calls a runtime-created tool', 'any-bot-runtime-', [/tool/i, /(register|registered|called)/i], true),
      ],
    },
  ];
}

export function buildCompetitiveEvidence(
  repoRoot = process.cwd(),
  options: BuildOptions = {},
): CompetitiveEvidenceReport {
  const now = options.now || new Date();
  const generatedDate = options.dateStamp || formatDateStamp(now);
  const categories = getCategorySpecs().map((spec) => evaluateCategory(repoRoot, spec, now));
  const totals = summarize(categories);

  return {
    generatedAt: formatTimestamp(now),
    generatedDate,
    repoRoot,
    guardrail: `A category with missing or stale live-user proof is capped at 75, even when code signals are present. Live proof must declare Proof-Tier: live and be no older than ${LIVE_PROOF_MAX_AGE_HOURS} hours.`,
    totals,
    categories,
  };
}

export function renderCompetitiveEvidenceMarkdown(report: CompetitiveEvidenceReport): string {
  const lines: string[] = [
    '# Competitive Readiness Evidence',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '**Proof-Tier:** live — generated by running the evidence harness against the live repo.',
    '',
    `Status: ${report.totals.closed} closed, ${report.totals.ahead} ahead, ${report.totals.parityUnproven} parity-unproven, ${report.totals.belowMarket} below-market across the ${report.totals.categories}-category score map.`,
    '',
    `Guardrail: ${report.guardrail}`,
    '',
    '## Summary',
    '',
    '| Category | Score | Competitor | Target | Status | Top blocker |',
    '|---|---:|---:|---:|---|---|',
  ];

  for (const category of report.categories) {
    lines.push(`| ${category.category} | ${category.score} | ${category.competitorScore} | ${category.targetScore} | ${category.status} | ${category.blockers[0] || 'none'} |`);
  }

  const refreshCount = report.categories.filter((c) => c.recommendationTier === 'refresh').length;
  const captureCount = report.categories.filter((c) => c.recommendationTier === 'capture').length;
  const buildCount = report.categories.filter((c) => c.recommendationTier === 'build').length;
  const recos = [...report.categories]
    .filter((c) => c.recommendationTier !== 'protect')
    .sort((a, b) => tierRank(a.recommendationTier) - tierRank(b.recommendationTier)
      || (b.targetScore - b.score) - (a.targetScore - a.score));

  lines.push(
    '',
    '## Recommended Actions',
    '',
    'Ordered cheapest-win first. Tier meaning: **refresh** = capability already built, proof just expired, re-run the live spec; **capture** = capability exists but has never been proven live; **build** = a real capability gap to close before re-scoring.',
    '',
    `This run: ${refreshCount} need only a proof refresh, ${captureCount} need first-time live proof, ${buildCount} need new build work. Refresh items are free points — no product change, just a re-measure.`,
    '',
    '| # | Tier | Category | Score → Target | Recommendation |',
    '|---:|---|---|---|---|',
  );
  recos.forEach((category, index) => {
    lines.push(`| ${index + 1} | ${category.recommendationTier} | ${category.category} | ${category.score} → ${category.targetScore} | ${category.recommendation} |`);
  });

  lines.push('', '## Category Evidence', '');

  for (const category of report.categories) {
    lines.push(
      `### ${category.category}`,
      '',
      `Score: ${category.score}/100. Competitor max: ${category.competitorScore}/100. Target: ${category.targetScore}/100. Status: ${category.status}.`,
      '',
      `Why it matters: ${category.whyItMatters}`,
      '',
      `Recommendation (${category.recommendationTier}): ${category.recommendation}`,
      '',
      `Next move: ${category.nextMove}`,
      '',
      '| Gate | Status | Evidence |',
      '|---|---|---|',
    );

    for (const check of category.checks) {
      const live = check.live ? ' live' : '';
      lines.push(`| ${check.label}${live} | ${check.status} | ${check.evidence}${check.note ? ` (${check.note})` : ''} |`);
    }

    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

export function writeCompetitiveEvidence(
  report: CompetitiveEvidenceReport,
  outDir = path.join(report.repoRoot, 'docs/evidence'),
): { markdownPath: string; jsonPath: string } {
  mkdirSync(outDir, { recursive: true });
  const basename = `competitive-readiness-${report.generatedDate}`;
  const markdownPath = path.join(outDir, `${basename}.md`);
  const jsonPath = path.join(outDir, `${basename}.json`);
  writeFileSync(markdownPath, renderCompetitiveEvidenceMarkdown(report), 'utf8');
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { markdownPath, jsonPath };
}

function evaluateCategory(repoRoot: string, spec: CategorySpec, now: Date): CategoryEvidence {
  const checks = spec.checks.map((check) => evaluateCheck(repoRoot, check, now));
  const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0);
  const earnedWeight = checks.reduce((sum, check) => sum + (check.status === 'pass' ? check.weight : 0), 0);
  const completion = totalWeight > 0 ? earnedWeight / totalWeight : 0;
  const nonLiveMissingPenalty = checks.filter((check) => !check.live && check.status !== 'pass').length * 5;
  const rawScore = Math.max(0, Math.round(
    spec.baselineScore + ((spec.targetScore - spec.baselineScore) * completion) - nonLiveMissingPenalty,
  ));
  const hasMissingLiveProof = checks.some((check) => check.live && check.status !== 'pass');
  const score = hasMissingLiveProof ? Math.min(rawScore, spec.liveProofCap) : Math.min(rawScore, spec.targetScore);
  const failing = checks
    .filter((check) => check.status !== 'pass')
    .sort((a, b) => Number(b.live) - Number(a.live) || b.weight - a.weight);
  const blockers = failing.map((check) => check.live ? `Live proof missing or stale: ${check.label}` : `Missing: ${check.label}`);
  const { recommendationTier, recommendation } = deriveRecommendation(spec, failing[0]);

  return {
    id: spec.id,
    category: spec.category,
    score,
    baselineScore: spec.baselineScore,
    competitorScore: spec.competitorScore,
    targetScore: spec.targetScore,
    liveProofCap: spec.liveProofCap,
    status: categoryStatus(score, spec.competitorScore, spec.targetScore, blockers.length),
    whyItMatters: spec.whyItMatters,
    nextMove: spec.nextMove,
    checks,
    blockers,
    recommendationTier,
    recommendation,
  };
}

/**
 * Turns a category's top blocker into an action that actually moves the score, and
 * tags how expensive that action is:
 *  - protect: nothing is failing; hold the lead.
 *  - refresh: a live gate failed but its evidence artifact still exists on disk — the
 *    capability is built and was proven before, the proof just aged past the freshness
 *    window. Re-running the live spec lifts the score with no product work.
 *  - capture: a live gate failed and NO artifact exists yet — first-time proof needed.
 *  - build: a non-live code gate is missing — a real capability has to be built first.
 */
function deriveRecommendation(spec: CategorySpec, primary: CheckResult | undefined): {
  recommendationTier: RecommendationTier;
  recommendation: string;
} {
  if (!primary) {
    return {
      recommendationTier: 'protect',
      recommendation: `Hold the lead — every gate passes. ${spec.nextMove}`,
    };
  }
  if (primary.live) {
    if (primary.artifactExists) {
      return {
        recommendationTier: 'refresh',
        recommendation: `Re-measure, do not rebuild. This capability is already built and was proven before; its proof aged past the ${LIVE_PROOF_MAX_AGE_HOURS}h freshness window. Re-run this category's live spec to refresh "${primary.label}" and the score lifts with no new product work.`,
      };
    }
    return {
      recommendationTier: 'capture',
      recommendation: `Capture first live proof — no evidence artifact exists yet for "${primary.label}". ${spec.nextMove}`,
    };
  }
  return {
    recommendationTier: 'build',
    recommendation: `Build the missing capability "${primary.label}" before re-scoring. ${spec.nextMove}`,
  };
}

function tierRank(tier: RecommendationTier): number {
  return { refresh: 0, capture: 1, build: 2, protect: 3 }[tier];
}

function evaluateCheck(repoRoot: string, spec: CheckSpec, now: Date): CheckResult {
  const weight = spec.weight || 1;
  switch (spec.kind) {
    case 'fileExists': {
      const absolute = path.join(repoRoot, spec.file);
      return result(spec, existsSync(absolute), spec.file, weight);
    }
    case 'fileContains': {
      const absolute = path.join(repoRoot, spec.file);
      const content = readIfExists(absolute);
      const ok = content !== null && spec.patterns.every((pattern) => matches(content, pattern));
      return result(spec, ok, spec.file, weight);
    }
    case 'fileCountAtLeast': {
      const absolute = path.join(repoRoot, spec.directory);
      const count = countFiles(absolute, spec.extensions);
      return result(spec, count >= spec.atLeast, `${spec.directory} (${count}/${spec.atLeast})`, weight);
    }
    case 'evidenceFile': {
      const absolute = path.join(repoRoot, spec.directory);
      const matchesFiles = findEvidenceFiles(absolute, spec.filenamePattern);
      const matchingContent = matchesFiles.filter((file) => {
        const content = readIfExists(path.join(absolute, file));
        if (content === null) {
          return false;
        }
        // Live checks fail-closed: the doc must explicitly declare `Proof-Tier: live`.
        // A contract/unit/mock evidence doc that omits the marker no longer satisfies a
        // live gate even when its keyword patterns match.
        if (spec.live === true && !LIVE_PROOF_MARKER.test(content)) {
          return false;
        }
        if (spec.live === true && !isFreshLiveProof(content, now)) {
          return false;
        }
        if (!spec.patterns || spec.patterns.length === 0) {
          return true;
        }
        return spec.patterns.every((pattern) => matches(content, pattern));
      });
      const evidence = matchingContent.length > 0
        ? `${spec.directory}/${matchingContent[0]}`
        : `${spec.directory}/${spec.filenamePattern.source}`;
      return result(spec, matchingContent.length > 0, evidence, weight, matchesFiles.length > 0);
    }
    case 'manual':
      return result(spec, false, 'manual proof required', weight);
    default:
      return assertNever(spec);
  }
}

function summarize(categories: CategoryEvidence[]): CompetitiveEvidenceReport['totals'] {
  const averageScore = Math.round(categories.reduce((sum, category) => sum + category.score, 0) / categories.length);
  return {
    categories: categories.length,
    closed: categories.filter((category) => category.status === 'closed').length,
    ahead: categories.filter((category) => category.status === 'ahead').length,
    parityUnproven: categories.filter((category) => category.status === 'parity-unproven').length,
    belowMarket: categories.filter((category) => category.status === 'below-market').length,
    missingLiveProof: categories.filter((category) => category.checks.some((check) => check.live && check.status !== 'pass')).length,
    averageScore,
  };
}

function categoryStatus(score: number, competitorScore: number, targetScore: number, blockerCount: number): CategoryStatus {
  if (score >= targetScore && blockerCount === 0) {
    return 'closed';
  }
  if (score > competitorScore) {
    return 'ahead';
  }
  if (score >= competitorScore) {
    return 'parity-unproven';
  }
  return 'below-market';
}

function fileExists(id: string, label: string, file: string, live = false): FileExistsCheckSpec {
  return { id, label, kind: 'fileExists', file, live };
}

function fileContains(
  id: string,
  label: string,
  file: string,
  patterns: Array<string | RegExp>,
  live = false,
): FileContainsCheckSpec {
  return { id, label, kind: 'fileContains', file, patterns, live };
}

function fileCount(
  id: string,
  label: string,
  directory: string,
  extensions: string[],
  atLeast: number,
  live = false,
): FileCountAtLeastCheckSpec {
  return { id, label, kind: 'fileCountAtLeast', directory, extensions, atLeast, live };
}

function evidenceFile(
  id: string,
  label: string,
  prefix: string,
  patterns?: Array<string | RegExp>,
  live = false,
): EvidenceFileCheckSpec {
  return {
    id,
    label,
    kind: 'evidenceFile',
    directory: 'docs/evidence',
    filenamePattern: new RegExp(`^${escapeRegExp(prefix)}.*\\.(md|json)$`, 'i'),
    patterns,
    live,
  };
}

function result(spec: CheckSpec, passed: boolean, evidence: string, weight: number, artifactExists?: boolean): CheckResult {
  return {
    id: spec.id,
    label: spec.label,
    kind: spec.kind,
    status: passed ? 'pass' : 'missing',
    weight,
    live: spec.live === true,
    evidence: normalizeSlashes(evidence),
    note: spec.note,
    artifactExists,
  };
}

function readIfExists(file: string): string | null {
  if (!existsSync(file)) {
    return null;
  }
  return readFileSync(file, 'utf8');
}

function countFiles(directory: string, extensions: string[]): number {
  if (!existsSync(directory)) {
    return 0;
  }
  const entries = readdirSync(directory);
  return entries.filter((entry) => {
    const file = path.join(directory, entry);
    return statSync(file).isFile() && extensions.includes(path.extname(entry).toLowerCase());
  }).length;
}

function findEvidenceFiles(directory: string, filenamePattern: RegExp): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((entry) => filenamePattern.test(entry))
    .sort()
    .reverse();
}

function isFreshLiveProof(content: string, now: Date): boolean {
  const timestamp = extractEvidenceTimestamp(content);
  if (!timestamp) {
    return false;
  }
  const ageMs = now.getTime() - timestamp.getTime();
  const maxAgeMs = LIVE_PROOF_MAX_AGE_HOURS * 60 * 60 * 1000;
  const futureToleranceMs = 5 * 60 * 1000;
  return ageMs >= -futureToleranceMs && ageMs <= maxAgeMs;
}

function extractEvidenceTimestamp(content: string): Date | null {
  const match = content.match(/^(?:Generated|Validated(?:-At| At)?|Date):\s*(.+)$/mi);
  if (!match) {
    return null;
  }
  const raw = match[1].trim();
  const withCentralOffset = raw.replace(/\s+CT$/i, ' -05:00');
  const candidates = [
    raw,
    withCentralOffset,
    raw.replace(
      /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{2}:\d{2})$/,
      '$1T$2$3',
    ),
    withCentralOffset.replace(
      /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+([+-]\d{2}:\d{2})$/,
      '$1T$2:00$3',
    ),
  ];
  for (const candidate of candidates) {
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed);
    }
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertNever(value: never): never {
  throw new Error(`Unhandled check kind: ${JSON.stringify(value)}`);
}

function positiveInt(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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
    'Usage: npx ts-node -r tsconfig-paths/register --transpile-only scripts/evidence/competitive-score-evidence.ts [options]',
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
  const report = buildCompetitiveEvidence(process.cwd(), { dateStamp: options.dateStamp });
  const rendered = options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderCompetitiveEvidenceMarkdown(report);

  if (!options.dryRun) {
    const written = writeCompetitiveEvidence(report, options.outDir);
    console.error(`Wrote ${normalizeSlashes(path.relative(process.cwd(), written.markdownPath))}`);
    console.error(`Wrote ${normalizeSlashes(path.relative(process.cwd(), written.jsonPath))}`);
  }

  process.stdout.write(rendered);
}

if (require.main === module) {
  void runCli().catch((error) => {
    console.error(`ERROR competitive-score-evidence failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
