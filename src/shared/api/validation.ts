/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — request validation utilities with Zod
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Fixed Change Log author and timestamp to comply with .clinerules/attribution.md
 */

import { z, ZodSchema } from 'zod';
import type { Request } from 'express';
import { ValidationError } from './errors';

/**
 * @description Validates request body against a Zod schema.
 * 
 * @param req - Express request object
 * @param schema - Zod schema to validate against
 * @returns Validated and typed data
 * @throws ValidationError if validation fails
 */
export function validateBody<T extends ZodSchema>(
  req: Request,
  schema: T,
): z.infer<T> {
  const result = schema.safeParse(req.body);
  
  if (!result.success) {
    throw new ValidationError('Request body validation failed', {
      issues: result.error.issues,
    });
  }
  
  return result.data;
}

/**
 * @description Validates request query parameters against a Zod schema.
 * 
 * @param req - Express request object
 * @param schema - Zod schema to validate against
 * @returns Validated and typed data
 * @throws ValidationError if validation fails
 */
export function validateQuery<T extends ZodSchema>(
  req: Request,
  schema: T,
): z.infer<T> {
  const result = schema.safeParse(req.query);
  
  if (!result.success) {
    throw new ValidationError('Request query validation failed', {
      issues: result.error.issues,
    });
  }
  
  return result.data;
}

/**
 * @description Validates request path parameters against a Zod schema.
 * 
 * @param req - Express request object
 * @param schema - Zod schema to validate against
 * @returns Validated and typed data
 * @throws ValidationError if validation fails
 */
export function validateParams<T extends ZodSchema>(
  req: Request,
  schema: T,
): z.infer<T> {
  const result = schema.safeParse(req.params);
  
  if (!result.success) {
    throw new ValidationError('Request params validation failed', {
      issues: result.error.issues,
    });
  }
  
  return result.data;
}

/**
 * @description Validates uploaded file against constraints.
 * 
 * @param file - Uploaded file from multer
 * @param options - Validation options
 * @returns The validated file
 * @throws ValidationError if validation fails
 */
export function validateFile(
  file: Express.Multer.File | undefined,
  options: {
    required?: boolean;
    maxSize?: number;
    allowedMimeTypes?: string[];
  } = {},
): Express.Multer.File {
  const { required = true, maxSize, allowedMimeTypes } = options;
  
  if (!file) {
    if (required) {
      throw new ValidationError('File is required');
    }
    // TypeScript doesn't know that ValidationError always throws, so this is unreachable
    throw new ValidationError('File is required');
  }
  
  if (maxSize && file.size > maxSize) {
    throw new ValidationError(`File size exceeds maximum of ${maxSize} bytes`, {
      actualSize: file.size,
      maxSize,
    });
  }
  
  if (allowedMimeTypes && !allowedMimeTypes.includes(file.mimetype)) {
    throw new ValidationError('File type not allowed', {
      actualType: file.mimetype,
      allowedTypes: allowedMimeTypes,
    });
  }
  
  return file;
}