/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — custom API error classes
 */

import { ApiErrorCode } from './response-types';

/**
 * @description Base class for all API errors.
 * Extends Error and includes error code and details for structured responses.
 */
export class ApiError extends Error {
  constructor(
    public code: ApiErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * @description Thrown when request validation fails (400).
 */
export class ValidationError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(ApiErrorCode.VALIDATION_ERROR, message, details);
  }
}

/**
 * @description Thrown when a requested resource is not found (404).
 */
export class NotFoundError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(ApiErrorCode.NOT_FOUND, message, details);
  }
}

/**
 * @description Thrown when authentication is required but not provided (401).
 */
export class UnauthorizedError extends ApiError {
  constructor(message: string = 'Authentication required', details?: unknown) {
    super(ApiErrorCode.UNAUTHORIZED, message, details);
  }
}

/**
 * @description Thrown when user lacks permission for the requested resource (403).
 */
export class ForbiddenError extends ApiError {
  constructor(message: string = 'Access forbidden', details?: unknown) {
    super(ApiErrorCode.FORBIDDEN, message, details);
  }
}

/**
 * @description Thrown when request is malformed or invalid (400).
 */
export class BadRequestError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(ApiErrorCode.BAD_REQUEST, message, details);
  }
}

/**
 * @description Thrown when a resource conflict occurs (409).
 */
export class ConflictError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(ApiErrorCode.CONFLICT, message, details);
  }
}

/**
 * @description Thrown when rate limit is exceeded (429).
 */
export class TooManyRequestsError extends ApiError {
  constructor(message: string = 'Too many requests', details?: unknown) {
    super(ApiErrorCode.TOO_MANY_REQUESTS, message, details);
  }
}

/**
 * @description Thrown when an internal server error occurs (500).
 */
export class InternalError extends ApiError {
  constructor(message: string = 'Internal server error', details?: unknown) {
    super(ApiErrorCode.INTERNAL_ERROR, message, details);
  }
}

/**
 * @description Thrown when a service is temporarily unavailable (503).
 */
export class ServiceUnavailableError extends ApiError {
  constructor(message: string = 'Service temporarily unavailable', details?: unknown) {
    super(ApiErrorCode.SERVICE_UNAVAILABLE, message, details);
  }
}