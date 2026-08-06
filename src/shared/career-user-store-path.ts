/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bridge kernel read/export surfaces to the installed Career package's side-effect-free, collision-resistant user-store mapper.
 *
 * @module shared/career-user-store-path
 */
import * as fs from 'fs';
import * as path from 'path';
import { requireExactUserSubject } from '@/shared/security/exact-user-subject';

/** Structural layout returned by the installed Career package. */
export interface CareerUserStoreLayout {
  tenantDir: string;
  userDir: string;
  userDb: string;
  userSegment: string;
}

interface CareerUserStoreMapper {
  findUserStoreLayout(
    storeRoot: string, tenant: string, userSub: string,
  ): CareerUserStoreLayout | null;
}

/** Return candidate mapper modules in explicit, installed, then developer-checkout order. */
function candidateMapperPaths(): string[] {
  const candidates: string[] = [];
  if (process.env.JOBHUNTER_USER_STORE_MODULE) {
    candidates.push(path.resolve(process.env.JOBHUNTER_USER_STORE_MODULE));
  }
  if (process.env.JOBHUNTER_APP_DIR) {
    candidates.push(path.resolve(process.env.JOBHUNTER_APP_DIR, 'lib', 'user-store-path.js'));
  }
  const workspace = process.env.CLINE_WORKSPACE_ROOT || '/app/workspace-shared';
  candidates.push(path.resolve(workspace, 'deployed-apps', 'career-hunter', 'lib', 'user-store-path.js'));
  if (process.env.OSHAL_STORE_DIR) {
    candidates.push(path.resolve(process.env.OSHAL_STORE_DIR, 'career-hunter', 'lib', 'user-store-path.js'));
  }
  return [...new Set(candidates)];
}

/** Load only the first existing mapper; a malformed installed package must not fall through. */
function resolveCareerUserStoreMapper(): CareerUserStoreMapper | null {
  const modulePath = candidateMapperPaths().find((candidate) => fs.existsSync(candidate));
  if (!modulePath) return null;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mapper = require(modulePath) as Partial<CareerUserStoreMapper>;
  if (typeof mapper.findUserStoreLayout !== 'function') {
    throw new Error('Installed Career user-store mapper lacks read-only layout discovery');
  }
  return mapper as CareerUserStoreMapper;
}

/**
 * @description Find the authenticated user's existing Career store without creating new state.
 * The app-owned mapper remains the sole authority for encoded/legacy path compatibility.
 * @param userSub - Exact authenticated OIDC subject.
 * @returns Existing contained layout, or null when the app/store is absent.
 */
export function findCareerUserStoreLayout(userSub: string): CareerUserStoreLayout | null {
  const exactSub = requireExactUserSubject(userSub);
  const mapper = resolveCareerUserStoreMapper();
  if (!mapper) return null;
  const storeRoot = process.env.JOBHUNTER_STORE_ROOT
    || path.resolve(process.cwd(), 'output', 'career-hunter-data');
  return mapper.findUserStoreLayout(storeRoot, 'default', exactSub);
}
