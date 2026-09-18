# Clean kernel — Rust object model and processes

**Status:** DRAFT 2026-09-17. Design sketches: signatures and shapes, not implementation. Names here are
the vocabulary every other document in this series uses. Spec: [01](./01-high-level-spec.md);
pictures: [diagrams/](./diagrams/README.md).

The streamlining rule: **a type exists because a rule needs somewhere to live.** Each type below names
the rule it carries. If a proposed type carries no rule, it is a package's domain, not kernel.

---

## 1. `kernel-types` — objects only

Zero I/O, zero external dependencies except `serde` and `uuid`. Everything else depends on this.

```rust
// Identity — the rule: derived once, from verified claims, issuer included (C-04)
pub struct Subject(String);
pub struct Issuer(String);
pub struct TenantId(Uuid);
pub struct PrincipalId(Uuid);

pub enum PrincipalKind { Person, Service, Bot, Root }

pub struct Principal {
    pub id: PrincipalId,
    pub kind: PrincipalKind,
    pub subject: Subject,
    pub issuer: Issuer,
    pub tenant: TenantId,
}

// Grants — the rule: one tier vocabulary, explicit deny wins (T-03, ADR-118)
pub enum Tier { Deny, Viewer, Editor, Admin }
pub struct Grant { pub principal: PrincipalId, pub package: PackageId, pub tier: Tier }

// Secrets — the rule: a reference, never a value (C-05)
pub struct SecretRef(Uuid);            // no Serialize, no Display; Debug prints "SecretRef(redacted)"

// Packages — the rule: everything declared, nothing implicit (P-01)
pub struct PackageId(String);
pub struct Version(semver::Version);
pub struct SdkRange(semver::VersionReq);
pub enum PackageState { Installed, Validated, Tested, Granted, Loaded, Active, Draining, Inactive, Rejected }
pub struct Capability { pub name: CapabilityName, pub scope: Scope }

// Bots — the rule: identity + brain + posture + capabilities; untrusted principal (P4)
pub struct BotId(Uuid);
pub enum Posture { Inline, Node, Remote, External }
pub struct Bot {
    pub id: BotId,
    pub identity: PrincipalId,
    pub posture: Posture,
    pub capabilities: BTreeSet<Capability>,
    pub package: Option<PackageId>,
}

// Brain records — the rule: most specific record wins, no literal (ADR-162, B-02)
pub enum BrainRung { UserChoice, BotDefault, FleetDefault, Registry }
pub struct BrainRecord { pub rung: BrainRung, pub provider: ProviderId, pub model: ModelId }

// Tickets and envelopes — the rule: one envelope, transport separate (B-06, ADR-161)
pub struct TicketId(Uuid);
pub struct TicketType(String);
pub struct Ticket { pub id: TicketId, pub kind: TicketType, pub workflow: WorkflowId, pub owner: PrincipalId, pub status: Status }
pub struct Generation(Blake3Hash);
pub enum Transport { InProcess, DurableStream, RemoteNode, A2a }
pub struct Envelope {
    pub id: EnvelopeId,
    pub ticket: TicketId,
    pub phase: Phase,
    pub bot: BotId,
    pub scopes: BTreeSet<Capability>,   // for this phase only; there is no secret field (B-11)
    pub generation: Generation,          // pinned configuration (B-10)
}

// Workspace — the rule: the task is the common thread; no shared index (08)
pub struct WorkspaceId(Uuid);
pub struct VersionId(Blake3Hash);
pub struct PathScope(GlobSet);                 // what a claim covers
pub enum MergePolicy { Exclusive, AppendOnly, LastWriterWins, ThreeWay }  // closed vocabulary
pub struct Claim {
    pub workspace: WorkspaceId,
    pub scope: PathScope,
    pub bot: BotId,
    pub envelope: EnvelopeId,
    pub expires_with_lease: bool,
}
pub struct Commit {
    pub base: VersionId,                        // a stale base is refused (WS-04)
    pub scope: PathScope,                       // out-of-scope paths are refused, never trimmed (WS-03)
    pub author: BotId,
    pub harness: Option<HarnessKind>,
    pub node: Option<NodeId>,
    pub envelope: EnvelopeId,
}
pub struct Workspace {
    pub id: WorkspaceId,
    pub ticket: TicketId,
    pub owner: PrincipalId,
    pub tenant: TenantId,
    pub head: VersionId,
    pub state: WorkspaceState,                  // Open | Frozen | Archived
}
pub struct Artifact { pub kind: ArtifactKind, pub path: PathBuf, pub produced_by: BotId }

// Nodes — the rule: a harness is a node (B-09); harness kind is data
pub struct NodeId(Uuid);
pub enum NodeKind { Local, Remote, External }
pub enum HarnessKind { ClaudeCode, CodexCli, GeminiCli, Cline, OpenHands, Custom(String) }
pub struct Node { pub id: NodeId, pub owner: PrincipalId, pub kind: NodeKind, pub harness: Option<HarnessKind>, pub generation: Generation }

// Activation — the rule: nothing runs by declaration (T-04, ADR-157)
pub enum PrincipalClass { Person(PrincipalId), SystemService(PrincipalId) }
pub struct Activation { pub schedule: ScheduleId, pub class: PrincipalClass, pub activated_by: PrincipalId }

// Ledger — the rule: metered and reported never sum (B-12)
pub enum CostKind { Metered, Reported }
pub struct CostEvent { pub kind: CostKind, pub usd: Decimal, pub bot: BotId, pub ticket: Option<TicketId>, pub at: Timestamp }

// Refusal — the rule: typed, recorded, never silent (C-07)
pub enum RefusalCode {
    NoIdentity, IssuerNotTrusted, TenantMismatch, DenyTier, InsufficientTier,
    ConfirmationMissing, OverBudget, CapabilityNotGranted, NodeNotEnrolled, NodeNotOwner,
    GenerationMismatch, ScheduleNotActivated, PackageNotActive, SdkRangeUnsatisfied,
}
pub struct Refusal { pub code: RefusalCode, pub detail: Redacted<String> }
```

---

## 2. `control` — the door

```rust
pub enum Entry {
    Http(HttpEntry), StreamMessage(EnvelopeEntry), ScheduleTick(TickEntry),
    PackageCall(HostCallEntry), Cli(CliEntry), Channel(ChannelEntry),
}

// Mode is sealed: only these three exist, and only control names them.
pub trait Mode: sealed::Sealed {}
pub struct Read;      impl Mode for Read {}
pub struct Write;     impl Mode for Write {}
pub struct Confirmed; impl Mode for Confirmed {}
pub trait Writable: Mode {}  impl Writable for Write {}  impl Writable for Confirmed {}

pub struct Ctx<M: Mode> {
    principal: Principal,
    tenant: Tenant,
    grants: Grants,
    budget: Budget,
    span: TraceSpan,
    _mode: PhantomData<M>,
}

impl Ctx<Read> {
    pub fn store(&self) -> ScopedStore<'_, Read>;
    pub fn inference(&self) -> ScopedInference<'_>;
    pub fn intents(&self) -> ScopedIntents<'_>;
    pub fn files(&self) -> ScopedFiles<'_>;
    pub fn notify(&self) -> ScopedNotify<'_>;
}
impl Ctx<Write> {
    pub fn confirm(self, token: ConfirmationToken) -> Result<Ctx<Confirmed>, Refusal>;
}

/// The only constructor of any Ctx. pub(crate) so nothing outside control can call it.
pub(crate) fn build_ctx<M: Mode>(p: Principal, t: Tenant, g: Grants, b: Budget, s: TraceSpan) -> Ctx<M>;

/// The door. Verifies identity, resolves grants and budget, opens a span, returns a Ctx or a Refusal.
pub async fn admit(entry: Entry, want: Wanted) -> Result<Admitted, Refusal>;
pub enum Wanted { Read, Write, Confirmed(ConfirmationToken) }
pub enum Admitted { Read(Ctx<Read>), Write(Ctx<Write>), Confirmed(Ctx<Confirmed>) }

// Key derivation — the isolation boundary (T-01). One function, guarded like the token broker.
pub fn scope_key(subject: &Subject, tenant: &TenantId) -> ScopeKey;
```

Rules carried: C-01 (only `admit` yields a `Ctx`), C-02 (scoped handles come from `Ctx`), C-03 (mode
by tier and token), C-04 (identity once), C-06 (budget resolved at the door), C-07 (typed refusal),
C-08 (root read from the invariant row).

---

## 3. `store`, `mesh`, `inference`, `intents` — the four traits

```rust
// store — the rule: no raw connection outside this crate; RLS bound by the scope key (T-02)
pub trait Store: Send + Sync {
    async fn scoped(&self, key: &ScopeKey, role: GovernedRole) -> Result<Conn, StoreError>;
    async fn migrate(&self, namespace: Namespace, migrations: &[Migration]) -> Result<(), StoreError>;
}
pub struct ScopedStore<'c, M: Mode> { conn: Conn, _m: PhantomData<M>, _c: PhantomData<&'c ()> }
impl<'c, M: Mode>     ScopedStore<'c, M> { pub async fn query<T: Row>(&self, q: Query) -> Result<Vec<T>, StoreError>; }
impl<'c, M: Writable> ScopedStore<'c, M> { pub async fn execute(&self, q: Statement) -> Result<u64, StoreError>; }
// impls: PostgresStore (RLS, governed role), SqliteStore (single-node; scope key as row filter + per-key file)

// mesh — the rule: one envelope, four transports (B-06)
pub trait Stream: Send + Sync {
    async fn publish(&self, e: &Envelope) -> Result<(), MeshError>;
    async fn claim(&self, bot: BotId, node: Option<NodeId>) -> Result<Option<Envelope>, MeshError>;
    async fn ack(&self, id: EnvelopeId, outcome: Outcome) -> Result<(), MeshError>;
}
// impls: InProcessStream, RedisStreams (consumer groups), RemoteNodeQueue (claim over device-bound token)

// inference — the rule: hosted, byo and local are the same to a caller (B-04); no spawn exists here (B-05)
pub trait Provider: Send + Sync {
    fn id(&self) -> ProviderId;
    async fn complete(&self, scoped: &ScopedInference<'_>, req: CompletionRequest) -> Result<Completion, ProviderError>;
}
pub struct ScopedInference<'c> { bot: BotId, brain: ResolvedBrain, budget: &'c Budget, ledger: &'c Ledger }
// every completion writes CostEvent { kind: Metered } through the ledger before returning

// intents — the rule: the only place a SecretRef becomes a value (C-05, B-11)
pub trait IntentHandler: Send + Sync {
    fn name(&self) -> IntentName;
    fn schema(&self) -> Schema;
    async fn run(&self, secret: ResolvedSecret<'_>, input: Validated<Input>) -> Result<Normalized, IntentError>;
}
pub struct ScopedIntents<'c> { principal: &'c Principal, connectors: &'c [Connector] }
impl ScopedIntents<'_> {
    pub async fn run(&self, name: IntentName, input: Input) -> Result<Normalized, Refusal>;  // resolves inside; returns only Normalized
}
pub(crate) fn resolve(secret: &SecretRef) -> ResolvedSecret<'_>;   // pub(crate): unreachable from any other crate
```

---

## 4. `orchestration`

```rust
pub struct Dispatcher { registry: WorkflowRegistry, stream: Arc<dyn Stream>, ledger: Ledger }
impl Dispatcher {
    /// B-07: a type with no loaded workflow stays queued.
    pub async fn poll(&self) -> Result<(), DispatchError>;
    /// C-06: budget at the door before publish.
    async fn dispatch_phase(&self, ctx: &Ctx<Write>, t: &Ticket, phase: Phase) -> Result<EnvelopeId, Refusal>;
}
pub struct WorkflowRegistry;   // loaded from manifests and studio-compiled definitions; the runtime is the authority
pub struct Activations;        // ADR-157: tick(schedule) → find Activation → admit as its principal → dispatch
pub struct StatusHistory;      // every transition a row; TraceService reads rows and never invents a span (ADR-107)
```

---

## 5. `packages` and `sdk`

```rust
pub struct Manifest { /* today's oshal-app.yaml shape: name, suite, uses, dependencies, bots, tools, routes, schedules, migrations, surfaces, readiness, status, kind */ }

pub trait PackageHost: Send + Sync {
    async fn load(&self, pkg: &Package, granted: &BTreeSet<Capability>) -> Result<LoadedPackage, HostError>;
    async fn call(&self, loaded: &LoadedPackage, entry: HostCallEntry) -> Result<Response, Refusal>; // goes through admit()
    async fn drain(&self, loaded: &LoadedPackage) -> Result<(), HostError>;
}
// impls: WasmComponentHost (wasmtime), ProcessHost (Node, Python; same interface over local IPC)

pub struct Loader { hosts: Vec<Arc<dyn PackageHost>>, registries: Registries }
impl Loader {
    pub async fn install(&self, ctx: &Ctx<Confirmed>, source: RegistryRow, spec: PackageSpec) -> Result<Package, Refusal>;
    pub async fn validate(&self, pkg: &Package) -> Result<(), Rejection>;     // manifest, SDK range, capabilities
    pub async fn sandbox_test(&self, pkg: &Package) -> Verdict;               // P-05 verdict integrity
    pub async fn grant(&self, ctx: &Ctx<Confirmed>, pkg: &Package, caps: BTreeSet<Capability>) -> Result<(), Refusal>;
    pub async fn load(&self, pkg: &Package) -> Result<LoadedPackage, HostError>;   // migrations in namespace
    pub async fn activate(&self, ctx: &Ctx<Write>, pkg: &Package) -> Result<(), Refusal>;
    pub async fn upgrade(&self, ctx: &Ctx<Confirmed>, from: &Package, to: &Package) -> Result<(), Refusal>; // drain
    pub async fn deactivate(&self, ctx: &Ctx<Write>, pkg: &Package) -> Result<(), Refusal>;
    pub async fn unload(&self, ctx: &Ctx<Confirmed>, pkg: &Package) -> Result<(), Refusal>;
}

// sdk — what a package sees. Depends on kernel-types only.
pub mod sdk {
    pub trait Route { fn schema(&self) -> Schema; async fn handle(&self, ctx: PackageCtx, input: Validated<Input>) -> Response; }
    pub struct PackageCtx { /* ScopedStore in the package namespace, ScopedInference, ScopedIntents, ScopedFiles, ScopedNotify — only those granted */ }
    pub trait Tool { fn schema(&self) -> Schema; async fn run(&self, ctx: PackageCtx, input: Validated<Input>) -> Normalized; }
    pub struct BotDecl { pub name: String, pub posture: Posture, pub persona: PersonaData, pub default_brain: Option<BrainRecord> }
    pub struct ScheduleDecl { pub name: String, pub cron: Cron, pub route: RouteName }   // an offer; runs only after Activation
    pub struct StatusReport { /* ADR-145: rendered by the kernel without knowing the schema */ }
}
```

---

## 6. `observe`

```rust
pub struct TraceSpan;      // opened and closed by the door; carries principal, tenant, package, duration, outcome
pub struct AuditEvent;     // one per admitted or refused entry
pub struct Ledger;         // the single cost ledger; budgets, traces and cockpit totals read it (O-02)
pub trait Sink { fn emit(&self, redacted: Redacted<Record>); }   // every sink passes the redaction test (O-04)
pub fn inventories() -> Inventories;  // generated: entries + admission class, packages, bots, capabilities, tests (O-03)
```

---

## 7. `oshal-node` — the harness adapter

```rust
pub struct NodeAgent { token: DeviceBoundToken, node: Node, bots: Vec<BotId>, adapter: Box<dyn HarnessAdapter> }
pub trait HarnessAdapter: Send + Sync {
    fn kind(&self) -> HarnessKind;
    fn capabilities(&self) -> HarnessCapabilities;            // edit | shell | browse | gpu | display (HA-04)
    fn generation(&self) -> Generation;                       // hash of the pinned tool/handler configuration (B-10)
    /// Materialize the claimed subtree; the harness then works its own way inside it.
    async fn materialize(&self, m: Materialization) -> Result<LocalDir, HarnessError>;
    async fn run(&self, env: &Envelope, dir: &LocalDir, kernel: KernelClient) -> Result<(), HarnessError>;
    /// None means the kernel diffs the materialization itself (HA-03).
    async fn collect(&self, dir: &LocalDir) -> Result<Option<ChangeSet>, HarnessError>;
}
pub struct KernelClient;  // heartbeat, claim, intent(name, input) as the bot principal, complete(artifacts, reported_cost)
pub struct RunResult { pub artifacts: Vec<Artifact>, pub reported_cost: Option<Decimal>, pub generation: Generation }
```

Adapters: `claude-code`, `codex-cli`, `gemini-cli`, `cline`, `openhands`, `custom` (a command line and a
result contract). The kernel holds none of their credentials and spawns none of them.

---

## 8. Processes

Each process is a numbered sequence; the diagram it maps to is named.

**P-A Admission** (diagram 02): entry → verify claims → Principal → grants + budget → refusal or
`Ctx<M>` → handler derives scoped handles → door closes span, writes audit and cost.

**P-B Dispatch** (diagram 05): poll → workflow for type or wait → admit dispatch → budget → publish
envelope with phase scopes and generation → transport by posture → bot admitted as itself → artifacts,
cost, history row → next phase or close.

**P-C Package lifecycle** (diagram 04): install from trusted row → validate → sandbox test with verdict
integrity → grant → load (link granted capabilities, run namespaced migrations) → activate → upgrade by
drain → deactivate → unload. No kernel restart at any step.

**P-D Node claim** (diagram 06): enroll with ownership proof → device-bound token → bind bots →
heartbeat with generation → claim → run with pinned generation → intents as bot principal → complete
with reported cost → admitted as bot.

**P-E Activation** (diagram 07): declared schedule → person or portal admin activates naming a
principal class → tick admits as that principal → dispatch. Unactivated ticks are refused and recorded.

**P-F Self-writing** (diagram 09): producer emits package → registry → P-C → inactive until a person
activates. Kernel change → branch → pull request → publish gate → human merge.

**P-G Upgrade of the kernel** (diagram 08): new artifact starts → embedded migrations → health converges
→ old artifact retired. Rollback is the previous artifact.

---

## 9. What is deliberately absent

- No `Harness` type in the kernel. `HarnessKind` is data on a `Node`.
- No `Container`, `Compose` or mount concept. Placement is a posture plus a mode.
- No domain object: no trade, drone, email, presentation, lesson, lot or campaign. Those are package
  schemas the kernel never learns (ADR-145).
- No unscoped pool, client or provider handle exported from any crate.
- No `console.log` equivalent: `observe::Sink` is the only output and every sink is redacted.
