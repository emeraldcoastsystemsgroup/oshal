import type { Request } from 'express';

type RateLimitRequest = Pick<Request, 'headers' | 'method' | 'originalUrl' | 'path' | 'url'>;

const STATIC_UI_PREFIXES = [
  '/cockpit/',
  '/fonts/',
  '/shared/',
];

const STATIC_UI_EXACT = new Set([
  '/cockpit',
  '/favicon.ico',
]);

const API_SHELL_EXACT = new Set([
  '/api/jarvis',
  '/api/jarvis/',
  '/api/jarvis/ui',
  '/api/jarvis/ui/',
]);

function requestPath(req: RateLimitRequest): string {
  const raw = req.originalUrl || req.url || req.path || '/';
  try {
    return new URL(raw, 'http://oshal.local').pathname;
  } catch {
    return String(raw).split('?')[0] || '/';
  }
}

function isReadOnly(req: RateLimitRequest): boolean {
  return req.method === 'GET' || req.method === 'HEAD';
}

function isUiShellOrStatic(req: RateLimitRequest): boolean {
  if (!isReadOnly(req)) return false;
  const pathname = requestPath(req);
  if (STATIC_UI_EXACT.has(pathname) || API_SHELL_EXACT.has(pathname)) return true;
  return STATIC_UI_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function shouldSkipGlobalRateLimit(req: RateLimitRequest): boolean {
  if (!req.headers['x-forwarded-for']) return true;
  return isUiShellOrStatic(req);
}

