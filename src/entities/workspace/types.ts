/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

import { z } from 'zod';

/**
 * @description Canonical, fully-resolved representation of a workspace as stored
 * and used internally by the harness. Carries the system-assigned identity and
 * creation timestamp alongside user-supplied details so consumers can rely on
 * every field being present (using null, not absence, for the optional project).
 */
export interface InternalWorkspace {
  workspaceId: string;
  name: string;
  path: string;
  projectName: string | null;
  /** OIDC sub of the creating user, for per-user isolation. Null for legacy/system rows. */
  ownerSub: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/**
 * @description Shape of the caller-provided data needed to create a new
 * workspace. Mirrors InternalWorkspace but omits system-owned fields
 * (workspaceId, createdAt) and relaxes the rest to optional, expressing the
 * minimum a caller must supply versus what the system fills in.
 */
export interface CreateInternalWorkspaceInput {
  name: string;
  path?: string;
  projectName?: string | null;
  /** OIDC sub of the creating user. Stamped by the route from the session; not client-trusted. */
  ownerSub?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * @description Runtime Zod schema enforcing the CreateInternalWorkspaceInput
 * contract at trust boundaries (e.g. API/IPC input), so untyped external data is
 * validated before it is treated as a workspace creation request. The non-empty
 * name constraint guards against blank workspaces.
 */
export const CreateInternalWorkspaceSchema = z.object({
  name: z.string().min(1),
  path: z.string().optional(),
  projectName: z.string().optional(),
  ownerSub: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
