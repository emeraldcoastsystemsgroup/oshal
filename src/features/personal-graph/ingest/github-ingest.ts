/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | GitHub repo -> graph fragment mapper (ADR-066)
 */

/**
 * @module features/personal-graph/ingest/github-ingest
 * @description Pure mapper: one GitHub repository (the raw item from the ADR-065
 * `github-list-repos` resource) -> graph nodes + edges.
 *
 * Projection:
 *  - the repo -> a Repo node (repo:github:<owner>/<name>)
 *  - the owner -> a Person node, keyed by the owner's email when known, else github:login
 *  - owner -> Repo : `owns` edge; owner -> Repo : `authored` edge (created/maintains)
 *
 * Note on dedup: GitHub's repo payload usually has no owner email, so the owner resolves to
 * `person:github:<login>`. The reverberation pass can later merge that with an email-keyed person
 * once another source supplies the email (see reverberate.ts).
 */

import { edgeId } from '../graph-types';
import type { GraphFragment, GraphNode, GraphEdge, SourceRef } from '../graph-types';
import { buildPerson } from './ingest-helpers';

/** Minimal shape of a GitHub repo (subset we use). */
export interface GitHubRepoOwner {
  login: string;
  email?: string;
  name?: string;
}
export interface GitHubRepo {
  id: number;
  name: string;
  full_name?: string;
  private?: boolean;
  html_url?: string;
  language?: string | null;
  owner: GitHubRepoOwner;
}

const PROVIDER = 'github';

export function ingestGitHubRepo(repo: GitHubRepo, observedAt?: string): GraphFragment {
  const externalId = repo.full_name ?? `${repo.owner.login}/${repo.name}`;
  const source: SourceRef = { provider: PROVIDER, externalId, observedAt };
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const repoNodeId = `repo:${PROVIDER}:${externalId.toLowerCase()}`;
  nodes.push({
    id: repoNodeId,
    type: 'Repo',
    label: repo.full_name ?? repo.name,
    sources: [source],
    props: {
      fullName: repo.full_name ?? externalId,
      private: repo.private,
      url: repo.html_url,
      language: repo.language ?? undefined,
    },
  });

  const owner = buildPerson({
    email: repo.owner.email,
    name: repo.owner.name,
    handle: repo.owner.login,
    source,
  });
  nodes.push(owner);
  edges.push({
    id: edgeId('owns', owner.id, repoNodeId),
    type: 'owns',
    from: owner.id,
    to: repoNodeId,
    sources: [source],
  });
  edges.push({
    id: edgeId('authored', owner.id, repoNodeId),
    type: 'authored',
    from: owner.id,
    to: repoNodeId,
    sources: [source],
  });

  return { nodes, edges };
}
