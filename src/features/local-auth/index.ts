/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel for the local-auth feature (ADR-117): the invited-user store behind LOCAL_AUTH mode.
 */

export {
  INVITE_TOKEN_PREFIX,
  PASSWORD_MIN_LENGTH,
  localSubForEmail,
  normalizeEmail,
  looksLikeEmail,
  hashPassword,
  verifyPassword,
  generateInviteToken,
  hashInviteToken,
  ensureLocalUserSchema,
  upsertInvite,
  findByInviteToken,
  acceptInvite,
  verifyLogin,
  getSessionSnapshot,
  isStoreEmpty,
  bootstrapFirstAdmin,
  listUsers,
  setUserStatus,
  getUserById,
} from './services/local-user-store';
export type { LocalUser, InviteResult } from './services/local-user-store';
export {
  LOCAL_SESSION_COOKIE,
  LOCAL_SESSION_ROLLING_MS,
  LOCAL_SESSION_ABSOLUTE_MS,
  isLocalAuthEnabled,
  localAuthSigningSecret,
  mintLocalSession,
  verifyLocalSession,
  shouldReissueLocalSession,
} from './services/local-auth-session';
export type { LocalSessionClaims, LocalSessionIdentity } from './services/local-auth-session';
