/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel for the local-auth feature (ADR-117): the invited-user store behind LOCAL_AUTH mode.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export createPasswordReset (self-service reset, ADR-117 deferred item).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Export createSwarmAdmin, SWARM_ADMIN_LOGIN and LocalAccountKind (ADR-174 slice 2a).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Stop exporting createSwarmAdmin, SWARM_ADMIN_LOGIN and LocalAccountKind: the store no longer has them. Roger's admin-role decision (2026-10-06) replaces ADR-174's separate configuration-only admin account with the existing operator role on a person's own account, so the account kind and the reserved 'admin' login are gone.
 */

export {
  TOTP_DIGITS,
  TOTP_STEP_SECONDS,
  RECOVERY_CODE_COUNT,
  base32Encode,
  base32Decode,
  totpCodeForStep,
  currentStep,
  verifyTotpCode,
  otpauthUri,
  formatSecretForDisplay,
  encryptSecret,
  decryptSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  ensureTotpSchema,
  getTotpState,
  beginTotpEnrolment,
  confirmTotpEnrolment,
  verifySecondFactor,
  disableTotp,
  setTotpRequired,
} from './services/local-totp';
export type { TotpState, TotpEnrolment, SecondFactorResult } from './services/local-totp';

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
  createPasswordReset,
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
