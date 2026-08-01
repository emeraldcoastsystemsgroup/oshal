/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of ToolController for Layer 1 Tools Framework
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fixed logger import path to shared/logger; updated Change Log author/timestamp
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Routed ToolRegistryService dependency through services barrel export
 * 4 | maintainer@emeraldcoastsystemsgroup.com | 2026-07-30 23:10:00 | Added
 *   explicit Express RequestHandler annotations to exported controller handlers so committed-HEAD
 *   declaration typechecking stays portable and does not infer transitive @types/qs paths.
 */

import { Request, Response, type RequestHandler } from 'express';
import { logger } from '@/shared/logger';
import { BaseController } from '@/app/base-controller';
import { ToolRegistryService } from '../services';
import {
  CreateToolSchema,
  UpdateToolSchema,
  ToolFiltersSchema,
} from '@/entities/tool';

/**
 * @description Controller for tool registry HTTP endpoints.
 * Provides RESTful API for tool CRUD operations, categories, and auth groups.
 * Extends BaseController for standardized error handling and response formatting.
 */
export class ToolController extends BaseController {
  constructor(
    private readonly service: ToolRegistryService,
    logger: any
  ) {
    super(logger);
  }

  /**
   * @description GET /api/tools - Retrieve all tools with optional filtering
   * Query params: name, type, category, authGroup, search, limit, offset
   */
  getAllTools: RequestHandler = this.asyncHandler(async (req: Request, res: Response) => {
    const filters = ToolFiltersSchema.parse(req.query);
    const tools = await this.service.getAllTools(filters);
    
    return this.success(res, {
      tools,
      count: tools.length,
      filters,
    });
  });

  /**
   * @description GET /api/tools/:id - Retrieve a single tool by ID
   */
  getToolById: RequestHandler = this.asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const toolId = Array.isArray(id) ? id[0] : id;
    const tool = await this.service.getToolById(toolId);
    
    if (!tool) {
      return this.notFound(res, `Tool with ID ${toolId} not found`);
    }
    
    return this.success(res, { tool });
  });

  /**
   * @description POST /api/tools - Register a new tool
   */
  createTool: RequestHandler = this.asyncHandler(async (req: Request, res: Response) => {
    const input = CreateToolSchema.parse(req.body);
    const tool = await this.service.registerTool(input);
    
    return this.created(res, { tool });
  });

  /**
   * @description PUT /api/tools/:id - Update an existing tool
   */
  updateTool: RequestHandler = this.asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const toolId = Array.isArray(id) ? id[0] : id;
    const updates = UpdateToolSchema.parse(req.body);
    const tool = await this.service.updateTool(toolId, updates);
    
    if (!tool) {
      return this.notFound(res, `Tool with ID ${toolId} not found`);
    }
    
    return this.success(res, { tool });
  });

  /**
   * @description DELETE /api/tools/:id - Delete a tool
   */
  deleteTool: RequestHandler = this.asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const toolId = Array.isArray(id) ? id[0] : id;
    const deleted = await this.service.deleteTool(toolId);
    
    if (!deleted) {
      return this.notFound(res, `Tool with ID ${toolId} not found`);
    }
    
    return this.success(res, { message: 'Tool deleted successfully' });
  });

  /**
   * @description GET /api/tools/metadata/categories - Get all unique categories
   */
  getCategories: RequestHandler = this.asyncHandler(async (req: Request, res: Response) => {
    const categories = await this.service.getCategories();
    
    return this.success(res, { categories, count: categories.length });
  });

  /**
   * @description GET /api/tools/metadata/auth-groups - Get all unique auth groups
   */
  getAuthGroups: RequestHandler = this.asyncHandler(async (req: Request, res: Response) => {
    const authGroups = await this.service.getAuthGroups();
    
    return this.success(res, { authGroups, count: authGroups.length });
  });

  /**
   * @description GET /api/tools/search - Full-text search across tools
   * Query params: q (search term)
   */
  searchTools: RequestHandler = this.asyncHandler(async (req: Request, res: Response) => {
    const { q } = req.query;
    const query = Array.isArray(q) ? q[0] : q;
    if (!query || typeof query !== 'string') {
      return this.badRequest(res, 'Search query parameter "q" is required');
    }
    
    const tools = await this.service.searchTools(query);
    
    return this.success(res, { tools, count: tools.length, query });
  });
}
