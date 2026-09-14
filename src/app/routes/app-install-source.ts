/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Share the installer's provenance check with both API install paths.
 */
export interface SourceReplacement {
  name: string;
  from: { repo: string | null; registry: string | null; ref: string | null; sha: string | null };
  to: { repo: string | null; registry: string | null };
  token: string;
}

const guard = require('../../../scripts/oshal-install-source.js') as {
  SOURCE_CONFLICT_EXIT: number;
  replacementFor: (dest: string, name: string, source: { repo: string; registry?: string }) => SourceReplacement | null;
};
export const { SOURCE_CONFLICT_EXIT, replacementFor } = guard;
