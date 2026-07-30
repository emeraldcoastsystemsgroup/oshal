/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial SwarmApplication types per ADR 2026-04-20
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SwarmAppWorkflow.autoStart — per-workflow opt-in so a published workflow's tickets auto-approve and run on arrival.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | 'operator' scope — admin-only apps (first: security-center) hidden from every non-operator's catalog/ribbon; migration 064 widens the DB CHECK.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 P1: ManifestRouteMounter port — lets an installed app package mount its own compiled-JS routes at activation (impl lives in the app layer; flag-gated).
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | dependencies.connectors doubles as the app's runtime connector allow-list (present = only providers its surfaces may offer, [] = none, absent = unfiltered) — documented semantics; consumed via synthesiseProfile.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085: ManifestBotRegistrar port (packaged bots join the active registry at activate — no core-registry hand-edits) + RagCollectionTeardown port and manifest.ragCollections globs (RAG ownership in uninstall impact; deleted only under the dropData opt-in).
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D9: SwarmAppAssistant + ui.assistant — a floating assistant bubble the FRAMEWORK renders from the manifest. This is the declarative alternative to package shell-JS injection (operator decision 2026-07-13): a package's script would run in the cockpit's AUTHENTICATED origin, able to read any DOM content and call any API as the signed-in user. Auth-gating the script FILE does not constrain what the file DOES, and CSP is no mitigation (off by default; script-src 'self' would permit a same-origin package script anyway).
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | ADR-097: SwarmAppSuite — app-level primary categorization (closed enum) + manifest.suite + summary.suite. Suites shelve APPS; tool category: stays independent and is never how a suite is derived.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | ADR-090 addendum: manifest.skillProfiles — an app's domain patterns for profileable bot capabilities (SkillCapabilityId → SkillProfile, from @/shared/skill-profiles). Distinct from uses: (kernel MODULES); keys are capabilities, not KernelSkillId. Resolved controller-side at dispatch, composed into the bot prompt (ADR-036 — no kernel LLM call).
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | manifest.surface (SwarmAppSurfaceDeclaration) — the app's surface-bridge op allow-list (`surface.ops`, @/shared/surface-bridge-ops vocabulary). FAIL-CLOSED: no declaration = the cockpit relay forwards NO bridge ops for this app. Validated at load; forwarded to the cockpit as synthesiseProfile.surfaceOps.
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | SwarmApplicationSummary gained `icon: string | null` (first ribbon-tile/assistant codicon) so listing surfaces render a real icon.
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Add the declarative hideAssistant ribbon policy for immersive app surfaces.
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Let packaged bots declare a validated harness and API provider instead of inheriting the registrar's Claude-only runtime.
 */

import type { SwarmAppRouteAuthMode } from '@/shared/route-auth';
import type { SwarmAccessRole } from '@/shared/types/access-roles';
import type { GuestTier } from '@/shared/middleware/guest-capability-matrix';
import type { SkillCapabilityId, SkillProfile } from '@/shared/skill-profiles';
import type { SurfaceBridgeOpName } from '@/shared/surface-bridge-ops';


/**
 * Visibility scope of an app / workflow (an app IS a queue):
 *   - 'public'   — globally visible (default; most framework apps).
 *   - 'person'   — visible only to its owner_sub (+ operators). Owner is stamped at
 *                  publish time from the authenticated session, never from the manifest.
 *   - 'tenant'   — visible to a tenant; tenant-wide filtering is wired with the broader
 *                  multi-tenant work. Until then, non-operators only see public + own.
 *   - 'operator' — visible ONLY to operators (admin tooling, e.g. security-center: its
 *                  findings map the platform's own weak points). The route mount carries
 *                  the real gate (requiresOperator); this scope hides the catalog entry.
 */
export type SwarmAppScope = 'person' | 'tenant' | 'public' | 'operator';

/**
 * ADR-097: the user-facing suites — the ONE primary shelf an app occupies in the catalog,
 * chosen by who the app is for / what job it does. Deliberately a CLOSED set: adding a suite
 * is a schema change here plus an ADR update, never a manifest-side invention (that is what
 * keeps 40+ apps from drifting back into a flat pile). Two rules that are easy to get wrong:
 *   - An app declares exactly one suite even when its tools span categories — suite is NEVER
 *     derived from tool `category:` values (daily-trade-recap bundles media + communication
 *     tools but shelves under ai-finance; the tools describe ingredients, the suite the job).
 *   - Suite is METADATA for grouping/browsing only. The package unit stays one app = one
 *     package (ADR-085) — suites are not install bundles.
 * 'platform' is the pinned framework row (jarvis, connectors), not a browsable suite.
 */
export const SWARM_APP_SUITES = [
  'ai-productivity',
  'ai-knowledge',
  'ai-finance',
  'ai-creative',
  'ai-home',
  'ai-engineering',
  'platform',
] as const;

/** One of the closed set of catalog suites (ADR-097). */
export type SwarmAppSuite = (typeof SWARM_APP_SUITES)[number];

/**
 * @description Type guard for SwarmAppSuite — used by the manifest loader to fail closed on
 * a typo'd suite (an unknown value must not silently invent a new catalog shelf).
 * @param value - candidate suite value from a parsed manifest
 * @returns true when the value is a member of the closed suite set
 */
export function isSwarmAppSuite(value: unknown): value is SwarmAppSuite {
  return typeof value === 'string' && (SWARM_APP_SUITES as readonly string[]).includes(value);
}

/** Closed set of execution harnesses an application manifest may select for a bot. */
export const SWARM_APP_BOT_HARNESS_TYPES = [
  'cline',
  'codex-cli',
  'claude-code',
  'gemini-cli',
  'a2a',
  'noop',
] as const;

/** @description A validated packaged-bot execution harness. */
export type SwarmAppBotHarnessType = (typeof SWARM_APP_BOT_HARNESS_TYPES)[number];

/** API identifiers used only by fixed harnesses and not present in the general provider schema. */
export const SWARM_APP_BOT_SPECIAL_API_TYPES = ['google-gemini', 'a2a', 'noop'] as const;

/** @description Extra fixed-harness API identifiers accepted at the manifest boundary. */
export type SwarmAppBotSpecialApiType = (typeof SWARM_APP_BOT_SPECIAL_API_TYPES)[number];

/** One bot declared by an application manifest. */
export interface SwarmAppBotDeclaration {
  agentId: string;
  name: string;
  /** Explicit bot runtime. Omit both runtime fields to retain the legacy package default. */
  harnessType?: SwarmAppBotHarnessType;
  /** Provider consumed by the selected harness; loader validation enforces compatible pairs. */
  apiType?: string;
  persona?: string;
  role?: string;
  capabilities?: string[];
  selectorDescriptor?: string;
  routingKeywords?: string[];
  /** How Jarvis should REACH this bot once it has selected it.
   *
   *  - `handoff` (default) — Jarvis deep-links the user to the app's own surface. Correct for a
   *    data app whose surface must build context before it can answer.
   *  - `delegate` — Jarvis calls the bot and synthesizes its reply inline, so the user gets an
   *    answer in the chat instead of a link.
   *
   *  Before this existed every dynamically discovered app was hardcoded to `handoff`, so an
   *  installed app could be correctly selected and still never answer a question. Omit to keep
   *  the historical behaviour. */
  jarvisMode?: 'delegate' | 'handoff';
  /** ADR-087 / ADR-085 D3: which CALLER ROLES may discover and call this bot —
   *  `operator` | `swarm` | `jarvis`.
   *
   *  **Omit = open to every caller** (ADR-087's backward-compatibility contract; core bots behave
   *  the same way). Declaring the list NARROWS: e.g. `[operator, swarm]` removes the bot from
   *  Jarvis's catalog and from the call-out candidates for jarvis-sourced tickets, so internal or
   *  privileged machinery can be scoped out of the assistant's world.
   *
   *  A packaged bot could only ever be OPEN before this field existed — the registrar dropped the
   *  concept entirely — which is the ADR-087 parity gap D3 closes. Validation is fail-closed: an
   *  unknown role, or an empty list (`accessRoles:` with no values parses to null/[]), is a
   *  load-time error rather than a silently-unrestricted bot. */
  accessRoles?: SwarmAccessRole[];
}

/** Executable tool contributed by an application manifest. */
export interface SwarmAppToolDeclaration {
  name: string;
  displayName?: string;
  type?: 'mcp' | 'api' | 'cli' | 'presentron' | 'rag';
  category?: string;
  version?: string;
  description: string;
  installSpec?: Record<string, unknown>;
  skills?: string[];
  selectorFragment?: string;
  routingTags?: string[];
  authGroup?: string;
  defaultAuthMode?: 'auto' | 'ask' | 'off';
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  usageInstructions?: string;
  examples?: unknown[];
  requiresApproval?: boolean;
  timeoutMs?: number;
  tags?: string[];
  enabled?: boolean;
  registeredBy?: string;
  executor: {
    executorType: 'builtin' | 'cli' | 'api' | 'mcp';
    cliCommand?: string;
    apiEndpoint?: string;
    mcpServerName?: string;
    builtinKey?: string;
  };
}

/** A static ribbon icon declared in the manifest. */
export interface SwarmAppStaticUi {
  toolName: string;
  label: string;
  icon: string;
  iframeUrl: string;
  section?: 'top' | 'bottom';
}

/** A DB-sourced dynamic ribbon icon spec (one icon per row). */
export interface SwarmAppDynamicUi {
  source: string;
  where?: string;
  toolNameTemplate: string;
  labelField: string;
  icon: string;
  iframeUrlTemplate: string;
  section?: 'top' | 'bottom';
  /**
   * ADR-085 generic per-user visibility (replaces the app-specific enrollment filter
   * that lived in core before the LM carve-out): when declared, GET /api/tools/dynamic
   * loopback-calls `endpoint` WITH THE CALLER'S SESSION; the app returns
   * `{ keys: string[] }` — the exact toolNames this caller may see — and core hides
   * every registered tool matching `pattern` (glob) that isn't in the list.
   * FAIL-CLOSED: an unreachable/erroring endpoint hides all matching tools.
   */
  visibility?: {
    /** App-owned route returning { keys: string[] } for the calling user, e.g. /api/education/class-tool-keys */
    endpoint: string;
    /** Glob selecting which of this app's dynamic tools are subject to filtering, e.g. lm-class-* */
    pattern: string;
  };
}

/** Route factory declaration — loader resolves `module` to the factory export. */
export interface SwarmAppRouteDeclaration {
  module: string;
  factory: string;
  mountPath: string;
  /** ADR-085 D2: how this route is authenticated —
   *  `oidc` (default, applied on OMISSION) | `service-or-oidc` | `service` | `operator` | `public`.
   *
   *  Auth is opt-in per route in this codebase, so a package route must never become
   *  anonymous-callable by a forgotten field: omission means `oidc`, and `readManifest` fails
   *  closed on an unknown mode. Every declaration sharing a `mountPath` must agree on the mode —
   *  the mounter runs a mount's guards before dispatching its chain, so a stricter sibling would
   *  otherwise reject requests bound for a laxer one. See @/shared/route-auth. */
  auth?: SwarmAppRouteAuthMode;
  /** @deprecated Superseded by `auth`. Kept so pre-D2 manifests keep working (`false` ⇒ `public`).
   *  Declaring BOTH is allowed only when they agree; contradicting them is a load-time error. */
  requiresAuth?: boolean;
  /** @deprecated DEAD FIELD — nothing in the framework consumes it. Do not model new fields on it. */
  requiresContext?: boolean;
}

/** One stage of a `pipeline: 'staged'` workflow — an existing bot pinned to a step,
 *  optionally ending in a human approval gate. Mirrors WorkflowStageDefinition in
 *  dispatch-routing (structurally compatible; kept local so this types module stays
 *  free of a swarm-orchestration import). */
export interface SwarmAppWorkflowStage {
  bot: string;
  name?: string;
  approvalAfter?: boolean;
}

/** Workflow pipeline contributed to the WorkflowPipelineRegistry. */
export interface SwarmAppWorkflow {
  name: string;
  pipeline: string;
  workerBot: string;
  /** Optional Phase-2 reviewer bot (e.g. queue-bot for incident-rca). When
   * omitted the dispatcher hits the graceful-completion path after worker
   * deliverables — no review/revision cycle. */
  reviewerBot?: string;
  phases?: string[];
  maxRevisions?: number;
  /** Ordered stages for a 'staged' (authored multi-bot) workflow. Each stage pins an
   *  existing bot and may end in a human approval gate. Ignored by other pipelines. */
  stages?: SwarmAppWorkflowStage[];
  /** Compiled ProcessDefinition (nodeGraph) for a 'graph' workflow — executed by the
   *  ProcessDefinitionExecutionEngine via the queue-manager 'graph' dispatch path.
   *  Carried inline so it round-trips through the manifest. Loosely typed to keep this
   *  module free of a workflow-studio dependency. */
  processDefinition?: Record<string, unknown>;
  /** When true, tickets of this workflow's ticketType auto-approve on arrival so the workflow
   *  runs without a manual backlog approval (human gates live in the graph's approval-gate nodes).
   *  Per-workflow opt-in set at publish; default omitted = manual approval. */
  autoStart?: boolean;
}

/**
 * @description A floating assistant bubble the framework renders on behalf of an app (ADR-085 D9).
 *
 * This is the DECLARATIVE alternative to letting a package inject JavaScript into the cockpit shell,
 * and it exists because the shell-JS route is a trust boundary we decided not to cross (operator
 * decision, 2026-07-13). A package's script would run in the cockpit's **authenticated origin** — it
 * could read any DOM content, call any API as the signed-in user, and exfiltrate both. Auth-gating
 * the script FILE does nothing about that (it protects the file from anonymous readers, not the
 * browser from the file), and CSP is no mitigation either: it is off by default, and `script-src
 * 'self'` would explicitly permit a same-origin package script.
 *
 * JS injection is also not symmetric with CSS the way the original design assumed: removing a
 * `<script>` element does not undo what it executed — appended nodes, document listeners and html
 * classes all survive. A "remove" path would have been false comfort.
 *
 * Everything little-monsters' `lm-concierge.js` actually did is expressible here: hide the chat rail
 * (that is `ribbon.hideChatPanel`, which already worked), and float a button that opens its tutor in
 * an iframe. No package code runs in the shell.
 */
export interface SwarmAppAssistant {
  /** Button label / tooltip (e.g. "Tutor"). */
  label: string;
  /** Codicon class for the bubble (e.g. `codicon codicon-mortar-board`). */
  icon: string;
  /** SAME-ORIGIN, root-relative path the bubble opens in an iframe (e.g. `/api/education/tutor`).
   *  Validated fail-closed at load: an absolute URL, a protocol-relative `//host`, or a
   *  `javascript:` URL is rejected — the bubble must never become a cross-origin embed. */
  iframeUrl: string;
  /** Optional panel title; defaults to `label`. */
  title?: string;
}

/**
 * @description The app's surface-bridge declaration — which `oshal-surface-bridge` ops the
 * cockpit relay may carry between this app's embedded surface and its chat rail (the browser
 * wiring over `@/features/surface-bridge`).
 *
 * FAIL-CLOSED by design: an app with no `surface:` block gets NO ops relayed — the relay treats
 * an absent allow-list as empty, so a package cannot drive its surface (or emit user events at
 * its bot) through the bridge without declaring the vocabulary it uses, the same
 * declare-what-you-need posture as `dependencies.connectors`. Op names are validated at load
 * against the closed shared vocabulary (@/shared/surface-bridge-ops) — a typo is a load error,
 * not a silently-dead bridge.
 */
export interface SwarmAppSurfaceDeclaration {
  /** The ONLY bridge ops the cockpit relays for this app (either direction). `[]` = none. */
  ops: SurfaceBridgeOpName[];
}

/** Optional focus-mode ribbon policy (extension beyond base ADR schema). */
export interface SwarmAppRibbonPolicy {
  focused?: boolean;
  hideFrameworkItems?: string[];
  defaultView?: string;
  /** Hide the cockpit's right-rail chat panel entirely for this app (no panel,
   *  no expand affordance). For apps that ARE the chat surface (e.g. Jarvis),
   *  so the redundant swarm-bot panel doesn't sit alongside the app's own UI. */
  hideChatPanel?: boolean;
  /** Hide the cockpit's global Jarvis/DEV assistant orb while this app is focused.
   *  This does not affect an app-owned `ui.assistant` declaration. */
  hideAssistant?: boolean;
}

/**
 * A recurring job an app declares — its "default polls". The loader registers
 * each one when the app is enabled. `scope: 'framework'` (the default) is a
 * system-wide job, on by default (e.g. the always-on intelligence loop).
 * `scope: 'per-user'` is meant to activate when a user connects `requiresConnection`
 * (e.g. their Facebook) — declared here but NOT yet auto-wired by the loader.
 * Schedules only EXECUTE when the agent scheduler is enabled (ENABLE_AGENT_SCHEDULER=true).
 */
export interface SwarmAppScheduleDeclaration {
  /** Unique within the app; combined with the app name to form the schedule id. */
  id: string;
  /** Cron expression (standard 5-field, e.g. every 6 hours). */
  cron: string;
  /** The agentic task to run on each tick. */
  prompt: string;
  /** Agent id to run on; defaults to the framework's default chat agent when omitted. */
  targetAgent?: string;
  /** 'framework' (default) = system-wide, on by default. 'per-user' = activates on connect (deferred). */
  scope?: 'framework' | 'per-user';
  /** (per-user only) connector/provider that must be connected first, e.g. 'facebook'. */
  requiresConnection?: string;
  /** Human-readable label for surfaces. */
  description?: string;
  /** Set false to declare-but-not-register. Defaults to true. */
  enabled?: boolean;
}

/**
 * Thin hook the loader calls per framework-scope schedule. The composition root
 * implements it against the scheduling service. Injected (not imported) to keep
 * the swarm-apps slice decoupled from the scheduler.
 */
export type ManifestScheduleRegistrar = (input: {
  scheduleId: string;
  cron: string;
  prompt: string;
  targetAgent?: string;
  queue: string;
}) => Promise<void>;

/**
 * Counterpart hook the loader calls on DEACTIVATE with every schedule id the app's
 * manifest declares, so toggling an app off tears its recurring jobs down — the
 * runaway-schedule cost bug (ADR-085 P0: a toggled-off app's polls kept firing and
 * billing). The composition root deletes the exact `app:{appName}-{scheduleId}`
 * schedules plus their per-user `:{sub}` instances. Injected (not imported) to keep
 * this slice decoupled from the scheduler.
 */
export type ManifestScheduleDeregistrar = (input: {
  appName: string;
  scheduleIds: string[];
}) => Promise<void>;

/**
 * Port for dynamically mounting/unmounting a package's server-side routes at app
 * activation time — the mechanism (ADR-085) that lets an installed app package bring
 * its own Express routes WITHOUT them being compiled into the core image and hard-mounted
 * in server.ts. The concrete implementation lives in the app layer (it needs the Express
 * app + auth middleware + AppContext); it is injected here so the swarm-apps slice stays
 * decoupled from `@/app`. Implementations MUST be a no-op unless the operator has opted in
 * (feature flag) so activation is byte-for-byte unchanged by default.
 */
export interface ManifestRouteMounter {
  /**
   * Mount every route the manifest declares, resolving each `module` as compiled JS
   * relative to `packageDir` (the directory the app's manifest was loaded from).
   * @param appName - the owning app (mounted/unmounted as a unit)
   * @param packageDir - absolute dir containing the app's compiled route modules
   * @param routes - the manifest's `routes[]` declarations
   */
  mount(appName: string, packageDir: string, routes: SwarmAppRouteDeclaration[]): Promise<void>;
  /** Remove every route previously mounted for this app. Idempotent. */
  unmount(appName: string): void;
}

/**
 * Port for contributing an installed app's bots to the ACTIVE bot registry at
 * activation time (ADR-085) — the mechanism that makes packaged bots dispatchable
 * (endpoint resolution, harness override, wiring audit) with ZERO hand-edits to the
 * static registry files. Impl lives in the app layer (extensions/swarm); injected so
 * this slice stays decoupled from `@/app`. Omitted → registration is a no-op (bots
 * still run on the inline manifest-worker path, but fail the boot wiring audit).
 */
export interface ManifestBotRegistrar {
  /** Register the app's bots (replaces any prior registration for the app). */
  register(appName: string, bots: SwarmAppBotDeclaration[]): void;
  /** Retract the app's bots (toggle-off/uninstall). Idempotent. */
  unregister(appName: string): void;
}

/**
 * Port for RAG collection impact + teardown at uninstall (ADR-085 §5 + ADR-091).
 * The manifest's `ragCollections` globs are expanded against live collection names
 * for the impact report, and deleted (per-name, idempotent, non-fatal) when the
 * operator opts into data loss. Injected — FSD forbids this slice importing
 * `@/features/rag`. Omitted → RAG impact/teardown is a no-op.
 */
export interface RagCollectionTeardown {
  /** All live collection names (used to expand the manifest's globs). */
  list(): Promise<string[]>;
  /** Delete one collection by exact name. Idempotent. */
  deleteCollection(name: string): Promise<void>;
}

/** The YAML manifest shape, as parsed from swarm-apps/*.yaml. */
export interface SwarmAppManifest {
  name: string;
  displayName: string;
  description?: string;
  version?: string;
  status?: 'active' | 'inactive';
  /** Visibility scope. Defaults to 'public' when omitted. A published person-scoped
   *  manifest may declare 'person', but the owning user is supplied separately at
   *  publish time (from the session) — never trusted from the manifest body. */
  scope?: SwarmAppScope;
  /** ADR-097: the app's ONE primary catalog shelf (closed enum — see SWARM_APP_SUITES).
   *  Optional for pre-097 installed packages (loader warns); every in-repo manifest and
   *  everything the generators emit declares it. Never derived from tool categories. */
  suite?: SwarmAppSuite;
  /** Optional: a deterministic / UI-only app (e.g. payments) declares no bots. */
  bots?: SwarmAppBotDeclaration[];
  foundation?: { persona: string };
  toolsDir?: string;
  tools?: SwarmAppToolDeclaration[];
  ui?: {
    static?: SwarmAppStaticUi[];
    dynamic?: SwarmAppDynamicUi;
    /** ADR-085 D9: a floating assistant bubble the FRAMEWORK renders for this app. */
    assistant?: SwarmAppAssistant;
  };
  /** Surface-bridge op allow-list (fail-closed: absent = the relay carries nothing). */
  surface?: SwarmAppSurfaceDeclaration;
  routes?: SwarmAppRouteDeclaration[];
  migrations?: string[];
  /** ADR-085 §5 + ADR-091: glob prefixes of the RAG collections this app owns
   *  (e.g. ["lm-class-*", "lm-cls-*"]). Expanded against live collection names in
   *  the uninstall-impact report; deleted at uninstall ONLY under the explicit
   *  dropData opt-in (data-loss gate — toggle-off never touches them). */
  ragCollections?: string[];
  ticketType?: string;
  workflow?: SwarmAppWorkflow;
  /** Default recurring jobs ("polls") the loader registers when this app is enabled. */
  schedules?: SwarmAppScheduleDeclaration[];
  /** Explicit right-rail chat agent (a bot name). Lets an app talk to an ADVISOR bot
   *  while a different bot is the workflow worker. Defaults to workflow.workerBot. */
  chatBot?: string;
  theme?: string;
  sharedCss?: string;
  ribbon?: SwarmAppRibbonPolicy;
  /** ADR-085: apps/tools/connectors this app needs. Resolved at install (the CLI/installer
   *  pulls missing apps from the store, fail-closed); consulted at UNINSTALL for the
   *  reverse-dependency guard — removing an app that another installed app depends on is
   *  blocked unless forced, and nothing ever auto-cascades.
   *
   *  `connectors` is ALSO the app's connector allow-list at runtime: when the key is
   *  PRESENT it is the complete set of connector provider ids this app's surfaces may
   *  offer (`[]` = offer none — the kids' app never asks for Facebook); when ABSENT
   *  (legacy manifests) nothing is filtered. synthesiseProfile forwards it to the
   *  cockpit/welcome surfaces. NOTE: the store CLI scaffold emits `connectors: []`,
   *  so every new store app hides the connector catalog until it declares needs —
   *  that is the intended declare-what-you-need default. */
  dependencies?: {
    apps?: string[];
    tools?: string[];
    connectors?: string[];
  };
  /** ADR-085 D4: the guest tier this app REQUESTS — `full` | `readonly` | `blocked`.
   *
   *  **A request, not a grant.** It is stored and surfaced for review, and does NOTHING until an
   *  operator approves it (`PATCH /api/swarm/apps/:name/guest-tier`, operator-only). Until then the
   *  app gets the safe default: guests may read, every mutation is blocked.
   *
   *  Why it cannot be self-service: guests are UNAUTHENTICATED. If a package set its own tier,
   *  installing one would silently widen what an anonymous visitor can reach — `full` includes
   *  WRITES. An app cannot be trusted to decide how much of itself to expose to the public; the
   *  person who owns the deployment decides (operator decision, 2026-07-13).
   *
   *  This replaces core hardcoding each app's tier in the guest-capability matrix — the coupling the
   *  store migration exists to remove. Core's lists still win for core segments; a package can only
   *  contribute a tier for a segment core does not claim. */
  guestTier?: GuestTier;
  /** ADR-090 D8: the KERNEL SKILLS this app calls (`@/shared/kernel-skills` ids — e.g.
   *  `deck-generation`, `rag`, `voice`). A skill is a shared capability the kernel always
   *  provides; it is NOT an app, so it never installs, never ref-counts, and can never be
   *  uninstalled out from under you. Declaring it here is how a package says "I import
   *  `@/features/presentation-generation`" — the CI guard (scripts/check-kernel-skills.ts)
   *  then keeps that module in the built image for as long as the skill is declared.
   *
   *  This replaces the mis-declaration it supersedes: little-monsters listed the
   *  `presentations` APP under `dependencies.apps` when what it actually needs is the
   *  always-present deck-generation SKILL (migration plan §2, "skills with a surface" —
   *  carving presentations takes its surface only, the engine stays kernel). Validation is
   *  fail-closed: an unknown skill id is a load-time error, not a mount-time crash. */
  uses?: string[];
  /** ADR-090 addendum (skill profiles): the app's domain PATTERNS for profileable capabilities
   *  the accountable bot performs — keyed by capability id (`summarize`, …; the closed
   *  `SkillCapabilityId` set, validated fail-closed at load). A profile teaches a generic
   *  capability the app's domain so the SAME bot capability yields domain-appropriate output
   *  (class notes vs meeting notes) — it is NOT a kernel MODULE (that is `uses:`), so its keys
   *  are the capability vocabulary, never a `KernelSkillId`. Resolved CONTROLLER-side at dispatch
   *  and composed into the prompt text the bot reasons over (no kernel LLM call; ADR-036).
   *  Registered on activate / torn down on deactivate, like tools and schedules. */
  skillProfiles?: Partial<Record<SkillCapabilityId, SkillProfile>>;
  /** ADR-085 provenance stamped by the installer (git-subdir source). Informational. */
  source?: {
    type?: string;
    url?: string;
    path?: string;
    ref?: string;
  };
}

/** Persisted record as stored in the swarm_applications table. */
export interface SwarmApplicationRecord {
  appId: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  status: 'active' | 'inactive';
  manifestPath: string;
  agentIds: string[];
  toolNames: string[];
  manifest: SwarmAppManifest;
  /** Visibility scope (defaults to 'public' for legacy/framework rows). */
  scope: SwarmAppScope;
  /** Owning user (OIDC sub) for person-scoped apps; null otherwise. */
  ownerSub: string | null;
  /** Owning tenant for tenant-scoped apps; null otherwise. */
  tenantId: string | null;
  /** ADR-085 D4: the guest tier an OPERATOR APPROVED for this app. null = not approved = the safe
   *  Tier-B default (guests read, every mutation blocked). The manifest's `guestTier` is only a
   *  REQUEST — a package must never be able to widen its own exposure to unauthenticated visitors. */
  guestTierApproved: GuestTier | null;
  loadedAt: Date;
  updatedAt: Date;
}

/** Summary view for listing endpoints. */
export interface SwarmApplicationSummary {
  name: string;
  displayName: string;
  description: string;
  version: string;
  status: 'active' | 'inactive';
  botCount: number;
  toolCount: number;
  /** First ribbon-tile (or assistant) codicon class for this app, e.g. "codicon codicon-files",
   *  surfaced so listing UIs can show a real icon instead of a placeholder; null when the manifest
   *  declares no UI icon. */
  icon: string | null;
  /** ADR-097 primary catalog shelf; null only for pre-097 installed packages. */
  suite: SwarmAppSuite | null;
  manifestPath: string;
  loadedAt: string;
  updatedAt: string;
  /** This app's queue id (an app IS a queue; queueId === name). */
  queueId: string;
  /** The legacy ticketType this app's workflow handles (the schedule/ticket type
   *  filter key), or null for interactive apps with no queue. */
  ticketType: string | null;
  /** Visibility scope of this app/queue/workflow. */
  scope: SwarmAppScope;
  /** Owning user (OIDC sub) for person-scoped apps; null otherwise. */
  ownerSub: string | null;
  /** Owning tenant for tenant-scoped apps; null otherwise. */
  tenantId: string | null;
}
