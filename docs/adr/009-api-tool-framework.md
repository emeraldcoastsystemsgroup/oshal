# ADR 009: API Tool Framework

## Status
Accepted

## Context

The OSHAL project has multiple API endpoints implemented with inconsistent patterns:

**Problems identified:**
1. **Inconsistent dependency injection** - Voice routes didn't use AppContext pattern used by other routes
2. **Business logic leakage** - Logic scattered between route handlers and service layers
3. **No validation framework** - Manual validation repeated in each handler
4. **Inconsistent error handling** - Different error response formats across endpoints
5. **Missing type safety** - No request/response validation at compile time
6. **Repetitive boilerplate** - Logging, timing, error handling duplicated everywhere

**Example of old pattern:**
```typescript
function handleTranscribe() {
  return async (req: Request, res: Response): Promise<void> => {
    const startTime = Date.now();
    logger.info(...);
    try {
      if (!req.file) {
        res.status(400).json({ success: false, error: '...' });
        return;
      }
      // validation + logging + business logic + error handling all mixed
    } catch (error) {
      logger.error(...);
      res.status(500).json({ success: false, error: '...' });
    }
  };
}
```

## Decision

Implement a comprehensive API tool framework with the following components:

### 1. **BaseController** (`src/shared/api/base-controller.ts`)
- Abstract base class for all controllers
- Provides `handle()` wrapper for automatic error handling, logging, and timing
- Provides `success()` and `error()` helpers for standardized responses
- Provides `measure()` helper for performance tracking

### 2. **Standardized Response Types** (`src/shared/api/response-types.ts`)
- `ApiSuccessResponse<T>` - Wraps all success responses with `data` and `meta` fields
- `ApiErrorResponse` - Standardized error format with `code`, `message`, `details`
- `ApiErrorCode` enum - Predefined error codes mapped to HTTP status codes

### 3. **Custom Error Classes** (`src/shared/api/errors.ts`)
- `ApiError` - Base error class
- Specific errors: `ValidationError`, `NotFoundError`, `UnauthorizedError`, etc.
- Automatic mapping to HTTP status codes

### 4. **Validation Utilities** (`src/shared/api/validation.ts`)
- Zod-based request validation
- `validateBody()`, `validateQuery()`, `validateParams()` - Schema validation helpers
- `validateFile()` - File upload validation with size/type constraints

### 5. **Service Layer Pattern**
- Business logic in dedicated service classes (e.g., `VoiceService`)
- Services are pure business logic with no HTTP concerns
- Services injected into controllers via constructor

### 6. **Feature-Sliced Design Structure**
```
src/features/voice/
├── services/voice-service.ts      # Business logic
├── controllers/voice-controller.ts # HTTP layer
├── schemas/voice-schemas.ts       # Zod validation schemas
└── index.ts                       # Barrel export
```

**Example of new pattern:**
```typescript
// Controller (HTTP layer)
export class VoiceController extends BaseController {
  constructor(private service: VoiceService) {
    super({ module: 'voice-controller' });
  }

  transcribe = this.handle(async (req, res, next) => {
    const file = validateFile(req.file, { /* options */ });
    const result = await this.service.transcribeAudio(file.buffer, file.mimetype);
    return this.success(result);
  });
}

// Service (business logic)
export class VoiceService {
  async transcribeAudio(audio: Buffer, mimeType: string): Promise<TranscribeResponse> {
    // Pure business logic, no HTTP concerns
  }
}

// Route registration
export function createVoiceRoutes(): Router {
  const router = Router();
  const service = new VoiceService();
  const controller = new VoiceController(service);
  
  router.post('/transcribe', upload.single('audio'), controller.transcribe);
  return router;
}
```

## Consequences

### Positive
1. **Consistency** - All API endpoints follow the same pattern
2. **Type Safety** - Request/response validation at runtime and compile time
3. **Testability** - Services can be unit tested independently of HTTP layer
4. **Maintainability** - Clear separation of concerns (HTTP → Controller → Service)
5. **FSD Compliance** - Proper layer separation (features → shared)
6. **Error Handling** - Standardized, predictable error responses with proper status codes
7. **Developer Experience** - Less boilerplate, clearer contracts, auto-generated request IDs and timing

### Negative
1. **Learning Curve** - Developers must understand the framework patterns
2. **Migration Effort** - Existing routes need refactoring to fit the pattern
3. **Abstraction Overhead** - Additional layers may seem complex for simple endpoints

### Neutral
1. **Breaking Change** - Response format changed from flat objects to wrapped `{ success, data, meta }` format
2. **Testing Updates** - All tests must be updated to expect new response format

## Implementation

The framework was initially implemented for the voice feature as a pilot:
- `src/shared/api/` - Framework foundation (BaseController, response types, errors, validation)
- `src/features/voice/` - Voice feature refactored to use framework (services, controllers, schemas)
- `tests/voice-integration.spec.ts` - Updated tests validating new response format

**Test Results:** 12/12 tests passing, confirming framework works correctly.

## Future Work

1. Migrate remaining routes (task-routes, message-routes, config-routes) to framework pattern
2. Consider adding request/response interceptors for cross-cutting concerns
3. Add OpenAPI schema generation from Zod schemas
4. Add rate limiting and caching decorators for controllers

## References
- Voice feature implementation: `src/features/voice/`
- Framework foundation: `src/shared/api/`
- Test suite: `tests/voice-integration.spec.ts`
- Related ADRs: ADR-001 (FSD Migration)