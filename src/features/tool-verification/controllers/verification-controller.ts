/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of VerificationController
 */

import { Request, Response } from 'express';
import { ToolVerificationService } from '../services/tool-verification-service';
import { VerificationScheduler } from '../services/verification-scheduler';
import { logger } from '@/shared/logger';

/**
 * @description REST controller for tool verification operations.
 * Handles HTTP requests for verifying tools and checking verification status.
 */
export class VerificationController {
  private readonly logger = logger.child({ controller: 'VerificationController' });

  constructor(
    private readonly verificationService: ToolVerificationService,
    private readonly scheduler: VerificationScheduler
  ) {}

  /**
   * @description Verify a single tool
   * POST /api/tools/verify/:toolId
   * 
   * @param req - Express request with toolId param
   * @param res - Express response
   */
  verifySingleTool = async (req: Request, res: Response): Promise<void> => {
    const { toolId } = req.params;
    const toolIdStr = Array.isArray(toolId) ? toolId[0] : toolId;
    const verifiedBy = (req as any).user?.sub || 'system';

    try {
      this.logger.info({ toolId: toolIdStr, verifiedBy }, 'Verifying single tool');
      const result = await this.verificationService.verifyTool(toolIdStr, verifiedBy);
      res.json(result);
    } catch (error: any) {
      this.logger.error({ toolId: toolIdStr, err: error }, 'Failed to verify tool');
      res.status(500).json({
        error: 'Failed to verify tool',
        message: error.message,
      });
    }
  };

  /**
   * @description Verify all enabled tools
   * POST /api/tools/verify
   * 
   * @param req - Express request
   * @param res - Express response
   */
  verifyAllTools = async (req: Request, res: Response): Promise<void> => {
    const verifiedBy = (req as any).user?.sub || 'system';

    try {
      this.logger.info({ verifiedBy }, 'Verifying all tools');
      const summary = await this.verificationService.verifyAllTools(verifiedBy);
      res.json(summary);
    } catch (error: any) {
      this.logger.error({ err: error }, 'Failed to verify all tools');
      res.status(500).json({
        error: 'Failed to verify all tools',
        message: error.message,
      });
    }
  };

  /**
   * @description Get latest verification result for a tool
   * GET /api/tools/verify/:toolId/latest
   * 
   * @param req - Express request with toolId param
   * @param res - Express response
   */
  getLatestResult = async (req: Request, res: Response): Promise<void> => {
    const { toolId } = req.params;
    const toolIdStr = Array.isArray(toolId) ? toolId[0] : toolId;

    try {
      this.logger.debug({ toolId: toolIdStr }, 'Fetching latest verification result');
      const result = await this.verificationService.getLatestVerificationResult(toolIdStr);
      
      if (!result) {
        res.status(404).json({ error: 'No verification results found for this tool' });
        return;
      }

      res.json(result);
    } catch (error: any) {
      this.logger.error({ toolId: toolIdStr, err: error }, 'Failed to fetch latest result');
      res.status(500).json({
        error: 'Failed to fetch verification result',
        message: error.message,
      });
    }
  };

  /**
   * @description Get verification history for a tool
   * GET /api/tools/verify/:toolId/history?limit=10
   * 
   * @param req - Express request with toolId param and optional limit query
   * @param res - Express response
   */
  getVerificationHistory = async (req: Request, res: Response): Promise<void> => {
    const { toolId } = req.params;
    const toolIdStr = Array.isArray(toolId) ? toolId[0] : toolId;
    const limit = parseInt(req.query.limit as string) || 10;

    try {
      this.logger.debug({ toolId: toolIdStr, limit }, 'Fetching verification history');
      const history = await this.verificationService.getVerificationHistory(toolIdStr, limit);
      res.json(history);
    } catch (error: any) {
      this.logger.error({ toolId: toolIdStr, err: error }, 'Failed to fetch verification history');
      res.status(500).json({
        error: 'Failed to fetch verification history',
        message: error.message,
      });
    }
  };

  /**
   * @description Get all verification results (latest per tool)
   * GET /api/tools/verify/results
   * 
   * @param req - Express request
   * @param res - Express response
   */
  getAllResults = async (req: Request, res: Response): Promise<void> => {
    try {
      this.logger.debug('Fetching all verification results');
      const results = await this.verificationService.getAllVerificationResults();
      res.json(results);
    } catch (error: any) {
      this.logger.error({ err: error }, 'Failed to fetch all verification results');
      res.status(500).json({
        error: 'Failed to fetch verification results',
        message: error.message,
      });
    }
  };

  /**
   * @description Get scheduler status
   * GET /api/tools/verify/scheduler/status
   * 
   * @param req - Express request
   * @param res - Express response
   */
  getSchedulerStatus = async (req: Request, res: Response): Promise<void> => {
    try {
      const isRunning = this.scheduler.getStatus();
      res.json({ isRunning });
    } catch (error: any) {
      this.logger.error({ err: error }, 'Failed to get scheduler status');
      res.status(500).json({
        error: 'Failed to get scheduler status',
        message: error.message,
      });
    }
  };

  /**
   * @description Start the verification scheduler
   * POST /api/tools/verify/scheduler/start
   * 
   * @param req - Express request
   * @param res - Express response
   */
  startScheduler = async (req: Request, res: Response): Promise<void> => {
    try {
      this.scheduler.start(false);
      res.json({ message: 'Scheduler started', isRunning: true });
    } catch (error: any) {
      this.logger.error({ err: error }, 'Failed to start scheduler');
      res.status(500).json({
        error: 'Failed to start scheduler',
        message: error.message,
      });
    }
  };

  /**
   * @description Stop the verification scheduler
   * POST /api/tools/verify/scheduler/stop
   * 
   * @param req - Express request
   * @param res - Express response
   */
  stopScheduler = async (req: Request, res: Response): Promise<void> => {
    try {
      this.scheduler.stop();
      res.json({ message: 'Scheduler stopped', isRunning: false });
    } catch (error: any) {
      this.logger.error({ err: error }, 'Failed to stop scheduler');
      res.status(500).json({
        error: 'Failed to stop scheduler',
        message: error.message,
      });
    }
  };

  /**
   * @description Trigger immediate verification run
   * POST /api/tools/verify/scheduler/run
   * 
   * @param req - Express request
   * @param res - Express response
   */
  runSchedulerNow = async (req: Request, res: Response): Promise<void> => {
    try {
      this.logger.info('Manual scheduler trigger requested');
      const summary = await this.scheduler.runNow();
      res.json(summary);
    } catch (error: any) {
      this.logger.error({ err: error }, 'Failed to run scheduler manually');
      res.status(500).json({
        error: 'Failed to run verification',
        message: error.message,
      });
    }
  };
}