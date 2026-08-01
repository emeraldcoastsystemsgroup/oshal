/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Updated fallback bot profiles to use the current default OpenAI Codex model instead of the retired codex-mini-latest identifier
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added agent-profile controller for narrow persisted chat-agent personalization routes
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added legacy-compatible agent identifier aliases for cockpit Session 69 stabilization
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added seed fallback for getAgentProfile so embedded swarmbot chat does not 500 when DB is unavailable
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added research-bot to fallback seed roster after repairing the agent-factory UUID collision
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | P1: Identity drift fix — synced seed profiles with SWARM_BOT_REGISTRY (16 bots), fixed rca-specialist UUID 0009→0016, added 4 missing bots
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Added all 47 legacy bot personas to seed roster so full catalog appears in address book (31 unported as offline)
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | ADR-045 closure: dropped the two PHANTOM rows from the 'oshal' catalog — alert-intake-bot (0b145cab…) and graph-analyst (fc31e1c5…) have no persona YAML and no compose service, so they can never be personified or dispatched, and this list is what a plain deployment actually serves (BOT_CATALOG is unset everywhere, so the fallback resolves to 'oshal'). Also corrected the catalog's tooling comment: it advertised 'OpenSearch search, Memgraph cypher', neither of which exists in this stack — the real surfaces are /api/rag/search and the optional caller-scoped /api/graph tier (ArangoDB/AQL).
 * 10 | maintainer@emeraldcoastsystemsgroup.com | 2026-07-30 23:07:00 | Added
 *   explicit Express RequestHandler annotations to exported controller handlers so committed-HEAD
 *   declaration typechecking stays portable and does not infer transitive @types/qs paths.
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | K2/K3 identity canon (BACKLOG kernel audit): a0…0018 is 'system-architect' in every map (was 'architect-bot' here while dispatch resolved by the other name); the LEGACY unported a0…0034 row is relabeled 'legacy-system-architect' so exactly ONE identity carries the canonical name; self-healing-bot moves a0…030 → a0…056 (030 belongs to codex-packer — the three-way collision made 030's attribution ambiguous). Mirrors registries + compose + migration 100.
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | enrichProfileWithHarness now also returns the EFFECTIVE provider + which tier won (effectiveProvider / effectiveModel / providerSource / providerOverridable / modelOverridable / precedenceNote) via the shared resolveEffectiveBotProvider. Reading /api/agents used to give harnessType and providerId side by side with no indication that the first silently outranks the second, so a cockpit panel could only guess - and a per-bot provider picker that guesses is a picker that lies. Computed server-side from ONE rule; a registry-read failure no longer drops the fields (it falls through and answers from the DB record, which is the honest answer in that case).
 */

import { Request, Response, type RequestHandler } from 'express';
import { BaseController } from '@/app/base-controller';
import {
  BulkAgentProfileRequestSchema,
  UpdateAgentProfileRequestSchema,
} from '@/entities/agent';
import { AgentProfileService } from '../services';
import { validateFile } from '@/shared/api/validation';
import { resolveEffectiveBotProvider } from '@/shared/llm-runtime';

/**
 * @description Controller for dedicated agent-profile persistence endpoints.
 * This separates bot identity/persona-lite fields from the broader `/api/config` document.
 */
export class AgentProfileController extends BaseController {
  constructor(private readonly agentProfileService: AgentProfileService, logger: any) {
    super(logger);
  }

  /**
   * @description GET /api/agents - List lightweight summaries for all persisted agents.
   * Falls back to seed agent definitions when the database is empty or unavailable.
   */
  listAgents: RequestHandler = this.asyncHandler(async (_req: Request, res: Response) => {
    let agents: Array<Record<string, unknown>> = [];
    try {
      const dbAgents = await this.agentProfileService.listAgents();
      agents = dbAgents.map((agent) => ({
        ...enrichProfileWithHarness(String(agent.agentId), agent),
        agent_id: agent.agentId,
      }));
    } catch (error) {
      this.logger.warn({ err: error }, 'Database agent query failed — using seed fallback');
    }

    // Always merge seed roster so disabled/offline bots appear in the address book
    const seedBots = getSeedAgentFallback();
    const liveIds = new Set(agents.map((a: Record<string, unknown>) => String(a.agentId || a.agent_id || '')));
    for (const seed of seedBots) {
      if (!liveIds.has(String(seed.agentId))) {
        agents.push({ ...seed, status: 'offline' });
      }
    }

    return this.success(res, { agents });
  });

  /**
   * @description GET /api/agents/:agentId/profile - Read the persisted profile for one agent.
   * Falls back to a seed-derived stub when the database is unavailable.
   */
  getAgentProfile: RequestHandler = this.asyncHandler(async (req: Request, res: Response) => {
    const agentId = readRouteParam(req.params.agentId);

    let profile: Record<string, unknown> | null = null;
    try {
      profile = await this.agentProfileService.getAgentProfile(agentId);
    } catch (error) {
      this.logger.warn({ err: error, agentId }, 'Database agent profile query failed — using seed fallback');
    }

    if (!profile) {
      const seedProfile = getSeedAgentProfileFallback(agentId);
      if (seedProfile) {
        return this.success(res, { agentId, profile: enrichProfileWithHarness(agentId, seedProfile) });
      }
      return this.notFound(res, `Agent ${agentId} not found`);
    }

    return this.success(res, {
      agentId,
      profile: enrichProfileWithHarness(agentId, profile),
    });
  });

  /**
   * @description PUT /api/agents/:agentId/profile - Persist a narrow agent-profile update.
   */
  updateAgentProfile: RequestHandler = this.asyncHandler(async (req: Request, res: Response) => {
    const agentId = readRouteParam(req.params.agentId);
    const { profile } = UpdateAgentProfileRequestSchema.parse(req.body);
    const updated = await this.agentProfileService.updateAgentProfile(agentId, profile);
    if (!updated) {
      return this.notFound(res, `Agent ${agentId} not found`);
    }

    return this.success(res, {
      agentId,
      profile: updated,
      message: 'Agent profile updated successfully',
    });
  });

  /**
   * @description GET /api/agents/bulk/profile-status - Return per-bot bulk-config eligibility and readiness.
   */
  listBulkConfigStatus: RequestHandler = this.asyncHandler(async (_req: Request, res: Response) => {
    const statuses = await this.agentProfileService.listBulkConfigStatus();
    return this.success(res, { statuses });
  });

  /**
   * @description POST /api/agents/bulk/configure-all - Apply a template profile to all eligible bots.
   */
  configureAllProfiles: RequestHandler = this.asyncHandler(async (req: Request, res: Response) => {
    const { profile, includeExcluded } = BulkAgentProfileRequestSchema.parse(req.body);
    const result = await this.agentProfileService.configureAllProfiles(profile, includeExcluded);
    return this.success(res, {
      result,
      message: `Updated ${result.updatedAgents.length} bot profile(s) using bulk overwrite mode`,
    });
  });

  /**
   * @description POST /api/agents/bulk/configure-all-unset - Apply a template only where target fields are blank.
   */
  configureUnsetProfiles: RequestHandler = this.asyncHandler(async (req: Request, res: Response) => {
    const { profile, includeExcluded } = BulkAgentProfileRequestSchema.parse(req.body);
    const result = await this.agentProfileService.configureUnsetProfiles(profile, includeExcluded);
    return this.success(res, {
      result,
      message: `Updated ${result.updatedAgents.length} bot profile(s) using unset-only mode`,
    });
  });

  /**
   * @description POST /api/agents/:agentId/profile/avatar - Persist a bot avatar image in the agent metadata row.
   */
  uploadAgentAvatar: RequestHandler = this.asyncHandler(async (req: Request, res: Response) => {
    const agentId = readRouteParam(req.params.agentId);
    const file = validateFile(req.file, {
      maxSize: 2 * 1024 * 1024,
      allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    });
    const updated = await this.agentProfileService.updateAgentProfile(agentId, {
      avatarUrl: buildDataUrl(file),
    });

    if (!updated) {
      return this.notFound(res, `Agent ${agentId} not found`);
    }

    return this.success(res, {
      agentId,
      profile: updated,
      message: 'Agent avatar uploaded successfully',
    });
  });
}

/**
 * @description Normalizes a route parameter into a single string.
 * @param value - Raw Express route parameter.
 * @returns Trimmed route value.
 */
function readRouteParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * @description Converts an uploaded avatar image into a DB-persisted data URL payload.
 * @param file - Validated uploaded image file.
 * @returns Data URL string for storage in agent metadata.
 */
function buildDataUrl(file: Express.Multer.File): string {
  return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
}

/**
 * @description Injects `harnessType` and `apiType` from the active swarm registry into a profile object.
 * Called at read time so callers always receive the authoritative harness config without a DB schema change.
 * If the agent is not in the registry, the profile is returned unchanged.
 */
function enrichProfileWithHarness(agentId: string, profile: Record<string, unknown>): Record<string, unknown> {
  let harnessType: string | null = null;
  let apiType: string | null = null;
  let inRegistry = false;
  let registryReadable = false;
  try {
    const { getActiveRegistry } = require('@/app/extensions/swarm/swarm-bot-registry');
    const reg = getActiveRegistry() as Array<{ agentId?: string; harnessType?: string; apiType?: string }>;
    const entry = reg.find((b) => b.agentId === agentId);
    if (entry) {
      inRegistry = true;
      harnessType = entry.harnessType ?? null;
      apiType = entry.apiType ?? null;
    }
    registryReadable = true;
  } catch {
    // Registry unavailable. registryReadable stays false and the resolver FAILS CLOSED: it reports
    // providerSource 'registry-unreadable' with providerOverridable false, because the registry is
    // the highest tier and a failed read is "unknown", not "nothing is pinned". Treating it as the
    // latter would silently promote the DB record and make the cockpit offer a provider control
    // that may be inert.
  }
  // The EFFECTIVE provider is computed server-side, from the one shared rule, so a surface renders
  // an answer instead of reimplementing three files' worth of precedence in browser JavaScript.
  const effective = resolveEffectiveBotProvider({
    harnessType,
    apiType,
    dbProviderId: (profile.providerId as string | null | undefined) ?? null,
    dbModelId: (profile.modelId as string | null | undefined) ?? null,
    registryReadable,
  });
  return {
    ...profile,
    ...(inRegistry ? { harnessType, apiType } : {}),
    effectiveProvider: effective.effectiveProvider,
    effectiveModel: effective.effectiveModel,
    providerSource: effective.providerSource,
    providerOverridable: effective.providerOverridable,
    modelOverridable: effective.modelOverridable,
    precedenceNote: effective.precedenceNote,
  };
}

/**
 * @description Returns hardcoded seed agent summaries matching migration 008/010/011.
 * Used when the database is empty or unavailable so the cockpit bot selector
 * always has agents to display.
 * @returns Array of seed agent summary objects.
 */
/**
 * @description Returns a minimal seed profile for one agent by ID when the database is unavailable.
 * Allows the cockpit embedded chat to bootstrap without a 500.
 * @param agentId - UUID of the requested agent.
 * @returns Seed profile object or null when the agentId is not a known seed agent.
 */
function getSeedAgentProfileFallback(agentId: string): Record<string, unknown> | null {
  /* ── Full 47-bot catalog from ai-lab/bot-personas/ ── */
  const seedMap: Record<string, { name: string; role: string }> = {
    /* ── 16 ported bots (have Docker containers in swarm) ── */
    'a0000000-0000-0000-0000-000000000001': { name: 'project-manager', role: 'project-manager' },
    'a0000000-0000-0000-0000-000000000002': { name: 'code-developer', role: 'developer' },
    'a0000000-0000-0000-0000-000000000003': { name: 'code-reviewer', role: 'reviewer' },
    'a0000000-0000-0000-0000-000000000004': { name: 'documentation-writer', role: 'writer' },
    'a0000000-0000-0000-0000-000000000005': { name: 'test-engineer', role: 'tester' },
    'a0000000-0000-0000-0000-000000000006': { name: 'task-manager', role: 'qa-gatekeeper' },
    'a0000000-0000-0000-0000-000000000007': { name: 'agent-factory', role: 'factory' },
    'a0000000-0000-0000-0000-000000000008': { name: 'devops-bot', role: 'devops-engineer' },
    'a0000000-0000-0000-0000-00000000000a': { name: 'security-auditor-bot', role: 'security-auditor' },
    'a0000000-0000-0000-0000-00000000000b': { name: 'incident-response-bot', role: 'incident-responder' },
    'a0000000-0000-0000-0000-00000000000c': { name: 'research-bot', role: 'research-analyst' },
    'a0000000-0000-0000-0000-00000000000d': { name: 'business-plan-bot', role: 'business-analyst' },
    'a0000000-0000-0000-0000-00000000000e': { name: 'tester-bot', role: 'tester' },
    'a0000000-0000-0000-0000-000000000016': { name: 'rca-specialist', role: 'root-cause-analyst' },
    'a0000000-0000-0000-0000-000000000017': { name: 'presentation-bot', role: 'presenter' },
    'a0000000-0000-0000-0000-000000000018': { name: 'system-architect', role: 'architect' },
    /* ── 31 unported legacy domain bots (available for dynamic activation) ── */
    'a0000000-0000-0000-0000-000000000019': { name: '3d-printing-bot', role: 'manufacturing' },
    'a0000000-0000-0000-0000-00000000001a': { name: 'animatronics-bot', role: 'animatronics' },
    'a0000000-0000-0000-0000-00000000001b': { name: 'daily-standup-summary-bot', role: 'scrum-master' },
    'a0000000-0000-0000-0000-00000000001c': { name: 'data-extraction-bot', role: 'data-engineer' },
    'a0000000-0000-0000-0000-00000000001d': { name: 'drives-specialist-bot', role: 'drives-specialist' },
    'a0000000-0000-0000-0000-00000000001e': { name: 'electrical-specialist-bot', role: 'electrical-engineer' },
    'a0000000-0000-0000-0000-00000000001f': { name: 'email-bot', role: 'communications' },
    'a0000000-0000-0000-0000-000000000020': { name: 'everything-default', role: 'general-purpose' },
    'a0000000-0000-0000-0000-000000000021': { name: 'facebook-bot', role: 'social-media' },
    'a0000000-0000-0000-0000-000000000022': { name: 'gcp-cli-bot', role: 'cloud-engineer' },
    'a0000000-0000-0000-0000-000000000023': { name: 'google-bot', role: 'search-specialist' },
    'a0000000-0000-0000-0000-000000000024': { name: 'hephaestus', role: 'forge-master' },
    'a0000000-0000-0000-0000-000000000025': { name: 'log-analyzer-bot', role: 'log-analyst' },
    'a0000000-0000-0000-0000-000000000026': { name: 'marketing-strategy-bot', role: 'marketing' },
    'a0000000-0000-0000-0000-000000000027': { name: 'motivational-quotes-bot', role: 'motivation' },
    'a0000000-0000-0000-0000-000000000028': { name: 'news-aggregator-bot', role: 'news-analyst' },
    'a0000000-0000-0000-0000-000000000029': { name: 'online-sales-bot', role: 'sales' },
    'a0000000-0000-0000-0000-00000000002a': { name: 'personal-assistant', role: 'assistant' },
    'a0000000-0000-0000-0000-00000000002b': { name: 'personal-finance-bot', role: 'finance' },
    'a0000000-0000-0000-0000-00000000002c': { name: 'physics-bot', role: 'physicist' },
    'a0000000-0000-0000-0000-00000000002d': { name: 'pr-communications-bot', role: 'public-relations' },
    'a0000000-0000-0000-0000-00000000002e': { name: 'robotics-bot', role: 'robotics-engineer' },
    'a0000000-0000-0000-0000-00000000002f': { name: 'scheduler-bot', role: 'scheduler' },
    'a0000000-0000-0000-0000-000000000056': { name: 'self-healing-bot', role: 'self-healing' },
    'a0000000-0000-0000-0000-000000000031': { name: 'slack-bot', role: 'messaging' },
    'a0000000-0000-0000-0000-000000000033': { name: 'small-motors-bot', role: 'motors-specialist' },
    'a0000000-0000-0000-0000-000000000034': { name: 'legacy-system-architect', role: 'system-architect' },
    'a0000000-0000-0000-0000-000000000035': { name: 'video-bot', role: 'video-production' },
    'a0000000-0000-0000-0000-000000000036': { name: 'weather-bot', role: 'weather-analyst' },
    'a0000000-0000-0000-0000-000000000037': { name: 'website-design-bot', role: 'web-designer' },
    'a0000000-0000-0000-0000-000000000038': { name: 'welding-specialist-bot', role: 'welding-specialist' },
  };

  const entry = seedMap[agentId];
  if (!entry) return null;

  // Resolve provider/model from the active swarm bot registry so the fallback
  // reflects the actual harness wiring, not a global default.
  // Registry apiType is the provider; model derives from harness:
  //   claude-code harness → claude-sonnet-4-6
  //   cline harness       → FORCE_LLM_MODEL or gpt-4.1
  let providerId = process.env.LLM_PROVIDER || 'openai-codex';
  let modelId    = process.env.FORCE_LLM_MODEL || process.env.LLM_MODEL || 'gpt-4.1';
  try {
    const { getActiveRegistry } = require('@/app/extensions/swarm/swarm-bot-registry');
    const reg = getActiveRegistry() as Array<{ agentId?: string; harnessType?: string; apiType?: string }>;
    const regEntry = reg.find((b) => b.agentId === agentId);
    if (regEntry?.apiType) {
      providerId = regEntry.apiType;
      if (regEntry.harnessType === 'claude-code') {
        modelId = process.env.CLAUDE_CODE_MODEL ?? 'claude-sonnet-4-6';
      }
    }
  } catch {
    // registry not available in this context — use env defaults
  }

  return {
    displayName: entry.name,
    role: entry.role,
    avatarUrl: '',
    themePreference: 'midnight',
    providerId,
    modelId,
    excludeFromBulkConfig: false,
  };
}

/**
 * Named bot catalogs — select via BOT_CATALOG env var.
 *
 * OSHAL and swarm are completely separate — no overlap by design.
 *   oshal  — incident-automation pipeline bots (monitoring alerts → RCA → remediation)
 *            These bots use curl/OpenSearch/graph tools. No code/review/test tools.
 *   swarm  — software build/review/QA pipeline bots (code, review, test, docs)
 *            These bots use code/file/test tools. No incident/alert tools.
 *   all    — every bot (for standalone OSHAL without deployment context)
 *
 * To switch: set BOT_CATALOG in oshal-config ConfigMap and rollout restart.
 * No code changes needed.
 */
const BOT_CATALOGS: Record<string, Array<{ id: string; name: string; role: string }>> = {
  // ── OSHAL: incident automation only ────────────────────────────────────────
  // Bots that handle the alert → ticket → investigation → remediation pipeline.
  // Tools: execute_command, curl against the swarm's own api (/api/rag/search for corpus
  // retrieval, the optional caller-scoped /api/graph tier for topology — AQL, never Cypher).
  // There is no OpenSearch and no external graph service in this stack.
  // REMOVED 2026-07-29 (ADR-045 closure): `alert-intake-bot` (0b145cab…) and `graph-analyst`
  // (fc31e1c5…) were PHANTOMS — catalog rows with no persona YAML and no compose service, so they
  // could never be personified or dispatched, yet this list IS the default catalog (BOT_CATALOG is
  // unset everywhere, so the fallback below serves 'oshal').
  oshal: [
    { id: 'a0000000-0000-0000-0000-000000000001', name: 'project-manager',         role: 'project-manager' },
    { id: '5ff13e77-3265-4a3d-a39b-eed65767ae26', name: 'remediation-writer', role: 'remediation-writer' },
    { id: 'a0000000-0000-0000-0000-00000000000b', name: 'incident-response-bot',   role: 'incident-responder' },
    { id: 'e0000000-0000-0000-0000-000000000100', name: 'incident-remediation-bot',role: 'incident-remediator' },
    { id: 'a0000000-0000-0000-0000-000000000016', name: 'rca-specialist',          role: 'root-cause-analyst' },
    { id: 'f0000000-0000-0000-0000-000000000001', name: 'queue-bot',               role: 'queue-reviewer' },
    { id: '00000000-0000-4000-8000-000000000032', name: 'OSHAL Chat Agent',        role: 'chat-agent' },
  ],
  // ── Swarm: software build/review pipeline ──────────────────────────────────
  // Bots that handle the ticket → plan → code → review → test → docs pipeline.
  // Tools: file read/write, execute tests, code search, git.
  swarm: [
    { id: 'a0000000-0000-0000-0000-000000000001', name: 'project-manager',      role: 'project-manager' },
    { id: 'a0000000-0000-0000-0000-000000000007', name: 'agent-factory',        role: 'factory' },
    { id: 'a0000000-0000-0000-0000-000000000002', name: 'code-developer',       role: 'developer' },
    { id: 'a0000000-0000-0000-0000-000000000003', name: 'code-reviewer',        role: 'reviewer' },
    { id: 'a0000000-0000-0000-0000-000000000004', name: 'documentation-writer', role: 'writer' },
    { id: 'a0000000-0000-0000-0000-000000000005', name: 'test-engineer',        role: 'tester' },
    { id: 'a0000000-0000-0000-0000-000000000006', name: 'task-manager',         role: 'qa-gatekeeper' },
    { id: 'a0000000-0000-0000-0000-000000000008', name: 'devops-bot',           role: 'devops-engineer' },
    { id: 'a0000000-0000-0000-0000-000000000018', name: 'system-architect',     role: 'architect' },
    { id: 'a0000000-0000-0000-0000-00000000000a', name: 'security-auditor-bot', role: 'security-auditor' },
    { id: 'a0000000-0000-0000-0000-00000000000c', name: 'research-bot',         role: 'research-analyst' },
    { id: 'a0000000-0000-0000-0000-00000000000e', name: 'tester-bot',           role: 'tester' },
    { id: '00000000-0000-4000-8000-000000000032', name: 'OSHAL Chat Agent',     role: 'chat-agent' },
  ],
  all: [
    { id: 'a0000000-0000-0000-0000-000000000001', name: 'project-manager',         role: 'project-manager' },
    { id: 'a0000000-0000-0000-0000-000000000002', name: 'code-developer',          role: 'developer' },
    { id: 'a0000000-0000-0000-0000-000000000003', name: 'code-reviewer',           role: 'reviewer' },
    { id: 'a0000000-0000-0000-0000-000000000004', name: 'documentation-writer',    role: 'writer' },
    { id: 'a0000000-0000-0000-0000-000000000005', name: 'test-engineer',           role: 'tester' },
    { id: 'a0000000-0000-0000-0000-000000000006', name: 'task-manager',            role: 'qa-gatekeeper' },
    { id: 'a0000000-0000-0000-0000-000000000007', name: 'agent-factory',           role: 'factory' },
    { id: 'a0000000-0000-0000-0000-000000000008', name: 'devops-bot',              role: 'devops-engineer' },
    { id: 'a0000000-0000-0000-0000-000000000018', name: 'system-architect',        role: 'architect' },
    { id: 'a0000000-0000-0000-0000-00000000000a', name: 'security-auditor-bot',    role: 'security-auditor' },
    { id: 'a0000000-0000-0000-0000-00000000000b', name: 'incident-response-bot',   role: 'incident-responder' },
    { id: 'a0000000-0000-0000-0000-00000000000c', name: 'research-bot',            role: 'research-analyst' },
    { id: 'a0000000-0000-0000-0000-00000000000d', name: 'business-plan-bot',       role: 'business-analyst' },
    { id: 'a0000000-0000-0000-0000-00000000000e', name: 'tester-bot',              role: 'tester' },
    { id: 'a0000000-0000-0000-0000-000000000016', name: 'rca-specialist',          role: 'root-cause-analyst' },
    { id: 'a0000000-0000-0000-0000-000000000017', name: 'presentation-bot',        role: 'presenter' },
    { id: 'a0000000-0000-0000-0000-000000000019', name: '3d-printing-bot',         role: 'manufacturing' },
    { id: 'a0000000-0000-0000-0000-00000000001a', name: 'animatronics-bot',        role: 'animatronics' },
    { id: 'a0000000-0000-0000-0000-00000000001b', name: 'daily-standup-summary-bot', role: 'scrum-master' },
    { id: 'a0000000-0000-0000-0000-00000000001c', name: 'data-extraction-bot',     role: 'data-engineer' },
    { id: 'a0000000-0000-0000-0000-00000000001d', name: 'drives-specialist-bot',   role: 'drives-specialist' },
    { id: 'a0000000-0000-0000-0000-00000000001e', name: 'electrical-specialist-bot', role: 'electrical-engineer' },
    { id: 'a0000000-0000-0000-0000-00000000001f', name: 'email-bot',               role: 'communications' },
    { id: 'a0000000-0000-0000-0000-000000000020', name: 'everything-default',      role: 'general-purpose' },
    { id: 'a0000000-0000-0000-0000-000000000021', name: 'facebook-bot',            role: 'social-media' },
    { id: 'a0000000-0000-0000-0000-000000000022', name: 'gcp-cli-bot',             role: 'cloud-engineer' },
    { id: 'a0000000-0000-0000-0000-000000000024', name: 'hephaestus',              role: 'forge-master' },
    { id: 'a0000000-0000-0000-0000-000000000025', name: 'log-analyzer-bot',        role: 'log-analyst' },
    { id: 'a0000000-0000-0000-0000-000000000026', name: 'marketing-strategy-bot',  role: 'marketing' },
    { id: 'a0000000-0000-0000-0000-000000000027', name: 'motivational-quotes-bot', role: 'motivation' },
    { id: 'a0000000-0000-0000-0000-000000000028', name: 'news-aggregator-bot',     role: 'news-analyst' },
    { id: 'a0000000-0000-0000-0000-000000000029', name: 'online-sales-bot',        role: 'sales' },
    { id: 'a0000000-0000-0000-0000-00000000002a', name: 'personal-assistant',      role: 'assistant' },
    { id: 'a0000000-0000-0000-0000-00000000002b', name: 'personal-finance-bot',    role: 'finance' },
    { id: 'a0000000-0000-0000-0000-00000000002c', name: 'physics-bot',             role: 'physicist' },
    { id: 'a0000000-0000-0000-0000-00000000002d', name: 'pr-communications-bot',   role: 'public-relations' },
    { id: 'a0000000-0000-0000-0000-00000000002e', name: 'robotics-bot',            role: 'robotics-engineer' },
    { id: 'a0000000-0000-0000-0000-00000000002f', name: 'scheduler-bot',           role: 'scheduler' },
    { id: 'a0000000-0000-0000-0000-000000000056', name: 'self-healing-bot',        role: 'self-healing' },
    { id: 'a0000000-0000-0000-0000-000000000031', name: 'slack-bot',               role: 'messaging' },
    { id: 'a0000000-0000-0000-0000-000000000033', name: 'small-motors-bot',        role: 'motors-specialist' },
    { id: 'a0000000-0000-0000-0000-000000000034', name: 'legacy-system-architect', role: 'system-architect' },
    { id: 'a0000000-0000-0000-0000-000000000035', name: 'video-bot',               role: 'video-production' },
    { id: 'a0000000-0000-0000-0000-000000000036', name: 'weather-bot',             role: 'weather-analyst' },
    { id: 'a0000000-0000-0000-0000-000000000037', name: 'website-design-bot',      role: 'web-designer' },
    { id: 'a0000000-0000-0000-0000-000000000038', name: 'welding-specialist-bot',  role: 'welding-specialist' },
    { id: 'e0000000-0000-0000-0000-000000000100', name: 'incident-remediation-bot',role: 'incident-remediator' },
    { id: 'f0000000-0000-0000-0000-000000000001', name: 'queue-bot',               role: 'queue-reviewer' },
    { id: '00000000-0000-4000-8000-000000000032', name: 'OSHAL Chat Agent',        role: 'chat-agent' },
  ],
};

function getSeedAgentFallback(): Array<Record<string, unknown>> {
  const now = new Date().toISOString();
  const catalogName = (process.env.BOT_CATALOG || 'oshal').toLowerCase();
  const seed = BOT_CATALOGS[catalogName] ?? BOT_CATALOGS['oshal']!;
  return seed.map((s) => ({
    agentId: s.id,
    agent_id: s.id,
    name: s.name,
    status: 'active',
    providerId: process.env.LLM_PROVIDER || 'openai-codex',
    modelId: process.env.LLM_MODEL || 'gpt-4.1',
    role: s.role,
    projectUrl: '',
    avatarUrl: '',
    themePreference: 'midnight',
    excludeFromBulkConfig: false,
    updatedAt: now,
  }));
}
