/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Tests for the source-ACL sync mapper: native Drive/Slack/GitHub permissions -> RAG ACL metadata, and the end-to-end grant/deny decision through the real permission filter (a Drive file shared to A is readable by A, denied to B). Pure — no live credentials.
 */

import { describe, expect, it } from 'vitest';
import {
  driveFileToSourceAcl,
  slackChannelToSourceAcl,
  githubRepoToSourceAcl,
  sourceAclToRagAcl,
  serializeSourceAcl,
  sourceAclGroupsForCaller,
} from '../../src/features/rag/services/source-acl-mapper';
import { permissionBasisForRagMetadata, type RagPermissionContext } from '../../src/features/rag/services/permission-filter';
import { ragAclFromConnection } from '../../src/app/routes/rag-routes';

/** Build a caller context the way the RAG route does, so end-to-end assertions mirror production. */
function caller(sub: string, email: string, extraGroups: string[] = []): RagPermissionContext {
  return {
    userSub: sub,
    emails: email ? [email] : [],
    groups: [...sourceAclGroupsForCaller(email), ...extraGroups],
    allowPublic: true,
  };
}

describe('driveFileToSourceAcl — native Drive permissions -> ACL', () => {
  it('maps user / group / domain / anyone shares and owners', () => {
    const md = sourceAclToRagAcl('google-drive', {
      owners: [{ emailAddress: 'Owner@Corp.com' }],
      permissions: [
        { type: 'user', emailAddress: 'Alice@Corp.com', role: 'reader' },
        { type: 'group', emailAddress: 'eng@corp.com', role: 'writer' },
        { type: 'domain', domain: 'Corp.com', role: 'reader' },
      ],
    });
    expect(md.allowed_users?.split(',').sort()).toEqual(['alice@corp.com', 'owner@corp.com']);
    expect(md.allowed_groups?.split(',').sort()).toEqual(['domain:corp.com', 'group:eng@corp.com']);
  });

  it('an "anyone" permission marks the doc public:anyone', () => {
    const acl = driveFileToSourceAcl({ permissions: [{ type: 'anyone', role: 'reader' }] });
    expect(acl.publicAnyone).toBe(true);
    expect(serializeSourceAcl(acl).allowed_groups).toBe('public:anyone');
  });

  it('a file with no permissions grants nothing (fail-closed)', () => {
    expect(sourceAclToRagAcl('google-drive', { permissions: [] })).toEqual({});
    expect(sourceAclToRagAcl('google-drive', {})).toEqual({});
  });
});

describe('Drive share -> retrieval decision (end-to-end through the real filter)', () => {
  it('a file shared to alice is readable by alice, denied to bob', () => {
    const chunkAcl = sourceAclToRagAcl('google-drive', {
      permissions: [{ type: 'user', emailAddress: 'alice@corp.com', role: 'reader' }],
    });
    expect(permissionBasisForRagMetadata(chunkAcl, caller('oidc|alice', 'alice@corp.com'))).toBe('explicit-user');
    expect(permissionBasisForRagMetadata(chunkAcl, caller('oidc|bob', 'bob@corp.com'))).toBeNull();
  });

  it('a domain-shared file is readable by anyone in the domain, denied outside it', () => {
    const chunkAcl = sourceAclToRagAcl('google-drive', { permissions: [{ type: 'domain', domain: 'corp.com' }] });
    expect(permissionBasisForRagMetadata(chunkAcl, caller('oidc|alice', 'alice@corp.com'))).toBe('group');
    expect(permissionBasisForRagMetadata(chunkAcl, caller('oidc|eve', 'eve@evil.com'))).toBeNull();
  });

  it('an anyone-shared file is readable by any signed-in caller', () => {
    const chunkAcl = sourceAclToRagAcl('google-drive', { permissions: [{ type: 'anyone' }] });
    expect(permissionBasisForRagMetadata(chunkAcl, caller('oidc|alice', 'alice@corp.com'))).toBe('group');
    expect(permissionBasisForRagMetadata(chunkAcl, caller('oidc|eve', 'eve@evil.com'))).toBe('group');
  });
});

describe('slackChannelToSourceAcl', () => {
  it('a private channel grants only its members', () => {
    const acl = slackChannelToSourceAcl({ is_private: true, members: ['alice@corp.com', 'bob@corp.com'] });
    expect(acl.users.sort()).toEqual(['alice@corp.com', 'bob@corp.com']);
    expect(acl.publicAnyone).toBe(false);
  });

  it('a public channel grants the workspace group and its domain', () => {
    const md = sourceAclToRagAcl('slack', { is_private: false, team_id: 'T123', team_domain: 'corp.com' });
    expect(md.allowed_groups?.split(',').sort()).toEqual(['domain:corp.com', 'group:slack-team:t123']);
  });
});

describe('githubRepoToSourceAcl', () => {
  it('a public repo is broadly readable', () => {
    expect(sourceAclToRagAcl('github', { private: false }).allowed_groups).toBe('public:anyone');
  });

  it('a private org repo grants the org group and collaborators (by email when present)', () => {
    const md = sourceAclToRagAcl('github', {
      private: true,
      owner: { login: 'AcmeCorp', type: 'Organization' },
      collaborators: [{ login: 'alice', email: 'alice@corp.com' }, { login: 'bob' }],
    });
    expect(md.allowed_users?.split(',').sort()).toEqual(['alice@corp.com', 'bob']);
    expect(md.allowed_groups).toBe('group:github-org:acmecorp');
  });
});

describe('sourceAclToRagAcl — owner folding + unknown provider', () => {
  it('folds the connection owner sub so a personal-connection doc is always owner-readable', () => {
    const md = sourceAclToRagAcl('google-drive', { permissions: [{ type: 'user', emailAddress: 'x@x.com' }] }, 'oidc|owner');
    expect(md.owner_sub).toBe('oidc|owner');
    expect(permissionBasisForRagMetadata(md, { userSub: 'oidc|owner' })).toBe('owner');
  });

  it('accepts a pre-normalized ACL for an unknown provider and stays fail-closed on garbage', () => {
    expect(sourceAclToRagAcl('notion', { users: ['u@u.com'], public: true }).allowed_users).toBe('u@u.com');
    expect(sourceAclToRagAcl('notion', 12345)).toEqual({});
    expect(sourceAclToRagAcl('notion', null)).toEqual({});
  });
});

describe('ragAclFromConnection — native source ACL layered over the connection baseline', () => {
  it('unions a personal connection owner with the file share list', () => {
    const md = ragAclFromConnection(
      { connected_by_sub: 'oidc|owner' },
      { provider: 'google-drive', nativePermissions: { permissions: [{ type: 'user', emailAddress: 'alice@corp.com' }] } },
    );
    expect(md.owner_sub).toBe('oidc|owner');
    expect(md.allowed_users).toBe('alice@corp.com');
    // owner reads via owner_sub, the shared user reads via email, an outsider is denied
    expect(permissionBasisForRagMetadata(md, { userSub: 'oidc|owner' })).toBe('owner');
    expect(permissionBasisForRagMetadata(md, caller('oidc|alice', 'alice@corp.com'))).toBe('explicit-user');
    expect(permissionBasisForRagMetadata(md, caller('oidc|eve', 'eve@evil.com'))).toBeNull();
  });

  it('keeps the tenant group for a tenant-shared connection and unions the source ACL', () => {
    const md = ragAclFromConnection(
      { tenant_id: 'acme' },
      { provider: 'google-drive', nativePermissions: { permissions: [{ type: 'anyone' }] } },
    );
    expect(md.allowed_groups?.split(',').sort()).toEqual(['public:anyone', 'tenant:acme']);
  });

  it('with no source arg, behaves exactly as before (owner-only / tenant-only)', () => {
    expect(ragAclFromConnection({ connected_by_sub: 'oidc|owner' })).toEqual({ owner_sub: 'oidc|owner' });
    expect(ragAclFromConnection({ tenant_id: 'acme' })).toEqual({ allowed_groups: 'tenant:acme' });
  });
});
