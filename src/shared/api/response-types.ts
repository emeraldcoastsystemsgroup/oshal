/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — standardized API response types
 */

/**
 * @description Standard success response envelope.
 * All successful API responses should use this format for consistency.
 */
export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data: T;
  meta?: {
    timestamp?: string;
    requestId?: string;
    [key: string]: unknown;
  };
}

/**
 * @description Standard error response envelope.
 * All error API responses should use this format for consistency.
 */
export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    stack?: string; // Only in development
  };
  meta?: {
    timestamp?: string;
    requestId?: string;
    [key: string]: unknown;
  };
}

/**
 * @description Union type for all API responses.
 */
export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse;

/**
 * @description Standard error codes for API responses.
 */
export enum ApiErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  BAD_REQUEST = 'BAD_REQUEST',
  CONFLICT = 'CONFLICT',
  TOO_MANY_REQUESTS = 'TOO_MANY_REQUESTS',
}

/**
 * @description Maps error codes to HTTP status codes.
 */
export const ErrorCodeToStatusMap: Record<ApiErrorCode, number> = {
  [ApiErrorCode.VALIDATION_ERROR]: 400,
  [ApiErrorCode.BAD_REQUEST]: 400,
  [ApiErrorCode.UNAUTHORIZED]: 401,
  [ApiErrorCode.FORBIDDEN]: 403,
  [ApiErrorCode.NOT_FOUND]: 404,
  [ApiErrorCode.CONFLICT]: 409,
  [ApiErrorCode.TOO_MANY_REQUESTS]: 429,
  [ApiErrorCode.INTERNAL_ERROR]: 500,
  [ApiErrorCode.SERVICE_UNAVAILABLE]: 503,
};