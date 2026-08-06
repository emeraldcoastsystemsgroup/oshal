/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Source-ACL sync mapper (ADR-069 / permission-aware RAG): translate a source system's NATIVE per-document permissions (Google Drive share list, Slack channel membership, GitHub repo visibility+collaborators) into the RAG ACL metadata the retrieval permission filter enforces, so ingested chunks carry the source's own access rules. Fail-closed: an identity we cannot express never grants. Pure + testable; no live credentials required to unit-prove the mapping.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Preserve the OSHAL owner subject exactly while retaining cleanup for source-system emails/groups/domains; identity case/whitespace must not be normalized into another owner.
 */

/**
 * The engine-neutral intermediate an ingestion path produces from a source document's native
 * permissions, before it is serialized to the flat string metadata ChromaDB stores. Every mapper
 * normalizes to this shape so the serializer and the caller-context conventions stay in one place.
 */
export interface RagSourceAcl {
  /** Source user identities (verified emails / stable ids) — matched at query time against the caller's sub UNION emails. */
  users: string[];
  /** Named source groups (a Google Group, a GitHub team, a Slack workspace) — serialized as `group:<id>`. */
  groups: string[];
  /** Whole email domains granted read (a Drive "anyone in corp.com" share, a GitHub org domain) — serialized as `domain:<domain>`. */
  domains: string[];
  /** The source made this broadly readable ("anyone with the link", a public repo/channel) — serialized as the well-known `public:anyone` group. */
  publicAnyone: boolean;
  /** An OSHAL-native owner sub, when the ingesting connection is a personal (non-shared) connection. */
  ownerSub?: string | null;
}

/** The well-known group every authenticated caller carries, so `anyone`-shared source docs are readable by any signed-in user (and only signed-in users). */
export const PUBLIC_ANYONE_GROUP = 'public:anyone';

/** Prefix for the group token derived from a caller's email domain, matched against `domain:<domain>` shares. */
export const DOMAIN_GROUP_PREFIX = 'domain:';

/** Prefix for a named source group token (Google Group, GitHub team, Slack workspace). */
export const SOURCE_GROUP_PREFIX = 'group:';

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at > 0 ? email.slice(at + 1).trim().toLowerCase() : '';
}

function emptyAcl(): RagSourceAcl {
  return { users: [], groups: [], domains: [], publicAnyone: false, ownerSub: null };
}

/**
 * @description Serialize an engine-neutral source ACL into the flat `Record<string,string>` chunk
 * metadata the RAG permission filter reads (`owner_sub` / `allowed_users` / `allowed_groups`). Group
 * and domain tokens use the `group:` / `domain:` / `public:anyone` conventions the caller context is
 * built to match. De-duplicates and drops empties so a partially-resolved ACL never emits a blank
 * entry that could accidentally match a blank caller identity.
 * @param acl - The normalized source ACL.
 * @returns Chunk ACL metadata (only the fields that carry a value).
 */
export function serializeSourceAcl(acl: RagSourceAcl): Record<string, string> {
  const out: Record<string, string> = {};
  const owner = exactOwnerSub(acl.ownerSub);
  if (owner) out.owner_sub = owner;

  const users = dedupe(acl.users.map(clean).filter(Boolean));
  if (users.length) out.allowed_users = users.join(',');

  const groupTokens = [
    ...acl.groups.map(clean).filter(Boolean).map((g) => `${SOURCE_GROUP_PREFIX}${g}`),
    ...acl.domains.map((d) => clean(d).toLowerCase()).filter(Boolean).map((d) => `${DOMAIN_GROUP_PREFIX}${d}`),
    ...(acl.publicAnyone ? [PUBLIC_ANYONE_GROUP] : []),
  ];
  const groups = dedupe(groupTokens);
  if (groups.length) out.allowed_groups = groups.join(',');
  return out;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

// ── Provider-native mappers ────────────────────────────────────────────────────────────────────

/** A Google Drive permission entry (subset of the Drive v3 `permissions` resource). */
export interface DrivePermission {
  type?: 'user' | 'group' | 'domain' | 'anyone' | string;
  emailAddress?: string;
  domain?: string;
  role?: string;
}

/** The Drive file fields relevant to access: its share list and owners. */
export interface DriveFileAcl {
  permissions?: DrivePermission[];
  owners?: Array<{ emailAddress?: string }>;
}

/**
 * @description Map a Google Drive file's native `permissions[]` (+ owners) to a source ACL. User
 * shares grant by email; group shares become `group:<groupEmail>`; a domain share grants the whole
 * domain; an `anyone` permission marks the doc broadly readable. Owners are added as users so the
 * file owner can always retrieve it. Roles are not distinguished — any grant means "can read the
 * content", which is what a retrieval filter enforces.
 * @param file - The Drive file access fields.
 * @returns The normalized source ACL.
 */
export function driveFileToSourceAcl(file: DriveFileAcl): RagSourceAcl {
  const acl = emptyAcl();
  for (const owner of file.owners ?? []) {
    const email = clean(owner.emailAddress).toLowerCase();
    if (email) acl.users.push(email);
  }
  for (const perm of file.permissions ?? []) {
    if (perm.type === 'user' && clean(perm.emailAddress)) acl.users.push(clean(perm.emailAddress).toLowerCase());
    else if (perm.type === 'group' && clean(perm.emailAddress)) acl.groups.push(clean(perm.emailAddress).toLowerCase());
    else if (perm.type === 'domain' && clean(perm.domain)) acl.domains.push(clean(perm.domain));
    else if (perm.type === 'anyone') acl.publicAnyone = true;
  }
  return acl;
}

/** A Slack channel's access-relevant fields. */
export interface SlackChannelAcl {
  is_private?: boolean;
  team_id?: string;
  team_domain?: string;
  /** Member identities (email preferred; Slack user ids accepted but only match once directory-synced). */
  members?: string[];
}

/**
 * @description Map a Slack channel to a source ACL. A private channel grants only its members; a
 * public channel grants the workspace (a `group:slack-team:<id>` the caller carries once workspace
 * membership is known) and, if a workspace email domain is known, that domain. Member ids that are
 * not emails still serialize into `allowed_users` but only match after directory sync — fail-closed.
 * @param channel - The Slack channel access fields.
 * @returns The normalized source ACL.
 */
export function slackChannelToSourceAcl(channel: SlackChannelAcl): RagSourceAcl {
  const acl = emptyAcl();
  const team = clean(channel.team_id);
  if (channel.is_private) {
    for (const member of channel.members ?? []) {
      const id = clean(member).toLowerCase();
      if (id) acl.users.push(id);
    }
  } else {
    if (team) acl.groups.push(`slack-team:${team.toLowerCase()}`);
    const domain = clean(channel.team_domain).toLowerCase();
    if (domain.includes('.')) acl.domains.push(domain);
  }
  return acl;
}

/** A GitHub repository's access-relevant fields. */
export interface GithubRepoAcl {
  private?: boolean;
  owner?: { login?: string; type?: 'Organization' | 'User' | string };
  /** Collaborator identities (email preferred; login accepted but only matches once directory-synced). */
  collaborators?: Array<{ login?: string; email?: string }>;
}

/**
 * @description Map a GitHub repo to a source ACL. A public repo is broadly readable; a private repo
 * grants its collaborators (by email when available, else login) and, when owned by an org, the
 * `github-org:<login>` group. This is repo-granularity: every chunk from a repo inherits the repo's
 * visibility, which matches how GitHub gates file reads.
 * @param repo - The GitHub repo access fields.
 * @returns The normalized source ACL.
 */
export function githubRepoToSourceAcl(repo: GithubRepoAcl): RagSourceAcl {
  const acl = emptyAcl();
  if (!repo.private) {
    acl.publicAnyone = true;
    return acl;
  }
  if (repo.owner?.type === 'Organization' && clean(repo.owner.login)) {
    acl.groups.push(`github-org:${clean(repo.owner.login).toLowerCase()}`);
  }
  for (const collab of repo.collaborators ?? []) {
    const id = clean(collab.email).toLowerCase() || clean(collab.login).toLowerCase();
    if (id) acl.users.push(id);
  }
  return acl;
}

/** The provider ids the mapper understands; anything else falls through to the generic shape. */
export type SourceAclProvider = 'google-drive' | 'gmail' | 'slack' | 'github' | string;

/**
 * @description Dispatch a source document's native permissions to the right provider mapper and
 * return the chunk ACL metadata to stamp at ingest. `ownerSub` (the OSHAL sub of a personal
 * connection) is folded in so a personal-connection document is always readable by its owner even
 * when the native permissions resolve to nothing we can match yet. Unknown providers accept a
 * pre-normalized {@link RagSourceAcl}-shaped `native` object.
 * @param provider - The connector/source provider id.
 * @param native - The provider-native permission object (or a normalized RagSourceAcl for unknown providers).
 * @param ownerSub - Optional OSHAL owner sub from the ingesting connection.
 * @returns Chunk ACL metadata (`owner_sub` / `allowed_users` / `allowed_groups`).
 */
export function sourceAclToRagAcl(
  provider: SourceAclProvider,
  native: unknown,
  ownerSub?: string | null,
): Record<string, string> {
  let acl: RagSourceAcl;
  switch (provider) {
    case 'google-drive':
    case 'gmail':
      acl = driveFileToSourceAcl((native ?? {}) as DriveFileAcl);
      break;
    case 'slack':
      acl = slackChannelToSourceAcl((native ?? {}) as SlackChannelAcl);
      break;
    case 'github':
      acl = githubRepoToSourceAcl((native ?? {}) as GithubRepoAcl);
      break;
    default:
      acl = normalizeGenericAcl(native);
      break;
  }
  const exactOwner = exactOwnerSub(ownerSub);
  if (exactOwner) acl.ownerSub = exactOwner;
  return serializeSourceAcl(acl);
}

/** Return a present OSHAL subject byte-for-byte; source identities use separate cleanup rules. */
function exactOwnerSub(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (!value.trim()) throw new Error('RAG source owner subject must be nonblank');
  return value;
}

function normalizeGenericAcl(native: unknown): RagSourceAcl {
  const acl = emptyAcl();
  if (!native || typeof native !== 'object') return acl;
  const n = native as Partial<RagSourceAcl> & { public?: boolean };
  acl.users = Array.isArray(n.users) ? n.users.map(clean).filter(Boolean) : [];
  acl.groups = Array.isArray(n.groups) ? n.groups.map(clean).filter(Boolean) : [];
  acl.domains = Array.isArray(n.domains) ? n.domains.map(clean).filter(Boolean) : [];
  acl.publicAnyone = Boolean(n.publicAnyone ?? n.public);
  return acl;
}

/**
 * @description Build the group tokens a caller carries for source-ACL matching from their email:
 * the well-known {@link PUBLIC_ANYONE_GROUP} (any signed-in user) and their `domain:<domain>` group.
 * The route unions these with the caller's roles + tenant groups so `domain`- and `anyone`-shared
 * source docs resolve without a pre-sync step.
 * @param email - The caller's verified email (or null).
 * @returns The derived group tokens.
 */
export function sourceAclGroupsForCaller(email: string | null | undefined): string[] {
  const groups = [PUBLIC_ANYONE_GROUP];
  const domain = domainOf(clean(email));
  if (domain) groups.push(`${DOMAIN_GROUP_PREFIX}${domain}`);
  return groups;
}
