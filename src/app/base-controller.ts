/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of BaseController for standardized API response and error handling
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * @description BaseController provides standardized API response helpers and async error handling for Express controllers.
 * All controllers should extend this class to ensure consistent response formatting and error propagation.
 */
export class BaseController {
  protected logger: any;

  constructor(logger: any) {
    this.logger = logger;
  }

  /**
   * @description Wraps an async route handler to catch errors and pass them to Express error middleware.
   * @param fn - The async route handler
   * @returns Wrapped handler with error forwarding
   */
  protected asyncHandler<T extends RequestHandler>(fn: T): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  }

  /**
   * @description Sends a 200 OK response with the given payload.
   * @param res - Express response object
   * @param data - Response payload
   */
  protected success(res: Response, data: any) {
    return res.status(200).json(data);
  }

  /**
   * @description Sends a 201 Created response with the given payload.
   * @param res - Express response object
   * @param data - Response payload
   */
  protected created(res: Response, data: any) {
    return res.status(201).json(data);
  }

  /**
   * @description Sends a 404 Not Found response with an optional message.
   * @param res - Express response object
   * @param message - Optional error message
   */
  protected notFound(res: Response, message?: string) {
    return res.status(404).json({ error: message || 'Not found' });
  }

  /**
   * @description Sends a 400 Bad Request response with an optional message.
   * @param res - Express response object
   * @param message - Optional error message
   */
  protected badRequest(res: Response, message?: string) {
    return res.status(400).json({ error: message || 'Bad request' });
  }

  /**
   * @description Sends a 503 Service Unavailable response with an optional message and details.
   * @param res - Express response object
   * @param message - Optional error message
   * @param details - Optional structured details for the unavailable dependency
   */
  protected serviceUnavailable(res: Response, message?: string, details?: Record<string, unknown>) {
    return res.status(503).json({
      error: message || 'Service unavailable',
      ...(details ? { details } : {}),
    });
  }
}
