/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — base controller with standardized response handling
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { Logger } from 'pino';
import {
  type ApiSuccessResponse,
  type ApiErrorResponse,
  ApiErrorCode,
  ErrorCodeToStatusMap,
} from './response-types';
import { ApiError } from './errors';

/**
 * @description Configuration for BaseController initialization.
 */
export interface BaseControllerConfig {
  module: string;
}

/**
 * @description Base controller class providing standardized response handling,
 * error handling, logging, and request timing for all API controllers.
 * 
 * All controllers should extend this class to ensure consistent behavior
 * across all API endpoints.
 */
export abstract class BaseController {
  protected logger: Logger;

  constructor(config: BaseControllerConfig) {
    this.logger = createChildLogger({ module: config.module });
  }

  /**
   * @description Creates a standardized success response.
   * 
   * @param data - Response data payload
   * @param meta - Optional metadata (timestamp, requestId, etc.)
   * @returns Formatted success response
   */
  protected success<T>(
    data: T,
    meta?: Record<string, unknown>,
  ): ApiSuccessResponse<T> {
    return {
      success: true,
      data,
      meta: {
        timestamp: new Date().toISOString(),
        ...meta,
      },
    };
  }

  /**
   * @description Creates a standardized error response.
   * 
   * @param code - Error code from ApiErrorCode enum
   * @param message - Human-readable error message
   * @param details - Optional error details
   * @returns Formatted error response
   */
  protected error(
    code: ApiErrorCode,
    message: string,
    details?: unknown,
  ): ApiErrorResponse {
    return {
      success: false,
      error: {
        code,
        message,
        details,
      },
      meta: {
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * @description Wraps a request handler with automatic error handling,
   * logging, and timing. Catches any thrown errors and converts them
   * to standardized error responses.
   * 
   * @param handler - Async request handler function
   * @returns Express request handler with error handling
   */
  protected handle(
    handler: (req: Request, res: Response, next: NextFunction) => Promise<void | ApiSuccessResponse<unknown>>,
  ): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const startTime = Date.now();
      const requestId = this.generateRequestId();

      this.logger.info({
        requestId,
        method: req.method,
        path: req.path,
        query: req.query,
      }, 'Request started');

      try {
        const result = await handler(req, res, next);

        // If handler returns a response object, send it
        if (result && typeof result === 'object' && 'success' in result) {
          const durationMs = Date.now() - startTime;
          this.logger.info({
            requestId,
            durationMs,
            statusCode: 200,
          }, 'Request completed successfully');

          res.status(200).json({
            ...result,
            meta: {
              ...result.meta,
              requestId,
              durationMs,
            },
          });
        }
        // Otherwise, assume handler already sent response
      } catch (error) {
        const durationMs = Date.now() - startTime;
        this.handleError(error, req, res, requestId, durationMs);
      }
    };
  }

  /**
   * @description Handles errors thrown by request handlers.
   * Converts ApiError instances to proper HTTP responses with correct status codes.
   * Logs all errors with context.
   * 
   * @param error - The error that was thrown
   * @param req - Express request object
   * @param res - Express response object
   * @param requestId - Unique request identifier
   * @param durationMs - Request duration in milliseconds
   */
  private handleError(
    error: unknown,
    req: Request,
    res: Response,
    requestId: string,
    durationMs: number,
  ): void {
    // Handle ApiError instances with proper status codes
    if (error instanceof ApiError) {
      const statusCode = ErrorCodeToStatusMap[error.code] || 500;

      this.logger.error({
        err: error,
        requestId,
        durationMs,
        statusCode,
        errorCode: error.code,
      }, 'Request failed with API error');

      const errorResponse: ApiErrorResponse = {
        success: false,
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          ...(process.env.NODE_ENV === 'development' && { stack: error.stack }),
        },
        meta: {
          timestamp: new Date().toISOString(),
          requestId,
          durationMs,
        },
      };

      res.status(statusCode).json(errorResponse);
      return;
    }

    // Handle unknown errors as internal server errors
    const statusCode = 500;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    this.logger.error({
      err: error,
      requestId,
      durationMs,
      statusCode,
    }, 'Request failed with unexpected error');

    const errorResponse: ApiErrorResponse = {
      success: false,
      error: {
        code: ApiErrorCode.INTERNAL_ERROR,
        message: errorMessage,
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && { stack: error.stack }),
      },
      meta: {
        timestamp: new Date().toISOString(),
        requestId,
        durationMs,
      },
    };

    res.status(statusCode).json(errorResponse);
  }

  /**
   * @description Generates a unique request ID for tracing.
   * 
   * @returns Random hex string for request identification
   */
  private generateRequestId(): string {
    return Math.random().toString(36).substring(2, 15);
  }

  /**
   * @description Measures execution time of an async operation.
   * Useful for logging performance metrics.
   * 
   * @param name - Name of the operation being measured
   * @param fn - Async function to measure
   * @returns Result of the async function
   */
  protected async measure<T>(
    name: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const startTime = Date.now();
    
    try {
      const result = await fn();
      const durationMs = Date.now() - startTime;
      
      this.logger.debug({ name, durationMs }, 'Operation completed');
      
      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      this.logger.error({ err: error, name, durationMs }, 'Operation failed');
      throw error;
    }
  }
}