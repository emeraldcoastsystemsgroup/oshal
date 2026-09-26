/** Signed machine callbacks return only a durable owner identity; core refreshes its authority. */
import type { Request } from 'express';
export interface CallbackPrincipal { sub: string; issuer: string }
export type PackageCallbackVerifier = (request: Request) => Promise<CallbackPrincipal | null>;
export function validCallbackPrincipal(value: unknown): value is CallbackPrincipal {
  if (!value || typeof value !== 'object') return false;
  const item = value as CallbackPrincipal;
  return typeof item.sub === 'string' && item.sub.length > 0 && item.sub.length <= 512
    && typeof item.issuer === 'string' && item.issuer.length > 0 && item.issuer.length <= 2048;
}
