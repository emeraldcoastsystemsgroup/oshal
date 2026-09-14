/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from server.ts (1000-line cap decomposition): the OpenAPI spec definition, the swagger-jsdoc scan globs and the /openapi.json + /api-docs + /docs mount. Verbatim move — the spec object, the glob list and the route registration order are unchanged, and this module MUST stay flat in src/app/ so the __dirname-relative scan globs keep resolving to the same routes directory as before.
 */

import type express from 'express';
import path from 'path';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'server-openapi' });

// OpenAPI/Swagger configuration
const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'OSHAL Control Plane API',
    version: '1.0.0',
    description: 'OpenAPI documentation for the OSHAL control plane API.',
  },
  servers: [
    {
      url: 'http://localhost:3456',
      description: 'Local development server',
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
  },
  security: [{ bearerAuth: [] }],
};

const swaggerOptions = {
  swaggerDefinition,
  apis: [
    path.resolve(process.cwd(), 'src/app/routes/*.ts'),
    path.resolve(process.cwd(), 'src/app/routes/**/*.ts'),
    path.resolve(process.cwd(), 'dist/app/routes/*.js'),
    path.resolve(process.cwd(), 'dist/app/routes/**/*.js'),
    path.resolve(__dirname, './routes/*.ts'),
    path.resolve(__dirname, './routes/**/*.ts'),
    path.resolve(__dirname, './routes/*.js'),
    path.resolve(__dirname, './routes/**/*.js'),
  ],
};

/**
 * @description The generated OpenAPI document for the control-plane API. Built once at module
 * load (as it was at server module load before the extraction) because swagger-jsdoc re-parses
 * every route file on each call, which is far too expensive to do per request.
 */
export const swaggerSpec = swaggerJsdoc(swaggerOptions);

/**
 * @description Mounts the API documentation surface: the raw OpenAPI document, the legacy
 * /api-docs redirect kept so old bookmarks and links do not 404, and the Swagger UI itself.
 * Deliberately public and registered before the OIDC middleware, exactly as it was inline in
 * createApp — the spec describes the routes, it does not expose their data.
 *
 * @param app - The Express application to register the documentation routes on.
 * @returns Nothing; the routes are registered as a side effect on the supplied app.
 */
export function registerOpenApiDocsRoutes(app: express.Application): void {
  app.use('/openapi.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });
  app.get(['/api-docs', '/api-docs/'], (_req, res) => {
    logger.info('GET /api-docs - redirecting to /docs');
    res.redirect(302, '/docs');
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
}
