/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Preserve verified directory evidence separately from a canonical local identity projection.
 */
import type { Request } from 'express';

const claimsByRequest = new WeakMap<Request, Readonly<Record<string, unknown>>>();

/** Preserve only already verified protocol evidence before a trusted identity bridge rewrites it. */
export function preserveVerifiedDirectoryClaims(req: Request, claims: Record<string, unknown>): void {
  const copy: Record<string, unknown> = {};
  for (const key of ['iss', 'sub', 'tid', 'oid', 'aud', 'iat', 'exp', 'groups', 'roles', 'hasgroups']) {
    const value = claims[key];
    copy[key] = Array.isArray(value) ? Object.freeze([...value]) : value;
  }
  copy.groupOverage = Boolean(claims.hasgroups || (claims._claim_names as Record<string, unknown> | undefined)?.groups);
  claimsByRequest.set(req, Object.freeze(copy));
}

/** Return request-bound directory evidence; no header, body or query value can populate this store. */
export function getPreservedDirectoryClaims(req: Request): Readonly<Record<string, unknown>> | undefined {
  return claimsByRequest.get(req);
}
