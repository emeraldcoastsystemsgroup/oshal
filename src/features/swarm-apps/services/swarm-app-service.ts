/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial SwarmAppService — orchestrates manifest load, toggle, list per ADR
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Simplified synthesiseProfile — single hide-list rule, no focused toggle
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Carry manifest.workflow.autoStart into the registered WorkflowDefinition so auto-start workflows are recognized at dispatch.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | autoLoadAllWithRetry — boot-storm resilience: transient pg connect timeouts during 20-container startup left the in-memory ribbon registry empty (no per-class icons) with no retry
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | synthesiseProfile now emits per-app identity: theme (manifest skin, applied transiently by the cockpit so each app looks distinct without clobbering the operator's global theme) and chatBots ([{agentId,name}] — the app's own declared bots, so the chat selector renders this app's swarm; they run inline on chat so need not be Redis-live).
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Auto-hide the ribbon Tickets item for any app without a ticketType — tickets only belong to an app that owns a queue (cockpit filters to that type); otherwise it would show the whole unfiltered fleet.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | isVisibleToCaller: explicit 'operator' scope arm — admin-only apps (security-center) are hidden from every non-operator listing; operators bypass via listApps, and the RLS public-read policy (063) already excludes non-public rows at the DB layer.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 P1: activate() mounts a package's own compiled-JS routes via an injected ManifestRouteMounter (packageDir = the manifest's own directory); deactivate() unmounts. No-op unless the app declares routes AND a flag-enabled mounter is injected — the framework's hardcoded server.ts mounts stay authoritative by default.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 P2 migration runner: activate() applies a package's OWN migrations/*.sql (package-relative paths only) idempotently, tracked in app_package_migrations, each file in a single-checked-out-client transaction; flag APP_PACKAGE_MIGRATIONS default OFF. Verified by tests/unit/app-package-migrations.spec.ts.
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | findActiveAppByTheme — resolve a packaged app from its bundled skin id so the legacy /cockpit/css/themes/<id>.css contract can fall back to package-bundled CSS (the carve-out deleted core's little-monsters.css and every LM iframe lost its color variables).
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | synthesiseProfile forwards manifest dependencies.connectors as the app's connector allow-list (present = complete set surfaces may offer, [] = none, absent = no filter) — a kids' education app must not prompt for Facebook; the cockpit ribbon pin, marketplace view, and welcome wizard consume it.
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085: (1) activate() registers packaged bots into the ACTIVE bot registry via the injected ManifestBotRegistrar (deactivate retracts — no ghost dispatch); store apps need zero core-registry edits and the boot wiring audit passes. (2) uninstallImpact expands manifest ragCollections globs against live collections; unloadApp({dropData}) deletes them per-name, non-fatally — the §5 data-loss gate, never on toggle-off.
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D11 tool ownership: loadApp fails CLOSED on a tool name another ACTIVE app provides (names are GLOBAL — runtime_tool_executors is keyed by tool_name and upserted ON CONFLICT DO UPDATE, so a duplicate silently REPOINTS the other app's tool; purchasing + travel both declared 'explain-pick', travel sorted last under readdirSync, and the SHOPPING concierge was live-routing to POST /api/travel/chat) and on an unresolvable dependencies.tools. deregisterManifestTools never removes a tool another active app still provides. uninstallImpact reports toolsProvided/toolDependents and unloadApp blocks on them (a dependent BLOCKS; it never RETAINS — retention-by-dependent would let any package pin another app's executor alive past its owner's removal). manifestToolOwner() backs the runtime routes' 409 guard. All derived at query time from active manifests — never from tools.registered_by (first-writer-wins) or the swarm-app:<name> tag (last-writer-wins), which disagree under a collision.
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 1: registerManifestTools substitutes {packageDir} in a manifest cli tool's cliCommand with the package's own directory (the D10 ctx.appPackageDir pattern, applied to the tool path). Substitution happens BEFORE registration on purpose: the cli-command-validator rejects unknown template tokens, so the stored executor is always a concrete path — a packaged CLI tool (first: brand-graphics) can bundle its script instead of shipping it into core scripts/.
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | synthesiseProfile forwards manifest.surface.ops as surfaceOps — the cockpit surface-bridge relay's per-app op allow-list (resolveRelayTarget ctx.allowedOps). Fail-closed at the relay: absent = no ops relayed (deliberately stricter than connectors' absent-=-unfiltered).
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | seedBotAuthorizations resolves persona paths against the package dir first, cwd second. cwd-only resolution sent every packaged bot's persona to /app/<persona> (missing), so the seeder logged "Persona file returned null" and seeded 0 tools for EVERY store-installed app's bots — found live during the brand-graphics carve activation; core manifests (repo-relative ai-lab/ paths) keep the cwd resolution via the fallback.
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | ADR-097: toSummary carries manifest.suite (null for pre-097 packages) so /api/swarm/apps callers — first the applications catalog — can group by primary suite.
 * 18 | maintainer@emeraldcoastsystemsgroup.com   | ADR-090 addendum: activate() registers the app's skillProfiles into the shared registry (applySkillProfiles, keyed by app+ticketType); deactivate() retracts them. Mirrors applyGuestTier — non-fatal, replace-by-app, full teardown on toggle-off so an inactive app holds zero live profiles.
 * 19 | maintainer@emeraldcoastsystemsgroup.com   | De-brand (visible leak): dropped the orphaned legacy-brand key from FRAMEWORK_ITEMS — RibbonNav had no catalog entry for it so it rendered nothing; the retired RCA-demo brand must not appear in the framework ribbon.
 * 20 | maintainer@emeraldcoastsystemsgroup.com   | toSummary now surfaces an `icon` (first static ribbon-tile codicon, else assistant icon, else null) via firstAppIcon() so the /applications console can render a real per-app icon instead of a first-initial placeholder.
 * 21 | maintainer@emeraldcoastsystemsgroup.com   | Forward the manifest-owned hideAssistant policy so immersive app surfaces can suppress redundant global assistant chrome.
 * 22 | maintainer@emeraldcoastsystemsgroup.com   | Status-flip gap (BACKLOG, surfaced by the skill-profiles adversarial review): loadApp on a record whose resulting status is 'inactive' now calls deactivate() — a manifest edit flipping active→inactive used to call NEITHER activate nor deactivate, so the app read status='inactive' while its bots/workflow/tools/schedules/guest-tier/skill-profiles stayed live until a real toggle-off. deactivate() is idempotent, so the boot auto-load of an already-inactive app stays a safe no-op.
 * 23 | maintainer@emeraldcoastsystemsgroup.com   | Reconcile tools removed by an app manifest update before upsert: retire sole-owner executors fail-loud, delete only the app's prior/incoming declared-bot grants for retired names, retain another active app's same-named executor, and fail closed on activation rollback so stale grants cannot reappear when a tool name is later enabled.
 * 24 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: prevent manifest-derived teardown from deleting kernel-owned RAG collections.
 * 25 | maintainer@emeraldcoastsystemsgroup.com   | ADR-118 Phase 2: pass each manifest's opt-in app access declaration to the dynamic route enforcement boundary.
 * 26 | maintainer@emeraldcoastsystemsgroup.com   | ADR-118 Phase 2: cache each route-owning app's access declaration so the global gate covers hard-mounted kernel routes as well as dynamic package routes.
 * 27 | maintainer@emeraldcoastsystemsgroup.com   | Register package-contributed Takeout slices as a fail-closed activation resource and retract them on reload, toggle-off, and uninstall.
 * 28 | maintainer@emeraldcoastsystemsgroup.com   | Forward the manifest schedule target as an explicit prompt or deterministic service-route union so package workers never enter the generic prompt dispatcher.
 * 29 | maintainer@emeraldcoastsystemsgroup.com   | Reconcile retired and execution-class-changed schedules from the previous active manifest before activating its replacement, preventing stale prompt/per-user/service handlers after hot reload.
 * 30 | maintainer@emeraldcoastsystemsgroup.com   | Back under the 1000-code-line hard cap (1082 -> 941). Entries 27-29 pushed this file past it, which fails the BLOCKING gate_lint (eslint max-lines, --max-warnings 0) and would have blocked the branch. Moved out the two groups that were never orchestration: record presentation/visibility to swarm-app-record-view.ts, and manifest-to-runtime translation (tool create-input, selector seed, safe WHERE, interpolation) to swarm-app-manifest-mapping.ts. Verbatim moves behind the same names, so the class body and this module's public exports are unchanged; both tsconfigs typecheck at 0 errors and the manifest specs stay green.
 * 31 | maintainer@emeraldcoastsystemsgroup.com   | Forward ui.static[].group into the synthesised ribbon items. RibbonNav has grouped on this field since the rail-pin work, but synthesiseProfile's static-item map listed the keys it copied, so a manifest declaring `group:` produced an identical flat ribbon with no error anywhere — the silent no-op that made the feature look unimplemented. Forwarded verbatim; the renderer stays the authority on where a heading is allowed.
 * 32 | maintainer@emeraldcoastsystemsgroup.com   | listApps passes its caller to toSummary as the VIEWER, and the new getAppForViewer is the viewer-scoped counterpart to getApp. A public-scoped app keeps the owner_sub stamped at install, so both read paths were serializing the deployment operator's OIDC subject to every caller. The viewer is passed through even when undefined on purpose: global search lists with no caller and matches summary.ownerSub to find a user's own person-scoped apps, so unconditional redaction would have hidden those from their owner.
 * 33 | maintainer@emeraldcoastsystemsgroup.com   | ADR-139 Stage 1: applyArtifactActions on activate / unregister on deactivate — the app's "Send to…" declarations join the shared registry with the skill-profiles discipline (replace-by-app, retract-on-absent, full teardown on toggle-off).
 */

import type { Pool } from 'pg';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import yaml from 'js-yaml';
import { createChildLogger } from '@/shared/logger';
import {
  registerDynamicToolUI,
  deregisterDynamicToolUI,
  registerDynamicToolVisibility,
  deregisterDynamicToolVisibility,
} from '@/app/routes/tool-routes';
import type { AgentProfileRepository } from '@/entities/agent';
import { WorkflowPipelineRegistry } from '@/features/swarm-orchestration';
import { assertGenericRagCollection } from '@/features/rag';
import type { RuntimeToolRegistrationService } from '@/features/tool-registry';
import type { CreateToolInput } from '@/entities/tool';
import { AuthMode, InstallMethod, ToolType } from '@/shared/types/tool';
import {
  appSegmentForPath,
  registerAppGuestTier,
  unregisterAppGuestTier,
  type GuestTier,
} from '@/shared/middleware/guest-capability-matrix';
import {
  registerAppSkillProfiles,
  unregisterAppSkillProfiles,
} from '@/shared/skill-profiles';
import {
  registerAppArtifactActions,
  unregisterAppArtifactActions,
} from '@/shared/artifact-exchange';
import { readManifest, listManifestFiles, serializeManifest } from './swarm-app-loader';
import { firstAppIcon, isVisibleToCaller, maySeeOwnerIdentity, toSummary, type SummaryViewer } from './swarm-app-record-view';
import {
  interpolate,
  manifestToolToCreateInput,
  parseSafeWhere,
  readBotSelectorSeed,
  staticToolNames,
} from './swarm-app-manifest-mapping';
import {
  assertToolNamesUnique,
  assertToolDependenciesResolvable,
  computeToolDependents,
  dependedToolNames,
  providedToolNames,
  type ToolDependent,
} from './tool-ownership';
import { deleteManifestBotToolGrants, deregisterOwnedManifestTools, failClosedManifestActivation, prepareManifestToolUpdate, rollbackNewManifestToolGrants } from './manifest-tool-reconciliation';
import { SwarmAppRepository, type SwarmAppScopeMeta } from './swarm-app-repository';
import type {
  SwarmAppManifest,
  SwarmAppAccessDeclaration,
  SwarmApplicationRecord,
  SwarmApplicationSummary,
  SwarmAppStaticUi,
  SwarmAppDynamicUi,
  SwarmAppAssistant,
  SwarmAppToolDeclaration,
  ManifestScheduleRegistrar,
  ManifestScheduleDeregistrar,
  ManifestRouteMounter,
  ManifestBotRegistrar,
  ManifestTakeoutRegistrar,
  RagCollectionTeardown,
  SwarmAppBotDeclaration,
} from '../types';

const logger = createChildLogger({ module: 'swarm-app-service' });

/**
 * @description Orchestrates swarm application manifests. A manifest bundles
 * bots, tools, UI surfaces, routes, and workflows into a single toggleable
 * unit. Toggling calls through to existing primitives:
 *   - Bot activation   → AgentProfileRepository.updateAgentStatus
 *   - UI activation    → registerDynamicToolUI / deregisterDynamicToolUI
 *   - DB state         → SwarmAppRepository
 *
 * Multiple apps can be active simultaneously. Bot status drives routing
 * (normalizeCandidates excludes inactive), and the ribbon renders the
 * union of every active app's UI surfaces.
 *
 * Deliberately deferred (Phase 2 follow-ups):
 *   - Dynamic route mounting       — hardcoded mounts in server.ts still apply
 *   - Dynamic migration application — migrations stay in scripts/migrations
 *   - Dynamic workflow pipeline    — WORKFLOW_PIPELINES array still static
 */
export class SwarmAppService {
  /**
   * Mount-path → owning app name map. Built from every loaded manifest's
   * routes[] block. Used by the route-gate middleware to answer "is the
   * app that owns this request path active?" without a DB hit per request.
   */
  private readonly mountPathOwnership: Map<string, string> = new Map();

  /**
   * Cached active-status map, keyed by app name. Refreshed on every
   * load/toggle/unload. The gate middleware reads this — avoiding DB
   * roundtrips on the hot path.
   */
  private readonly appStatusCache: Map<string, 'active' | 'inactive'> = new Map();

  /** Access declaration cache for the global hard-mounted route boundary. */
  private readonly appAccessCache: Map<string, SwarmAppAccessDeclaration | undefined> = new Map();

  constructor(
    private readonly pool: Pool,
    private readonly repo: SwarmAppRepository,
    private readonly agentProfileRepo: AgentProfileRepository,
    private readonly runtimeToolRegistrationService?: RuntimeToolRegistrationService,
    /** Seeds a bot's persona allowed_tools into agent_tools so the framework injects the
     *  tool usage into its prompt. Injected (not imported) to respect FSD slice boundaries.
     *  Takes the bot's own persona path so each bot seeds from ITS persona, not the api's. */
    private readonly personaAuthorizationSeeder?: (agentId: string, personaFile?: string) => Promise<number>,
    /** Registers a manifest's framework-scope schedules ("default polls") against the
     *  scheduling service. Injected (not imported) to keep this slice decoupled from
     *  the scheduler. Omitted → schedule registration is a no-op. */
    private readonly scheduleRegistrar?: ManifestScheduleRegistrar,
    /** Mounts a package's own compiled-JS routes at activation (ADR-085 P1). Injected
     *  (not imported) so this slice stays decoupled from `@/app` + Express. Omitted →
     *  route mounting is a no-op (the framework's hardcoded server.ts mounts still apply).
     *  The impl itself is flag-gated, so activation is unchanged unless the operator opts in. */
    private readonly routeMounter?: ManifestRouteMounter,
    /** Tears down the app's registered schedules on deactivate (ADR-085 P0 — a toggled-off
     *  app's polls must STOP billing). Injected beside the registrar; omitted → no-op. */
    private readonly scheduleDeregistrar?: ManifestScheduleDeregistrar,
    /** Contributes the app's bots to the ACTIVE bot registry on activate and retracts
     *  them on deactivate (ADR-085) — packaged bots become dispatchable without core
     *  registry hand-edits. Injected (impl owns @/app registry state); omitted → no-op. */
    private readonly botRegistrar?: ManifestBotRegistrar,
    /** Expands manifest ragCollections for impact + deletes them at dropData uninstall
     *  (ADR-085 §5 + ADR-091). Injected — FSD forbids importing @/features/rag here. */
    private readonly ragTeardown?: RagCollectionTeardown,
    /** Registers package-owned Takeout archive slices while the app is active. Package-module
     * loading stays in the app layer; this feature slice owns only lifecycle reconciliation. */
    private readonly takeoutRegistrar?: ManifestTakeoutRegistrar,
  ) {}

  /**
   * @description Finds the app that owns a given request path. Matches
   * the longest mountPath prefix so `/api/education/class` resolves to
   * the LM manifest even though LM declares `/api/education` as its
   * mount. Returns null if no app claims the path (→ framework-owned,
   * always gated through).
   */
  ownerOf(requestPath: string): {
    appName: string;
    status: 'active' | 'inactive';
    access?: SwarmAppAccessDeclaration;
  } | null {
    let best: { appName: string; mountPath: string } | null = null;
    for (const [mountPath, appName] of this.mountPathOwnership) {
      if (requestPath === mountPath || requestPath.startsWith(mountPath + '/') || requestPath.startsWith(mountPath + '?')) {
        if (!best || mountPath.length > best.mountPath.length) best = { appName, mountPath };
      }
    }
    if (!best) return null;
    const status = this.appStatusCache.get(best.appName) ?? 'inactive';
    return { appName: best.appName, status, access: this.appAccessCache.get(best.appName) };
  }

  /** Rebuilds the ownership + status caches from the DB. Called after every load/toggle/unload. */
  private async refreshOwnershipCache(): Promise<void> {
    this.mountPathOwnership.clear();
    this.appStatusCache.clear();
    this.appAccessCache.clear();
    const all = await this.repo.list();
    for (const r of all) {
      this.appStatusCache.set(r.name, r.status);
      this.appAccessCache.set(r.name, r.manifest.access);
      for (const route of r.manifest.routes ?? []) {
        if (route.mountPath) this.mountPathOwnership.set(route.mountPath, r.name);
      }
    }
  }

  /**
   * @description Reads a manifest from disk, upserts the DB record, and
   * reconciles live registrations to the RESULTING status: active records
   * activate (bots, UI surfaces, workflow, tools, schedules), inactive ones
   * deactivate — so a manifest edit that flips the status actually takes
   * effect on reload, not only on an explicit toggle.
   * @param manifestPath - absolute or cwd-relative path to the YAML file
   * @returns the resulting application record
   */
  async loadApp(manifestPath: string, scopeMeta?: SwarmAppScopeMeta): Promise<SwarmApplicationRecord> {
    const manifest = readManifest(manifestPath);
    // Read the stored revision BEFORE upsert. Once overwritten, names removed from the new
    // manifest are otherwise unknowable and their persisted executor/grants survive forever.
    const previous = await this.repo.findByName(manifest.name);
    await this.assertToolOwnership(manifest);
    const prepared = await prepareManifestToolUpdate(this.pool, previous, manifest,
      (retiredManifest) => this.deregisterManifestTools(retiredManifest, true),
    );
    const toolNames = staticToolNames(manifest);
    const record = await this.repo.upsert(manifest, manifestPath, toolNames, scopeMeta);
    await this.deregisterRetiredManifestSchedules(previous, manifest);
    if (record.status === 'active') {
      try {
        await this.activate(record);
        // Persona seeding happens during activation. Re-apply the exact retired-name tombstone so
        // a stale persona file cannot resurrect an app-bot grant during this update transaction.
        await deleteManifestBotToolGrants(
          this.pool, prepared.retired.agentIds, prepared.retired.toolNames,
        );
      } catch (error) {
        this.appStatusCache.set(record.name, 'inactive');
        await failClosedManifestActivation(record.name, error, [
          () => this.deactivate(record),
          () => this.deregisterManifestTools(record.manifest, true),
          () => rollbackNewManifestToolGrants(this.pool, record.manifest, prepared.priorGrants),
          async () => {
            const inactive = await this.repo.updateStatus(record.name, 'inactive');
            if (!inactive) throw new Error(`Failed to persist inactive status for ${record.name}`);
          },
        ]);
      }
    } else {
      // Status-flip gap (BACKLOG / ADR-090-addendum adversarial review): a manifest edit that
      // flips an app to `status: inactive` re-runs loadApp, and this branch used to do NOTHING —
      // the row read 'inactive' while the app's bots/workflow/tools/schedules/guest-tier/
      // skill-profiles all stayed live until a real toggle-off. Deactivating on the resulting
      // record closes it for every activate-scoped resource at once; deactivate() is idempotent,
      // so the boot auto-load of an already-inactive app remains a safe no-op.
      await this.deactivate(record);
    }
    await this.refreshOwnershipCache();
    logger.info({ name: record.name, status: record.status }, 'App loaded');
    return record;
  }

  /**
   * @description Auto-loads every manifest in swarm-apps/. Used by server
   * boot. Errors on individual manifests are logged but do not abort the
   * boot — a bad manifest shouldn't brick the framework.
   *
   * Also reconciles: any app whose record's manifestPath points at the
   * swarm-apps/ directory but whose YAML file no longer exists on disk is
   * flipped to inactive (bots deactivate, UIs deregister). The DB row
   * stays so the operator can still see/restore it — explicit DELETE
   * purges. This gives clean "drop a YAML to publish / remove it to
   * retire" semantics without destroying history.
   */
  async autoLoadAll(): Promise<{ loaded: string[]; deactivated: string[]; failed: Array<{ path: string; error: string }> }> {
    const files = listManifestFiles();
    const loaded: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    for (const f of files) {
      try {
        const rec = await this.loadApp(f);
        loaded.push(rec.name);
      } catch (err: any) {
        logger.error({ err, path: f }, 'Auto-load failed for manifest');
        failed.push({ path: f, error: err.message });
      }
    }

    const deactivated = await this.reconcileMissingManifests(loaded);
    const agentsCleaned = await this.reconcileAgentsTable(loaded);

    logger.info(
      { loadedCount: loaded.length, deactivatedCount: deactivated.length, failedCount: failed.length, agentsCleaned },
      'Swarm app auto-load complete',
    );
    return { loaded, deactivated, failed };
  }

  /**
   * @description Boot-resilient wrapper around autoLoadAll(). During a
   * full-stack cold start (~20 containers racing Postgres) the pool can
   * throw transient connect timeouts; a single failed pass left the
   * in-memory ribbon registry unpopulated (no app icons, no per-row
   * class icons) until the next manual restart. Re-runs the whole pass —
   * loadApp() upserts and UI registrations are idempotent — until a pass
   * completes with zero failures or attempts are exhausted.
   * @param maxAttempts - total passes to attempt before giving up
   * @param retryDelayMs - wait between passes in milliseconds
   * @returns the result of the last pass that ran
   */
  async autoLoadAllWithRetry(maxAttempts = 3, retryDelayMs = 15000): Promise<{ loaded: string[]; deactivated: string[]; failed: Array<{ path: string; error: string }> }> {
    let last: { loaded: string[]; deactivated: string[]; failed: Array<{ path: string; error: string }> } =
      { loaded: [], deactivated: [], failed: [] };
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        last = await this.autoLoadAll();
        if (last.failed.length === 0) return last;
        logger.warn({ attempt, maxAttempts, failedCount: last.failed.length }, 'Swarm app auto-load pass had failures');
      } catch (err) {
        logger.error({ err, attempt, maxAttempts }, 'Swarm app auto-load pass threw');
        last = { loaded: [], deactivated: [], failed: [{ path: '(whole pass)', error: err instanceof Error ? err.message : String(err) }] };
      }
      if (attempt < maxAttempts) {
        await new Promise<void>(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
    logger.error({ maxAttempts, failedCount: last.failed.length }, 'Swarm app auto-load exhausted retries with failures');
    return last;
  }

  /**
   * @description Reconcile the agents table after manifest load:
   *  1. Deduplicate rows where the same `name` is mapped to multiple agent_ids
   *     (keeping the lowest agent_id for stable selection).
   *  2. Mark every agent that is NOT referenced by any currently-active
   *     manifest as `status = 'inactive'`. This prevents cross-variant
   *     pollution where rca-specialist (incident variant) stays `active`
   *     while only the LM bots are running.
   *
   * Operator-managed bots (those NOT contributed by any loaded manifest)
   * are left alone — their status comes from cockpit edits, not from
   * manifest reconciliation.
   */
  private async reconcileAgentsTable(activeAppNames: string[]): Promise<{ deactivated: number; deduped: number }> {
    let deduped = 0;
    let deactivated = 0;
    try {
      // ── Step 1: dedupe ────────────────────────────────────────────
      const dedupResult = await this.pool.query(
        `DELETE FROM agents a
           USING (
             SELECT name, (array_agg(agent_id ORDER BY agent_id))[1] AS keep_id
             FROM agents
             GROUP BY name
             HAVING COUNT(*) > 1
           ) dup
         WHERE a.name = dup.name AND a.agent_id <> dup.keep_id`,
      );
      deduped = dedupResult.rowCount ?? 0;

      // ── Step 2: collect agent_ids declared by every currently-active manifest ──
      const activeAgents = new Set<string>();
      for (const name of activeAppNames) {
        const rec = await this.repo.findByName(name);
        if (!rec || rec.status !== 'active') continue;
        for (const id of rec.agentIds) activeAgents.add(id);
      }
      // Keep the swarm-controller's own self-agent active (project-manager runs the api).
      activeAgents.add('a0000000-0000-0000-0000-000000000001');
      if (activeAgents.size === 0) {
        return { deactivated: 0, deduped };
      }

      // ── Step 3: deactivate manifest-contributed agents that are no longer active ──
      // Only touch agents whose metadata has manifestApp set (we put that there
      // in upsertBots). This leaves operator-managed bots alone.
      const agentIdsArray = Array.from(activeAgents);
      const deactResult = await this.pool.query(
        `UPDATE agents
           SET status = 'inactive'
         WHERE status = 'active'
           AND (metadata->>'manifestApp' IS NOT NULL OR metadata ? 'manifestApp')
           AND NOT (agent_id::text = ANY($1))`,
        [agentIdsArray],
      );
      deactivated = deactResult.rowCount ?? 0;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Agents-table reconcile failed (non-fatal)');
    }
    return { deactivated, deduped };
  }

  /**
   * @description For each DB row whose manifestPath is inside swarm-apps/
   * but whose file no longer exists on disk, flip status to inactive and
   * tear down its bots/UIs. Only touches rows whose manifestPath matches
   * the swarm-apps/ convention — externally-loaded manifests (via
   * /api/swarm/apps/load) with arbitrary paths are left alone.
   */
  private async reconcileMissingManifests(stillLoadedNames: string[]): Promise<string[]> {
    const kept = new Set(stillLoadedNames);
    const records = await this.repo.list('active');
    const deactivated: string[] = [];
    const fs = await import('fs');
    for (const r of records) {
      if (kept.has(r.name)) continue;
      if (!r.manifestPath.includes('/swarm-apps/')) continue;
      if (fs.existsSync(r.manifestPath)) continue;
      logger.info({ name: r.name, manifestPath: r.manifestPath }, 'Manifest removed from disk — deactivating app');
      await this.toggleApp(r.name, false);
      deactivated.push(r.name);
    }
    return deactivated;
  }

  /**
   * @description List installed apps (summary view). When `caller` is supplied and is
   * NOT an operator, the result is scoped to apps the caller may see: public apps plus
   * the caller's own person-scoped apps. Omitting `caller` (internal callers, the
   * operator-facing pending/inject view) returns every app unfiltered — preserving the
   * original behaviour for the framework's own bookkeeping.
   */
  async listApps(
    statusFilter?: 'active' | 'inactive',
    caller?: { ownerSub: string | null; isOperator: boolean },
  ): Promise<SwarmApplicationSummary[]> {
    const records = await this.repo.list(statusFilter);
    const visible = !caller || caller.isOperator
      ? records
      : records.filter((r) => isVisibleToCaller(r, caller.ownerSub));
    // The caller is also the VIEWER: a row this caller may see is not automatically a row that may
    // name its owner (a public app is visible to everyone). Passing `caller` through — including
    // when it is undefined — keeps the internal, non-serializing listers (global search) on real
    // identity while every request-scoped listing is redacted.
    return visible.map((r) => toSummary(r, caller ?? null));
  }

  /**
   * Fetch one app's full record (manifest included), UNREDACTED and unfiltered. Server-internal
   * only — ownership decisions (publish/clone collision, the clone visibility check) need the real
   * owner subject. Never serialize the result of this straight to a client; use
   * {@link getAppForViewer}.
   */
  async getApp(name: string): Promise<SwarmApplicationRecord | null> {
    return this.repo.findByName(name);
  }

  /**
   * @description Fetch one app AS A GIVEN VIEWER may see it — the request-scoped counterpart to
   * {@link getApp}. Returns null both when the app does not exist and when it exists but this
   * viewer may not see it, so the caller answers 404 either way and never confirms the existence
   * of someone else's app. Owner identity is blanked unless the viewer owns the app or is an
   * operator; without this a guest could read the deployment operator's OIDC subject off any app
   * by name, which is exactly what the listing redaction alone would leave open.
   * @param name - The app name.
   * @param viewer - The requesting principal.
   * @returns The record with owner identity redacted as appropriate, or null when not visible.
   */
  async getAppForViewer(name: string, viewer: SummaryViewer): Promise<SwarmApplicationRecord | null> {
    const record = await this.repo.findByName(name);
    if (!record) return null;
    if (!viewer.isOperator && !isVisibleToCaller(record, viewer.ownerSub)) return null;
    if (maySeeOwnerIdentity(record, viewer)) return record;
    return { ...record, ownerSub: null, tenantId: null };
  }

  /**
   * @description Find the ACTIVE installed app whose bundled cockpit skin id matches
   * `themeId` (its manifest `theme` value). Backs the legacy `/cockpit/css/themes/<id>.css`
   * contract for packaged apps (ADR-085): surfaces authored against a core-registered skin
   * keep resolving their colors when the skin ships inside the package instead — the
   * carve-out deleted core's copy, which left every little-monsters iframe without its
   * CSS variables (invisible record button, unpolished surfaces).
   * @param themeId - the skin id a surface requests (the manifest's `theme` field)
   * @returns the active app bundling that skin, or null when none does
   */
  async findActiveAppByTheme(themeId: string): Promise<SwarmApplicationRecord | null> {
    const records = await this.repo.list('active');
    return records.find((r) => r.manifest.theme === themeId) ?? null;
  }

  /**
   * @description Flips an app active/inactive. Active → inactive deactivates
   * bots and deregisters UI. Inactive → active reactivates bots and
   * re-registers UI from the stored manifest.
   * @param name - application name
   * @param active - target state
   * @returns updated record, or null if no such app
   */
  async toggleApp(name: string, active: boolean): Promise<SwarmApplicationRecord | null> {
    const record = await this.repo.findByName(name);
    if (!record) return null;
    if (active) {
      await this.activate(record);
    } else {
      await this.deactivate(record);
    }
    const updated = await this.repo.updateStatus(name, active ? 'active' : 'inactive');
    await this.refreshOwnershipCache();
    logger.info({ name, active }, 'App toggled');
    return updated;
  }

  /**
   * @description ADR-085 §5 uninstall impact: who depends on this app, and which of ITS
   * dependencies would become orphans if it left. Dependents = ACTIVE installed apps whose
   * manifest.dependencies.apps names it (removal is blocked while any exist). Orphans =
   * this app's own app-dependencies that no OTHER active app would still depend on —
   * OFFERED for removal, never auto-removed (nothing cascades).
   */
  async uninstallImpact(name: string): Promise<{
    exists: boolean;
    dependents: string[];
    orphanCandidates: string[];
    /** Live RAG collections the manifest's ragCollections globs match — what a
     *  dropData uninstall would delete. Empty when undeclared or no teardown port. */
    ragCollections: string[];
    /** ADR-085 D11: the tool names this app PROVIDES (its `tools:` block). */
    toolsProvided: string[];
    /** ADR-085 D11: active apps whose `dependencies.tools` name a tool this app provides.
     *  Like app-level dependents, these BLOCK the uninstall unless forced. */
    toolDependents: ToolDependent[];
  }> {
    const record = await this.repo.findByName(name);
    if (!record) {
      return {
        exists: false,
        dependents: [],
        orphanCandidates: [],
        ragCollections: [],
        toolsProvided: [],
        toolDependents: [],
      };
    }
    const all = (await this.repo.list()).filter((r) => r.status === 'active' && r.name !== name);
    const depsOf = (r: SwarmApplicationRecord): string[] => r.manifest.dependencies?.apps ?? [];
    const dependents = all.filter((r) => depsOf(r).includes(name)).map((r) => r.name);
    const orphanCandidates = depsOf(record).filter(
      (dep) => !all.some((r) => depsOf(r).includes(dep)),
    );
    return {
      exists: true,
      dependents,
      orphanCandidates,
      ragCollections: await this.matchRagCollections(record),
      toolsProvided: providedToolNames(record.manifest),
      toolDependents: computeToolDependents(record.manifest, all),
    };
  }

  /**
   * @description Expand the manifest's `ragCollections` glob prefixes against the
   * live collection names (via the injected teardown port). Non-fatal: an impact
   * report must never fail because the RAG engine is briefly unreachable.
   * @param record - The app whose manifest declares ownership globs.
   * @returns Live collection names the app owns (empty when undeclared/unavailable).
   */
  private async matchRagCollections(record: SwarmApplicationRecord): Promise<string[]> {
    const globs = record.manifest.ragCollections ?? [];
    if (!globs.length || !this.ragTeardown) return [];
    try {
      const live = await this.ragTeardown.list();
      const regexes = globs.map((g) => new RegExp(`^${g.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`));
      return live.filter((c) => regexes.some((r) => r.test(c)));
    } catch (err) {
      logger.error({ err, name: record.name }, 'ragCollections impact expansion failed — reporting none');
      return [];
    }
  }

  /**
   * @description Remove an app entirely — deactivate first, then delete the DB row.
   * ADR-085 §5: BLOCKED (nothing removed) while other active apps depend on it, unless
   * `force` — automatic cascade removal is deliberately impossible; the caller sees the
   * dependents and decides. Orphaned dependencies are reported, never auto-removed.
   */
  async unloadApp(name: string, opts?: { force?: boolean; dropData?: boolean }): Promise<{
    removed: boolean;
    blocked?: boolean;
    dependents?: string[];
    orphanCandidates?: string[];
    /** ADR-085 D11: active apps stranded by removing this app's tools. */
    toolDependents?: ToolDependent[];
    /** Collections actually deleted (dropData runs only). */
    droppedRagCollections?: string[];
  }> {
    const impact = await this.uninstallImpact(name);
    if (!impact.exists) return { removed: false };
    // Blocked by an app-level dependent OR a tool-level one (ADR-085 D11). A tool dependent is a
    // reason to BLOCK, never a reason to retain the tool past its provider's removal: retention by
    // dependent would let any installed package pin another app's executor alive just by naming it.
    // Under --force the tool goes with its owner, and the dangling dependency is the dependent's.
    if ((impact.dependents.length > 0 || impact.toolDependents.length > 0) && !opts?.force) {
      logger.warn(
        { name, dependents: impact.dependents, toolDependents: impact.toolDependents },
        'Uninstall BLOCKED — active apps depend on this one (pass force to override)',
      );
      return {
        removed: false,
        blocked: true,
        dependents: impact.dependents,
        orphanCandidates: impact.orphanCandidates,
        toolDependents: impact.toolDependents,
      };
    }
    const record = await this.repo.findByName(name);
    if (!record) return { removed: false };
    await this.deactivate(record);
    // ADR-085 §5 data-loss gate: RAG collections die ONLY on the explicit dropData
    // opt-in, only at full uninstall (never toggle-off), and non-fatally per name —
    // a half-reachable engine must not leave the uninstall itself incomplete.
    const droppedRagCollections: string[] = [];
    if (opts?.dropData && this.ragTeardown) {
      for (const collection of impact.ragCollections) {
        try {
          assertGenericRagCollection(collection);
          await this.ragTeardown.deleteCollection(collection);
          droppedRagCollections.push(collection);
        } catch (err) {
          logger.error({ err, name, collection }, 'RAG collection teardown failed (continuing uninstall)');
        }
      }
    }
    const deleted = await this.repo.delete(name);
    await this.refreshOwnershipCache();
    logger.info({ name, deleted, orphanCandidates: impact.orphanCandidates, droppedRagCollections }, 'App unloaded');
    return { removed: deleted, orphanCandidates: impact.orphanCandidates, droppedRagCollections };
  }

  /** Export the manifest as YAML — used for transfer to another instance. */
  async exportManifest(name: string): Promise<string | null> {
    const record = await this.repo.findByName(name);
    if (!record) return null;
    return serializeManifest(record.manifest);
  }

  /**
   * @description Synthesises a ribbon UIProfile from a loaded app's manifest
   * when an operator selects this app via the Applications panel or
   * `?app=<name>` URL.
   *
   * Single visibility rule: start from the full framework ribbon, subtract
   * `ribbon.hideFrameworkItems`, then prepend the app's static UI items.
   * There is no "focused" vs "non-focused" toggle — what the manifest author
   * wants hidden stays hidden, what they keep stays. This makes each
   * manifest's ribbon state fully predictable from the YAML alone.
   *
   * @param name - application name
   * @returns a UIProfile-shaped object, or null if no such app is loaded
   */
  async synthesiseProfile(name: string): Promise<null | {
    name: string;
    displayName: string;
    description?: string;
    ribbon: {
      items: Array<string | { id: string; icon: string; label: string; section: 'top' | 'bottom'; group?: string; toolUi?: { iframeUrl: string; sidebarLabel: string } }>;
      dynamicTools: { allow: string[]; section?: 'top' | 'bottom' };
    };
    defaultView?: string;
    /** When true, the cockpit hides its right-rail chat panel for this app
     *  (apps that are themselves the chat surface, e.g. Jarvis). */
    hideChatPanel?: boolean;
    /** When true, the cockpit hides its global Jarvis/DEV assistant orb while
     *  this app is focused. App-owned ui.assistant bubbles remain independent. */
    hideAssistant?: boolean;
    /** The app's primary bot, so the cockpit chat panel preselects it instead
     *  of the operator's last-used bot when this app is focused. */
    chatAgent?: { agentId: string; name: string };
    /** Per-app cockpit skin (a COCKPIT_THEMES id). When set, the cockpit applies
     *  it transiently while this app is focused so each app looks distinct,
     *  without overwriting the operator's global theme preference. */
    theme?: string;
    /** ADR-085: when the app PACKAGE bundles its skin (ui/<theme>.css) the cockpit
     *  fetches it from here and applies data-theme=<theme> — a store-installed app
     *  brings its own look without core registering the skin. */
    themeCssUrl?: string;
    /** ADR-085 D9: the app's declarative assistant bubble, rendered BY the cockpit. Present only
     *  for an ACTIVE app. This is what replaces package shell-JS injection — see SwarmAppAssistant. */
    assistant?: SwarmAppAssistant;
    /** The app's own declared bots ({agentId,name}) — when present, the cockpit
     *  chat selector renders ONLY these (the app's own swarm, not all 20). They
     *  run inline on chat, so they need not be Redis-live to be selectable. */
    chatBots?: Array<{ agentId: string; name: string }>;
    /** The app's connector allow-list (manifest dependencies.connectors). Present =
     *  the ONLY provider ids this app's surfaces may offer to connect ([] = none);
     *  absent = legacy manifest, no filtering. Consumed by the cockpit ribbon pin,
     *  the Connectors marketplace view, and the welcome wizard's connect step. */
    connectors?: string[];
    /** The app's surface-bridge op allow-list (manifest surface.ops, validated at load).
     *  Consumed by the cockpit relay (surface-bridge-relay.js) as resolveRelayTarget's
     *  ctx.allowedOps. FAIL-CLOSED at the relay: absent here = NO ops relayed — unlike
     *  `connectors`, absence never means "unfiltered". */
    surfaceOps?: string[];
  }> {
    const record = await this.repo.findByName(name);
    if (!record) return null;
    const manifest = record.manifest;
    const ribbon = manifest.ribbon ?? {};
    const hide = new Set(ribbon.hideFrameworkItems ?? []);
    // The Tickets view only makes sense for an app that owns a queue (declares a
    // ticketType — the cockpit then filters tickets to that type). For an app with
    // no queue (storage, presentations, social, devops-facade) the ribbon's Tickets
    // item would show the whole unfiltered fleet of tickets, which is wrong — so
    // hide it automatically unless the manifest declares a ticketType.
    if (!manifest.ticketType) hide.add('tickets');

    // Prefix ids with `tool-` so the cockpit view controller's default
    // case (`viewId.startsWith('tool-')`) routes them to renderToolView,
    // which embeds an iframe in the main content area instead of doing a
    // whole-page navigation.
    // `group` rides through to the ribbon so a manifest can split its rail into
    // labelled bands (ADR-085 addendum). It is forwarded verbatim; RibbonNav is the
    // authority on where a heading is allowed, and already forces `''` on the pinned
    // bottom tray. Dropping the key here — which is what this map did before — made a
    // manifest-only `group:` edit a silent no-op, since nothing else reads ui.static.
    const staticItems = (manifest.ui?.static ?? []).map(s => ({
      id: `tool-${s.toolName}`,
      icon: s.icon,
      label: s.label,
      section: (s.section === 'bottom' ? 'bottom' : 'top') as 'top' | 'bottom',
      group: s.group,
      toolUi: { iframeUrl: s.iframeUrl, sidebarLabel: s.label },
    }));

    const FRAMEWORK_ITEMS = ['tickets', 'chat', 'calendar', 'addressbook', 'dashboard', 'logs', 'settings', 'operations'];
    const frameworkItems = FRAMEWORK_ITEMS.filter(id => !hide.has(id));

    const dynamicPattern = manifest.ui?.dynamic?.toolNameTemplate
      ? manifest.ui.dynamic.toolNameTemplate.replace(/\{[^}]+\}/g, '*')
      : null;
    const allowPatterns = dynamicPattern ? [dynamicPattern] : [];

    // The app's primary bot — the workflow's workerBot, else the first declared
    // bot — so the cockpit chat panel can preselect it when this app is focused.
    // The right-rail chat agent: an explicit manifest.chatBot (an advisor) wins, else the
    // workflow's worker bot, else the first declared bot.
    const chatBotName = manifest.chatBot ?? manifest.workflow?.workerBot;
    const primaryBot = (manifest.bots ?? []).find(b => b.name === chatBotName) ?? (manifest.bots ?? [])[0];
    let chatAgent = primaryBot?.agentId ? { agentId: primaryBot.agentId, name: primaryBot.name } : undefined;

    // Every bot the app declares — the cockpit chat selector renders just these
    // (the app's own swarm) rather than the whole live fleet.
    let chatBots = (manifest.bots ?? [])
      .filter((b): b is typeof b & { agentId: string } => typeof b.agentId === 'string' && b.agentId.length > 0)
      .map(b => ({ agentId: b.agentId, name: b.name }));

    // ADR-085 carve parity: a store-carved app declares NO `bots:` (its worker is
    // framework-resident, ADR-093) but still names it via workflow.workerBot, and the
    // repository backfills record.agentIds from that name at upsert. Without this
    // fallback the six carved concierges lost cockpit chat-panel preselection and the
    // app-scoped bot selector — pre-carve, their manifests declared the bot inline and
    // both fields were populated. Restore exactly that from the backfilled record.
    if (!chatAgent && chatBotName && record.agentIds.length > 0) {
      chatAgent = { agentId: record.agentIds[0], name: chatBotName };
      if (!chatBots.length) chatBots = [chatAgent];
    }

    // ADR-085 package-bundled skin: when the app ships ui/<theme>.css beside its
    // manifest, the cockpit loads it from the theme.css route instead of requiring
    // the skin to be registered in core's COCKPIT_THEMES.
    let themeCssUrl: string | undefined;
    if (manifest.theme && /^[a-z0-9-]+$/i.test(manifest.theme)) {
      const cssPath = resolve(dirname(record.manifestPath), 'ui', `${manifest.theme}.css`);
      if (existsSync(cssPath)) themeCssUrl = `/api/swarm/apps/${manifest.name}/theme.css`;
    }

    // ADR-085 D9: the declarative assistant bubble — the framework renders it, so no package JS
    // ever runs in the cockpit's authenticated origin. Only for an ACTIVE app: a toggled-off app
    // must not keep advertising a floating widget that opens routes its own gate now blocks.
    const assistant = record.status === 'active' ? manifest.ui?.assistant : undefined;

    return {
      name: manifest.name,
      displayName: manifest.displayName,
      description: manifest.description,
      hideChatPanel: ribbon.hideChatPanel === true ? true : undefined,
      hideAssistant: ribbon.hideAssistant === true ? true : undefined,
      chatAgent,
      theme: manifest.theme,
      themeCssUrl,
      assistant,
      chatBots: chatBots.length ? chatBots : undefined,
      // Connector allow-list: forwarded only when the manifest declares the key —
      // absent must stay absent so legacy apps keep the unfiltered catalog.
      connectors: Array.isArray(manifest.dependencies?.connectors)
        ? manifest.dependencies.connectors
        : undefined,
      // Surface-bridge op allow-list: forwarded only when declared. The relay treats
      // absence as an EMPTY allow-list (fail-closed) — no declaration = no bridge.
      surfaceOps: Array.isArray(manifest.surface?.ops) ? manifest.surface.ops : undefined,
      ribbon: {
        items: [...staticItems, ...frameworkItems],
        dynamicTools: {
          allow: allowPatterns,
          section: manifest.ui?.dynamic?.section,
        },
      },
      // The manifest's ribbon.defaultView uses the raw toolName; since we
      // prefix static items with `tool-`, normalise here so the initial
      // ribbon highlight lines up with the rendered content.
      defaultView: (() => {
        const declared = ribbon.defaultView;
        if (!declared) return staticItems[0]?.id;
        const matchingStatic = staticItems.find(s => s.id === `tool-${declared}` || s.id === declared);
        return matchingStatic?.id ?? declared;
      })(),
    };
  }

  /**
   * @description Manifests of all currently-active apps. Used by the per-user
   * schedule reconciler to discover scope:'per-user' "polls" to register when a
   * user connects the required connector.
   */
  async getActiveManifests(): Promise<SwarmAppManifest[]> {
    const all = await this.repo.list();
    return all.filter((r) => r.status === 'active').map((r) => r.manifest);
  }

  // ── Internal: activation / deactivation primitives ─────────────────────

  private async activate(record: SwarmApplicationRecord): Promise<void> {
    // Package schema FIRST: bots/tools/UI may depend on the app's own tables existing.
    await this.applyPackageMigrations(record);

    // Archive dispatch is a trust boundary, so registration is activation-critical. A missing,
    // escaped, or malformed handler fails the app closed. Passing [] also retracts a stale
    // contribution when an active manifest reload removes its takeout block.
    await this.takeoutRegistrar?.register(
      record.name,
      dirname(record.manifestPath),
      record.manifest.takeout ?? [],
    );

    // ADR-085: packaged bots join the ACTIVE bot registry (dispatchable + wiring-audit green) with
    // zero core-registry edits. Non-fatal — inline dispatch still works.
    //
    // ADR-085 D3 — this MUST precede upsertBots. Access scoping (ADR-087) is enforced from the
    // REGISTRY (isBotAccessibleTo), and an agentId the registry doesn't know is open to every
    // caller. Writing the DB row first made the bot an eligible call-out candidate during the
    // window before its registry definition — and therefore its accessRoles — existed, so a bot
    // scoped AWAY from Jarvis was briefly reachable by Jarvis. Registration is a pure Map.set, so
    // ordering it first costs nothing.
    try {
      this.botRegistrar?.register(record.name, record.manifest.bots ?? []);
    } catch (err) {
      logger.error({ err, app: record.name }, 'Manifest bot registration failed (non-fatal)');
    }

    await this.upsertBots(record.manifest);
    await this.setBotStatuses(record.agentIds, 'active');
    this.applyGuestTier(record);
    this.applySkillProfiles(record);
    this.applyArtifactActions(record);
    // Dynamic UI discovery is the last activation step that may throw directly. Complete it
    // before enabling model tools or seeding grants, then keep only non-throwing/caught steps
    // after the privilege boundary. loadApp still compensates if an unexpected later error escapes.
    await this.registerUiSurfaces(record.manifest, record.name);
    await this.registerManifestTools(record.manifest, dirname(record.manifestPath));
    await this.seedBotAuthorizations(record.manifest, dirname(record.manifestPath));
    this.registerWorkflow(record.manifest);
    await this.registerManifestSchedules(record.manifest, dirname(record.manifestPath));
    await this.mountManifestRoutes(record);
  }

  /**
   * @description Mounts a package's own compiled-JS routes (ADR-085 P1). The route
   * modules are resolved relative to the manifest's own directory (the package dir),
   * so an installed app in deployed-apps/<name>/ brings its routes without them being
   * compiled into the core image. Delegates to the injected ManifestRouteMounter, which
   * is itself flag-gated (no-op unless the operator opts in) — so this is a safe no-op
   * by default and the hardcoded server.ts mounts remain the source of truth until then.
   * Non-fatal: a route module that fails to load must not break app activation.
   */
  private async mountManifestRoutes(record: SwarmApplicationRecord): Promise<void> {
    if (!this.routeMounter || !record.manifest.routes?.length) return;
    try {
      const packageDir = dirname(record.manifestPath);
      await this.routeMounter.mount(record.name, packageDir, record.manifest.routes, record.manifest.access);
    } catch (err) {
      logger.error({ err, app: record.name }, 'Manifest route mount failed (non-fatal)');
    }
  }

  /**
   * @description ADR-085 P2 migration runner: applies an installed package's OWN
   * `migrations/*.sql` (paths relative to the package dir) idempotently at activation,
   * tracked per (app, file) in `app_package_migrations` so an already-applied file never
   * re-runs. This is how an installed app brings its schema with it instead of shipping
   * files into scripts/migrations/.
   *
   * Safety rails:
   *  - Flag-gated on APP_PACKAGE_MIGRATIONS (default OFF → byte-for-byte no-op).
   *  - SELF-CONTAINED PATHS ONLY: entries that are absolute, contain '..', or resolve
   *    outside the package dir are skipped with a warning (legacy manifests listing
   *    scripts/migrations/* are framework-owned and handled by the boot bootstrap).
   *  - Files apply IN THE DECLARED ORDER; on the first failure the app's remaining
   *    migrations are aborted (later files usually depend on earlier ones) but boot
   *    and the rest of activation continue — half-schema is logged loudly.
   */
  private async applyPackageMigrations(record: SwarmApplicationRecord): Promise<void> {
    const enabled = ['1', 'true', 'yes'].includes((process.env.APP_PACKAGE_MIGRATIONS || '').trim().toLowerCase());
    if (!enabled || !record.manifest.migrations?.length) return;

    const path = await import('path');
    const fs = await import('fs');
    const packageDir = path.dirname(record.manifestPath);

    try {
      await this.pool.query(
        `CREATE TABLE IF NOT EXISTS app_package_migrations (
           app_name   VARCHAR(100) NOT NULL,
           file_name  VARCHAR(500) NOT NULL,
           applied_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
           PRIMARY KEY (app_name, file_name)
         )`,
      );
    } catch (err) {
      logger.error({ err, app: record.name }, 'Package-migrations tracking table unavailable — skipping migrations');
      return;
    }

    for (const rel of record.manifest.migrations) {
      // Self-containment guard — a package may only apply SQL it ships itself.
      if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
        logger.warn({ app: record.name, file: rel }, 'Package migration path not package-relative — skipped');
        continue;
      }
      const abs = path.resolve(packageDir, rel);
      const relToPackage = path.relative(packageDir, abs);
      if (relToPackage.startsWith('..')) {
        logger.warn({ app: record.name, file: rel }, 'Package migration escapes the package dir — skipped');
        continue;
      }
      if (!fs.existsSync(abs)) {
        // Legacy manifests referenced scripts/migrations/* (framework-owned, boot-applied) —
        // absent inside the package is expected for those; log at info, not error.
        logger.info({ app: record.name, file: rel }, 'Package migration file not present in package — skipped');
        continue;
      }
      try {
        const { rowCount } = await this.pool.query(
          'SELECT 1 FROM app_package_migrations WHERE app_name = $1 AND file_name = $2',
          [record.name, rel],
        );
        if (rowCount && rowCount > 0) continue; // already applied
        const sql = fs.readFileSync(abs, 'utf8');
        // One checked-out client so BEGIN/SQL/COMMIT share a connection — Pool.query()
        // grabs a client PER CALL, which would silently break the transaction.
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query(
            'INSERT INTO app_package_migrations (app_name, file_name) VALUES ($1, $2)',
            [record.name, rel],
          );
          await client.query('COMMIT');
        } catch (inner) {
          try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
          throw inner;
        } finally {
          client.release();
        }
        logger.info({ app: record.name, file: rel }, 'Package migration applied');
      } catch (err) {
        logger.error({ err, app: record.name, file: rel }, 'Package migration FAILED — aborting this app\'s remaining migrations');
        return;
      }
    }
  }

  /**
   * @description Registers each framework-scope schedule the manifest declares (its
   * "default polls") through the injected registrar — so enabling an app brings its
   * recurring jobs with it. Per-user schedules are skipped here; the connector
   * write path activates them through the per-user schedule reconciler. Idempotent
   * (the scheduler replaces by id on re-load) and non-fatal: a scheduler hiccup must
   * never break app activation. Deterministic service-route handler registration is
   * activation-critical because a missing/escaped export must not leave an app claiming an
   * unattended worker that cannot run. Registered jobs only EXECUTE when the agent scheduler is
   * enabled (ENABLE_AGENT_SCHEDULER=true).
   */
  private async registerManifestSchedules(manifest: SwarmAppManifest, packageDir: string): Promise<void> {
    if (!this.scheduleRegistrar || !manifest.schedules?.length) return;
    for (const s of manifest.schedules) {
      if (s.enabled === false) continue;
      if (s.scope === 'per-user') {
        logger.info({ app: manifest.name, schedule: s.id }, 'Per-user schedule declared; activates through connector-connect reconciliation');
        continue;
      }
      try {
        const owningRoute = s.target === 'service-route'
          ? (manifest.routes ?? [])
              .filter((route) => {
                const mount = route.mountPath.length > 1 ? route.mountPath.replace(/\/+$/, '') : route.mountPath;
                return s.route === mount || s.route.startsWith(`${mount}/`);
              })
              .sort((a, b) => b.mountPath.length - a.mountPath.length)[0]
          : undefined;
        if (s.target === 'service-route' && !owningRoute) {
          throw new Error(`Service-route schedule ${manifest.name}/${s.id} has no owning route`);
        }
        const target = s.target === 'service-route'
          ? {
              kind: 'service-route' as const,
              appName: manifest.name,
              packageDir,
              module: owningRoute!.module,
              handler: s.handler,
              path: s.route,
              body: s.body ?? {},
            }
          : {
              kind: 'prompt' as const,
              prompt: s.prompt,
              targetAgent: s.targetAgent,
            };
        await this.scheduleRegistrar({
          scheduleId: `${manifest.name}-${s.id}`,
          cron: s.cron,
          queue: manifest.name,
          target,
        });
      } catch (err) {
        if (s.target === 'service-route') {
          logger.error({ err, app: manifest.name, schedule: s.id }, 'Failed to register deterministic manifest schedule (activation denied)');
          await this.deregisterManifestSchedules(manifest);
          throw err;
        }
        logger.error({ err, app: manifest.name, schedule: s.id }, 'Failed to register manifest schedule (non-fatal)');
      }
    }
  }

  /** Seed each app bot's persona allowed_tools into agent_tools (after the manifest tools
   *  register) so the framework auto-injects the tool usage into the bot's prompt. Without
   *  this, only the default chat agent gets seeded and app bots have no tools. Non-fatal.
   *  Persona paths resolve against the PACKAGE dir first (a store package bundles
   *  personas/*.yaml beside its manifest), then cwd (core manifests reference
   *  ai-lab/bot-personas/ repo-relative) — cwd-only resolution made every packaged
   *  persona "return null" and silently seed nothing (found live at the brand-graphics
   *  carve, 2026-07-17). */
  private async seedBotAuthorizations(manifest: SwarmAppManifest, packageDir?: string): Promise<void> {
    if (!this.personaAuthorizationSeeder) return;
    const path = await import('path');
    for (const bot of manifest.bots ?? []) {
      if (!bot.persona) continue; // can't seed without the bot's own persona file
      const candidates = [
        ...(packageDir ? [path.resolve(packageDir, bot.persona)] : []),
        path.resolve(process.cwd(), bot.persona),
      ];
      const personaPath = candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 1];
      try {
        const seeded = await this.personaAuthorizationSeeder(bot.agentId, personaPath);
        logger.info({ appName: manifest.name, agentId: bot.agentId, personaPath, seeded }, 'Seeded bot persona authorizations');
      } catch (err) {
        logger.warn({ err: (err as Error).message, agentId: bot.agentId }, 'Persona authorization seed failed (non-fatal)');
      }
    }
  }

  /**
   * @description Registers the manifest's workflow (if any) with the
   * process-wide WorkflowPipelineRegistry so tickets with matching
   * ticketType route to the app-declared worker bot + pipeline.
   */
  private registerWorkflow(manifest: SwarmAppManifest): void {
    if (!manifest.workflow || !manifest.ticketType) return;
    WorkflowPipelineRegistry.getInstance().registerFromApp(manifest.name, {
      ticketType: manifest.ticketType,
      name: manifest.workflow.name,
      pipeline: manifest.workflow.pipeline,
      workerBot: manifest.workflow.workerBot,
      // reviewerBot was being silently dropped here. dispatchIncidentTicket
      // resolves queueAgentId from workflow.reviewerBot and falls through
      // to graceful-completion when it's null — so any app-contributed
      // workflow that declared a reviewer never actually got one.
      reviewerBot: manifest.workflow.reviewerBot,
      maxRevisions: manifest.workflow.maxRevisions,
      // Authored stage list for 'staged' workflows — carried into the registry so
      // the staged dispatcher can run the operator-pinned bots in order.
      stages: manifest.workflow.stages,
      // Compiled ProcessDefinition for 'graph' workflows — the graph dispatcher runs it.
      processDefinition: manifest.workflow.processDefinition,
      // Per-workflow auto-start — tickets of this type auto-approve so the workflow runs on arrival.
      autoStart: manifest.workflow.autoStart,
    });
  }

  /**
   * @description Upserts each manifest-declared bot into the agents table.
   * On first load of a manifest that brings brand-new bots, this is how
   * they get seeded. Existing rows (matched by agent_id) are left alone —
   * operators can edit persona/provider/model via the cockpit without
   * worrying that a manifest reload will overwrite their changes.
   */
  private async upsertBots(manifest: SwarmAppManifest): Promise<void> {
    for (const bot of manifest.bots ?? []) {
      try {
        const selectorSeed = readBotSelectorSeed(bot);
        const baseRoutingKeywords = selectorSeed.routingKeywords.length > 0
          ? selectorSeed.routingKeywords
          : bot.capabilities ?? [];
        await this.pool.query(
          `INSERT INTO agents (
             agent_id, name, api_provider_id, base_capabilities,
             base_selector_descriptor, base_routing_keywords,
             metadata, status, persona
           )
           VALUES ($1, $2, $3, $4, $5, $6::text[], $7, 'active', $8::jsonb)
           ON CONFLICT (agent_id)
           DO UPDATE SET
             name = EXCLUDED.name,
             base_capabilities = EXCLUDED.base_capabilities,
             base_selector_descriptor = CASE
               WHEN EXCLUDED.base_selector_descriptor <> ''
                 THEN EXCLUDED.base_selector_descriptor
               ELSE agents.base_selector_descriptor
             END,
             base_routing_keywords = CASE
               WHEN COALESCE(array_length(EXCLUDED.base_routing_keywords, 1), 0) > 0
                 THEN EXCLUDED.base_routing_keywords
               ELSE agents.base_routing_keywords
             END,
             metadata = agents.metadata || EXCLUDED.metadata,
             persona = CASE
               WHEN agents.persona = '{}'::jsonb OR agents.metadata->>'manifestApp' = $9
                 THEN EXCLUDED.persona
               ELSE agents.persona
             END,
             status = 'active',
             updated_at = NOW()`,
          [
            bot.agentId,
            bot.name,
            process.env.FORCE_LLM_PROVIDER || 'openai-native',
            bot.capabilities ?? [],
            selectorSeed.selectorDescriptor,
            baseRoutingKeywords,
            JSON.stringify({
              role: bot.role ?? '',
              manifestApp: manifest.name,
              persona: bot.persona ?? '',
              // Read back by Jarvis's loadEffectiveRoutes to decide delegate-vs-handoff. Only
              // written when declared, so `metadata || EXCLUDED.metadata` cannot clobber an
              // operator's stored value with an empty one on every manifest reload.
              ...(bot.jarvisMode ? { jarvisMode: bot.jarvisMode } : {}),
            }),
            JSON.stringify({
              role: bot.role ?? '',
              systemPrompt: bot.persona ?? '',
              capabilities: bot.capabilities ?? [],
              selectorDescriptor: selectorSeed.selectorDescriptor,
              routingKeywords: baseRoutingKeywords,
            }),
            manifest.name,
          ],
        );
      } catch (err) {
        logger.error({ err, agentId: bot.agentId, name: bot.name }, 'Bot upsert failed');
      }
    }
  }

  private async deactivate(record: SwarmApplicationRecord): Promise<void> {
    // Close package ingestion first so a handler cannot remain reachable during asynchronous
    // teardown. The registry operation is synchronous and idempotent.
    try {
      this.takeoutRegistrar?.unregister(record.name);
    } catch (err) {
      logger.error({ err, app: record.name }, 'Manifest Takeout deregistration failed (non-fatal)');
    }
    await this.setBotStatuses(record.agentIds, 'inactive');
    // ADR-085 D4: retract the guest tier — a toggled-off app must not keep granting guests reach
    // into routes its own gate now blocks. Idempotent; the segment falls back to the read-only default.
    for (const seg of this.guestSegmentsFor(record)) unregisterAppGuestTier(seg);
    // ADR-090 addendum: retract the app's skill profiles — a toggled-off app must hold zero live
    // profiles (same teardown discipline as tools/schedules/guest tier). Idempotent.
    try {
      unregisterAppSkillProfiles(record.name);
    } catch (err) {
      logger.error({ err, app: record.name }, 'Skill-profile deregistration failed (non-fatal)');
    }
    // ADR-139: retract the app's "Send to…" artifact actions — a toggled-off app must hold zero
    // live menu entries. Idempotent.
    try {
      unregisterAppArtifactActions(record.name);
    } catch (err) {
      logger.error({ err, app: record.name }, 'Artifact-action deregistration failed (non-fatal)');
    }
    // Retract the app's dynamically registered bots FIRST — a stale registry entry
    // would keep resolving dispatch to a deactivated app (ghost dispatch). Idempotent.
    try {
      this.botRegistrar?.unregister(record.name);
    } catch (err) {
      logger.error({ err, app: record.name }, 'Manifest bot deregistration failed (non-fatal)');
    }
    await this.deregisterManifestTools(record.manifest);
    for (const toolName of record.toolNames) {
      deregisterDynamicToolUI(toolName);
    }
    // Also deregister dynamic (per-row) UIs registered at activation time.
    // Those toolNames follow the manifest's toolNameTemplate; we recompute
    // via the DB to avoid tracking them individually.
    await this.deregisterDynamicRowUis(record.manifest);
    deregisterDynamicToolVisibility(record.name);
    WorkflowPipelineRegistry.getInstance().unregisterApp(record.name);
    // Unmount any package routes this app dynamically mounted (ADR-085 P1). No-op when
    // no mounter is injected or the app declared none. Idempotent.
    this.routeMounter?.unmount(record.name);
    // ADR-085 P0 — tear down the app's registered schedules so a toggled-off app's
    // recurring polls STOP firing (and billing). Before this, deactivate() had no
    // counterpart to registerManifestSchedules and the polls outlived the toggle.
    await this.deregisterManifestSchedules(record.manifest);
  }

  /**
   * @description Hands every schedule id the manifest declares (framework AND per-user
   * scopes — per-user instances are per-sub children of the same declared id) to the
   * injected deregistrar for deletion. Non-fatal: a scheduler hiccup must never brick a
   * toggle-off; the deregistrar logs what it removed.
   */
  private async deregisterManifestSchedules(manifest: SwarmAppManifest): Promise<void> {
    if (!this.scheduleDeregistrar || !manifest.schedules?.length) return;
    try {
      await this.scheduleDeregistrar({
        appName: manifest.name,
        scheduleIds: manifest.schedules.map((s) => s.id),
      });
    } catch (err) {
      logger.error({ err, app: manifest.name }, 'Manifest schedule teardown failed (non-fatal)');
    }
  }

  /**
   * @description Retract schedule identities that the incoming manifest no longer replaces in
   * place. Same-mode framework schedules are safely upserted by task type; removed declarations,
   * prompt↔service changes, and per-user scope/connection changes own different persisted children
   * and must be torn down explicitly before the replacement activates.
   */
  private async deregisterRetiredManifestSchedules(
    previous: SwarmApplicationRecord | null,
    incoming: SwarmAppManifest,
  ): Promise<void> {
    if (!this.scheduleDeregistrar || previous?.status !== 'active' || !previous.manifest.schedules?.length) return;
    const next = new Map((incoming.schedules ?? []).map((schedule) => [schedule.id, schedule]));
    const retiredIds = previous.manifest.schedules
      .filter((prior) => {
        const replacement = next.get(prior.id);
        if (!replacement) return true;
        const priorTarget = prior.target === 'service-route' ? 'service-route' : 'prompt';
        const nextTarget = replacement.target === 'service-route' ? 'service-route' : 'prompt';
        return (
          priorTarget !== nextTarget ||
          prior.scope !== replacement.scope ||
          prior.requiresConnection !== replacement.requiresConnection
        );
      })
      .map((schedule) => schedule.id);
    if (retiredIds.length === 0) return;
    try {
      await this.scheduleDeregistrar({ appName: incoming.name, scheduleIds: retiredIds });
    } catch (error) {
      logger.error(
        { err: error, app: incoming.name, schedules: retiredIds },
        'Retired manifest schedule teardown failed (non-fatal)',
      );
    }
  }

  private async setBotStatuses(agentIds: string[], status: 'active' | 'inactive'): Promise<void> {
    for (const agentId of agentIds) {
      try {
        await this.agentProfileRepo.updateAgentStatus(agentId, status);
      } catch (err) {
        logger.error({ err, agentId, status }, 'Failed to update agent status');
      }
    }
  }

  private async registerUiSurfaces(manifest: SwarmAppManifest, appName: string): Promise<void> {
    for (const s of manifest.ui?.static ?? []) {
      registerDynamicToolUI(s.toolName, s.label, s.icon, s.iframeUrl, appName);
    }
    const dyn = manifest.ui?.dynamic;
    if (dyn) {
      await this.registerDynamicRowUis(dyn, appName);
      // ADR-085 generic per-user visibility: the app's own endpoint decides which of its
      // dynamic tools each caller sees (fail-closed in tool-routes).
      if (dyn.visibility?.endpoint && dyn.visibility?.pattern) {
        registerDynamicToolVisibility(appName, { endpoint: dyn.visibility.endpoint, pattern: dyn.visibility.pattern });
      }
    }
  }

  /**
   * @description The route segments an app owns, as `guestDecision` resolves them from a path.
   *
   * `/api/education/tutor` → `education`. Derived from the manifest's routes, because that is what a
   * guest's request path actually hits.
   *
   * @param record - The app.
   * @returns Its route segments (deduped).
   */
  private guestSegmentsFor(record: SwarmApplicationRecord): string[] {
    const segs = (record.manifest.routes ?? [])
      .map((r) => appSegmentForPath(r.mountPath))
      .filter(Boolean);
    return [...new Set(segs)];
  }

  /**
   * @description Apply an app's OPERATOR-APPROVED guest tier to the live matrix (ADR-085 D4).
   *
   * Reads the approval off the app's DB row — **never** the manifest. A manifest's `guestTier` is a
   * request: guests are unauthenticated, so a package that could set its own tier could silently
   * widen what an anonymous visitor reaches, `full` including WRITES. Unapproved (the default, and
   * the state of every app installed before migration 076) means the app keeps the safe Tier-B
   * default — guests read, mutations blocked.
   *
   * @param record - The app being activated (or re-applied after an approval change).
   */
  private applyGuestTier(record: SwarmApplicationRecord): void {
    const approved = record.guestTierApproved;
    for (const seg of this.guestSegmentsFor(record)) {
      if (approved) registerAppGuestTier(seg, approved);
      else unregisterAppGuestTier(seg);
    }
    if (approved) {
      logger.info(
        { app: record.name, tier: approved, segments: this.guestSegmentsFor(record) },
        'Applied operator-approved guest tier',
      );
    } else if (record.manifest.guestTier) {
      logger.info(
        { app: record.name, requested: record.manifest.guestTier },
        'App REQUESTS a guest tier but it is not approved — guests stay read-only until an operator approves it',
      );
    }
  }

  /**
   * @description Register the app's declared skill profiles (ADR-090 addendum) into the shared
   * in-memory registry, keyed by app name with its ticketType for dispatch-time resolution. Called
   * from activate(); deactivate() retracts. Mirrors applyGuestTier — non-fatal, replace-by-app so a
   * re-activate is idempotent. A manifest with no skillProfiles is a no-op (registerAppSkillProfiles
   * returns early on an empty map).
   * @param record - The app being activated.
   */
  private applySkillProfiles(record: SwarmApplicationRecord): void {
    const profiles = record.manifest.skillProfiles;
    // Negative case must RETRACT, not just skip — an edit-reload that removes the skillProfiles
    // block re-runs activate() without deactivate(), so a bare early-return would leave the prior
    // registration live (stale, wrong-shaped output). Mirror applyGuestTier's `else unregister`
    // branch. Idempotent, so an app that never had profiles is a harmless no-op.
    if (!profiles || Object.keys(profiles).length === 0) {
      unregisterAppSkillProfiles(record.name);
      return;
    }
    try {
      registerAppSkillProfiles({
        appName: record.name,
        ticketType: record.manifest.ticketType,
        profiles,
      });
    } catch (err) {
      logger.error({ err, app: record.name }, 'Skill-profile registration failed (non-fatal)');
    }
  }

  /**
   * @description Approve (or revoke) an app's guest tier. **Operator-only** — the route enforces it.
   *
   * The one place a guest tier is ever granted. Passing null revokes, dropping the app back to the
   * read-only default. Takes effect immediately: the live matrix is updated, no restart.
   *
   * @param name - App name.
   * @param tier - The tier to approve, or null to revoke.
   * @returns The updated record, or null when the app doesn't exist.
   */
  /**
   * @description Register the app's "Send to…" artifact declarations (ADR-139) into the shared
   * registry. Called from activate(); deactivate() retracts. Mirrors applySkillProfiles — the
   * negative case RETRACTS rather than skips, so an edit-reload that removes the artifacts:
   * block clears the prior registration instead of leaving stale menu entries live.
   * @param record - The app being activated.
   */
  private applyArtifactActions(record: SwarmApplicationRecord): void {
    const decl = record.manifest.artifacts;
    const empty = !decl || ((decl.accepts?.length ?? 0) === 0 && (decl.provides?.length ?? 0) === 0);
    if (empty) {
      unregisterAppArtifactActions(record.name);
      return;
    }
    try {
      registerAppArtifactActions(record.name, decl);
    } catch (err) {
      logger.error({ err, app: record.name }, 'Artifact-action registration failed (non-fatal)');
    }
  }

  async approveGuestTier(name: string, tier: GuestTier | null): Promise<SwarmApplicationRecord | null> {
    const record = await this.repo.setGuestTierApproval(name, tier);
    if (!record) return null;
    // Only a live app should influence what guests can reach; an inactive one stays retracted.
    if (record.status === 'active') this.applyGuestTier(record);
    else for (const seg of this.guestSegmentsFor(record)) unregisterAppGuestTier(seg);
    return record;
  }

  /**
   * @description The ACTIVE app that provides this tool name, if any (ADR-085 D11).
   *
   * The ownership port behind the runtime tool routes' 409 guard: `POST /api/tools/runtime/register`
   * and `DELETE /api/tools/runtime/:toolName` are reachable by any signed-in user and every bot
   * node, and would otherwise repoint or delete a tool an app owns, straight past manifest ownership.
   *
   * Derived at query time from the active manifests — never from `tools.registered_by` (written on
   * INSERT only, so first-writer-wins) or the `swarm-app:<name>` tag (in the update field map, so
   * last-writer-wins). Those two anchors disagree under a collision and neither is multi-valued.
   *
   * @param toolName - The tool to resolve.
   * @returns The owning app's name, or null when no active app provides it.
   */
  async manifestToolOwner(toolName: string): Promise<string | null> {
    const active = (await this.repo.list()).filter((r) => r.status === 'active');
    return active.find((r) => providedToolNames(r.manifest).includes(toolName))?.name ?? null;
  }

  /**
   * @description Gate a manifest on the tool-ownership invariants before it is stored (ADR-085 D11).
   *
   * Two checks, both fail-closed:
   *  1. **Uniqueness** — the manifest may not provide a tool name another ACTIVE app provides.
   *     `runtime_tool_executors` is keyed by `tool_name` with an ON CONFLICT DO UPDATE upsert, so a
   *     duplicate name silently repoints the other app's tool at this app's executor. That is not
   *     theoretical: purchasing and travel both declared `explain-pick`, travel sorted last under
   *     readdirSync, and the shopping concierge's tool was live-routing to /api/travel/chat.
   *  2. **Resolvable dependencies** — `dependencies.tools` may not name a tool nothing provides.
   *
   * Deliberately NOT in `readManifest`: that function is synchronous and pool-less (which is exactly
   * why D8's `uses:` check could live there — kernel skills are a static set). Tool existence needs
   * the registry, so the gate belongs here, on the write path every loader call site funnels through.
   *
   * Resilience matters more than completeness here. The registry read is best-effort: if the tool
   * port is absent or the query throws, the dependency universe falls back to the active manifests
   * alone and the check WARNs rather than failing. Boot proceeds even when `waitForBootstrapComplete`
   * times out (server.ts autoloads anyway), and a transient database error must not fail-close all
   * 42 apps at once. The uniqueness check needs no registry read and always runs.
   *
   * @param manifest - The manifest being loaded.
   * @throws When a tool name is already taken, or a declared tool dependency cannot be resolved.
   */
  private async assertToolOwnership(manifest: SwarmAppManifest): Promise<void> {
    const all = await this.repo.list();
    // Exclude the app's own stored record — a RELOAD (edit + re-load, the routine case) would
    // otherwise collide with its own previous manifest and become permanently unloadable.
    const others = all.filter((r) => r.status === 'active' && r.name !== manifest.name);

    assertToolNamesUnique(manifest, others);

    const depends = dependedToolNames(manifest);
    if (!depends.length) return; // The common case today: no manifest declares a tool dependency.

    const universe = new Set<string>([
      ...providedToolNames(manifest),
      ...others.flatMap((r) => providedToolNames(r.manifest)),
    ]);

    // The registry half of the universe — baseline + connector-spec tools no manifest provides.
    // Row EXISTENCE, not enabled=true: a connector's spec tools are disabled (not deleted) when the
    // user toggles that provider off, and gating on `enabled` would brick every app depending on one.
    try {
      const executors = (await this.runtimeToolRegistrationService?.listRuntimeExecutors()) ?? [];
      for (const e of executors) universe.add(e.toolName);
    } catch (err) {
      logger.error(
        { err, appName: manifest.name, depends },
        'Tool registry unreadable — resolving dependencies.tools against active manifests only. ' +
          'A registry blip must not fail-close every app at boot.',
      );
    }

    assertToolDependenciesResolvable(manifest, universe);
  }

  /**
   * @description Registers a manifest's declared tools as runtime executors.
   * A cli tool's `cliCommand` may reference the app's own bundled files via the
   * `{packageDir}` token, resolved here to the manifest's directory — substitution
   * must happen before registration because the cli-command-validator rejects
   * unknown template tokens, so what persists is always a concrete path.
   * @param manifest - The activating app's manifest.
   * @param packageDir - Absolute directory of the manifest (the package root).
   */
  private async registerManifestTools(manifest: SwarmAppManifest, packageDir?: string): Promise<void> {
    if (!manifest.tools?.length) return;
    if (!this.runtimeToolRegistrationService) {
      logger.warn({ appName: manifest.name, count: manifest.tools.length }, 'Manifest tools skipped — runtime tool service unavailable');
      return;
    }

    for (const tool of manifest.tools) {
      try {
        // Function replacement on purpose: a string replacement would reinterpret
        // `$`-sequences in the path ($&, $', …) instead of inserting it verbatim.
        const cliCommand = tool.executor.cliCommand && packageDir
          ? tool.executor.cliCommand.replaceAll('{packageDir}', () => packageDir)
          : tool.executor.cliCommand;
        await this.runtimeToolRegistrationService.registerRuntimeTool(
          manifestToolToCreateInput(tool, manifest.name),
          {
            toolName: tool.name,
            executorType: tool.executor.executorType,
            cliCommand,
            apiEndpoint: tool.executor.apiEndpoint,
            mcpServerName: tool.executor.mcpServerName,
            builtinKey: tool.executor.builtinKey,
            runtimeRegistered: true,
            registeredAt: new Date().toISOString(),
          },
        );
      } catch (err) {
        logger.error({ err, appName: manifest.name, toolName: tool.name }, 'Manifest tool registration failed');
      }
    }
  }

  /**
   * @description Tear down a manifest's tools, but never one another ACTIVE app still provides
   * (ADR-085 D11 done-when 3).
   *
   * Deregistration is a DELETE from `runtime_tool_executors` by name plus `enabled=false` on the
   * `tools` row. Before D11 it ran unconditionally, so when two apps shared a tool name the FIRST
   * uninstall deleted the executor out from under the survivor.
   *
   * The load-time uniqueness guard means a second provider should no longer exist, so in practice
   * this skip never fires — it is defence in depth for a database that predates the guard or was
   * edited out of band, where the alternative is silently breaking a live app.
   *
   * Note the ORDERING TRAP this depends on: `toggleApp` and `unloadApp` both call `deactivate()`
   * BEFORE flipping status / deleting the row, so the target still reads as active here. Excluding
   * it by name is mandatory — otherwise an app would always "retain" its own tools and nothing would
   * ever be torn down.
   *
   * @param manifest - The departing app's manifest.
   * @param failLoud - Throw after attempting every teardown; used before an update overwrites history.
   */
  private async deregisterManifestTools(manifest: SwarmAppManifest, failLoud = false): Promise<void> {
    if (!manifest.tools?.length) return;
    if (!this.runtimeToolRegistrationService && !failLoud) return;
    const others = (await this.repo.list()).filter(
      (r) => r.status === 'active' && r.name !== manifest.name,
    );
    await deregisterOwnedManifestTools(
      manifest,
      others,
      this.runtimeToolRegistrationService,
      failLoud,
    );
  }

  private async registerDynamicRowUis(dyn: SwarmAppDynamicUi, appName: string): Promise<void> {
    const rows = await this.queryDynamicRows(dyn);
    for (const row of rows) {
      const toolName = interpolate(dyn.toolNameTemplate, row);
      const label = String(row[dyn.labelField] ?? toolName);
      const url = interpolate(dyn.iframeUrlTemplate, row);
      if (!toolName || !url) continue;
      registerDynamicToolUI(toolName, label, dyn.icon, url, appName);
    }
    logger.info({ appName, source: dyn.source, count: rows.length }, 'Dynamic row UIs registered');
  }

  private async deregisterDynamicRowUis(manifest: SwarmAppManifest): Promise<void> {
    const dyn = manifest.ui?.dynamic;
    if (!dyn) return;
    const rows = await this.queryDynamicRows(dyn);
    for (const row of rows) {
      const toolName = interpolate(dyn.toolNameTemplate, row);
      if (toolName) deregisterDynamicToolUI(toolName);
    }
  }

  private async queryDynamicRows(dyn: SwarmAppDynamicUi): Promise<Array<Record<string, unknown>>> {
    // `source` and `where` can arrive via manifest upload (POST /api/swarm/apps/load
    // or /import), so they must be treated as UNTRUSTED. Raw SQL concatenation
    // would let an uploaded manifest run arbitrary queries against the pool.
    //
    // Contract for dyn.where: a very small allowlist of "column = literal" clauses
    // joined by AND. Each clause's column must match /^[a-z_][a-z0-9_]*$/, and
    // literals are bound as parameters ($1, $2, ...) — never concatenated.
    const safeSource = /^[a-z_][a-z0-9_]*$/i.test(dyn.source) ? dyn.source : null;
    if (!safeSource) {
      logger.warn({ source: dyn.source }, 'Rejected dynamic UI source — unsafe identifier');
      return [];
    }

    const { whereSql, params } = parseSafeWhere(dyn.where);
    if (dyn.where && whereSql === null) {
      logger.warn({ where: dyn.where, source: safeSource }, 'Rejected dynamic UI where — does not match safe-clause allowlist');
      return [];
    }

    try {
      const { rows } = await this.pool.query(
        `SELECT * FROM ${safeSource} ${whereSql ?? ''}`.trim(),
        params,
      );
      return rows as Array<Record<string, unknown>>;
    } catch (err) {
      logger.error({ err, source: safeSource }, 'Dynamic UI row query failed');
      return [];
    }
  }
}

export type { SwarmApplicationRecord, SwarmApplicationSummary, SwarmAppManifest } from '../types';
