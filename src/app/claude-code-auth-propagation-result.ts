/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | Added the shared explicit-import acknowledgement policy for every Claude credential propagation path
 */

/**
 * @description Accepts a target acknowledgement only when the target confirms that credential
 * state actually changed. A read-only/no-op bot returns success:true, imported:false; treating that
 * response as propagated would create false operational evidence.
 * @param responseOk - Whether the target returned a successful HTTP status.
 * @param payload - Parsed target response body.
 * @returns True only for an explicit successful import acknowledgement.
 */
export function isConfirmedClaudeCredentialImport(
  responseOk: boolean,
  payload: Record<string, unknown>,
): boolean {
  return responseOk && payload.success === true && payload.imported === true;
}
