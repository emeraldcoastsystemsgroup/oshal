/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

const { Queue: BullMQQueue } = require('bullmq');
const Redis = require('ioredis');
const logger = require('../utils/logger');

/**
 * @description Service that backs the Bull Board dashboard and the custom queue
 * monitoring API. It owns a single shared ioredis connection and the set of
 * BullMQ queue instances (rag-upload, presentron, gitlab) so the rest of the
 * app can observe, inspect, and operate on background jobs without each caller
 * managing its own Redis lifecycle. Job state is read directly from Redis keys
 * (rather than only through BullMQ) so metrics and lifecycle operations also
 * cover jobs written by external workers that share the same key prefixes.
 * Exported as a singleton (see module.exports) so connections and queue
 * instances are reused process-wide.
 */
class QueueMonitorService {
  constructor() {
    this.redis = null;
    this.queues = {}; // Store all queue instances
    this.initialized = false;
  }

  /**
   * Initialize Redis connection and all queues
   */
  initialize() {
    if (this.initialized) {
      return;
    }

    try {
      this.redis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        retryStrategy(times) {
          const delay = Math.min(times * 50, 2000);
          logger.info(`Redis retry attempt ${times}, waiting ${delay}ms`);
          return delay;
        },
        maxRetriesPerRequest: null,
        enableReadyCheck: false
      });

      this.redis.on('connect', () => {
        logger.info('QueueMonitorService: Redis connected');
      });

      this.redis.on('error', (err) => {
        logger.error('QueueMonitorService: Redis error:', err);
      });

      // Create BullMQ queue instances for all queue types with correct prefixes
      // Note: gitlab queue uses 'presentron' prefix to share with presentron jobs
      const queueConfigs = [
        { name: 'rag-upload', prefix: 'rag-upload' },
        { name: 'presentron', prefix: 'presentron' },
        { name: 'gitlab', prefix: 'presentron' }
      ];
      
      for (const config of queueConfigs) {
        this.queues[config.name] = new BullMQQueue(config.name, {
          connection: this.redis,
          prefix: config.prefix
        });
        logger.info(`Created ${config.name} queue instance (prefix: ${config.prefix}) for Bull Board`);
      }

      this.initialized = true;
      logger.info('QueueMonitorService initialized with all queue types');
    } catch (error) {
      logger.error('Failed to initialize QueueMonitorService:', error);
      throw error;
    }
  }

  /**
   * Get all queue instances for Bull Board
   */
  getAllQueues() {
    if (!this.initialized) {
      this.initialize();
    }
    return Object.values(this.queues);
  }

  /**
   * Get specific queue by type
   */
  getQueue(queueType = 'rag-upload') {
    if (!this.initialized) {
      this.initialize();
    }
    return this.queues[queueType] || this.queues['rag-upload'];
  }

  /**
   * Get custom metrics from actual worker jobs with per-queue breakdown
   */
  async getMetrics() {
    try {
      if (!this.initialized) {
        this.initialize();
      }

      // Get all job keys (including both prefixes)
      const jobKeys = await this.redis.keys('*:job:*');
      
      // Count by status (total)
      const statusCounts = {
        waiting: 0,
        queued: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        total: jobKeys.length
      };

      // Track per-queue metrics
      const queueMetrics = {};
      
      // Track processing times
      const processingTimes = [];
      
      // Parse all jobs
      for (const key of jobKeys) {
        try {
          const data = await this.redis.get(key);
          if (!data) continue;
          
          const job = JSON.parse(data);
          
          // Determine queue type from key
          let queueType = 'unknown';
          if (key.startsWith('rag-upload:')) {
            queueType = 'rag-upload';
          } else if (key.startsWith('presentron:')) {
            queueType = 'presentron';
          } else if (key.startsWith('gitlab:')) {
            queueType = 'gitlab';
          }
          
          // Initialize queue metrics if needed
          if (!queueMetrics[queueType]) {
            queueMetrics[queueType] = {
              waiting: 0,
              queued: 0,
              processing: 0,
              completed: 0,
              failed: 0,
              total: 0,
              processingTimes: []
            };
          }
          
          queueMetrics[queueType].total++;
          
          // Count by status (total)
          if (job.status) {
            if (statusCounts[job.status] !== undefined) {
              statusCounts[job.status]++;
            } else if (job.status === 'waiting') {
              statusCounts.waiting++;
            }
            
            // Count by status (per queue)
            if (queueMetrics[queueType][job.status] !== undefined) {
              queueMetrics[queueType][job.status]++;
            }
          }
          
          // Calculate processing time for completed jobs
          if (job.status === 'completed' && job.started_at && job.completed_at) {
            let startTime, endTime;
            
            // Handle both timestamp formats (seconds and ISO strings)
            if (typeof job.started_at === 'number') {
              startTime = job.started_at * 1000; // Convert to milliseconds
            } else {
              startTime = new Date(job.started_at).getTime();
            }
            
            if (typeof job.completed_at === 'number') {
              endTime = job.completed_at * 1000; // Convert to milliseconds
            } else {
              endTime = new Date(job.completed_at).getTime();
            }
            
            const duration = endTime - startTime;
            if (duration > 0 && duration < 3600000) { // Sanity check: less than 1 hour
              processingTimes.push(duration);
              queueMetrics[queueType].processingTimes.push(duration);
            }
          }
        } catch (err) {
          logger.warn(`Failed to parse job ${key}:`, err.message);
        }
      }

      // Calculate average processing time (total)
      const avgProcessingTime = processingTimes.length > 0
        ? processingTimes.reduce((sum, t) => sum + t, 0) / processingTimes.length
        : 0;

      // Calculate failure rate (total)
      const completedAndFailed = statusCounts.completed + statusCounts.failed;
      const failureRate = completedAndFailed > 0
        ? statusCounts.failed / completedAndFailed
        : 0;

      // Calculate per-queue performance metrics
      const queues = {};
      for (const [queueType, metrics] of Object.entries(queueMetrics)) {
        const queueAvgTime = metrics.processingTimes.length > 0
          ? metrics.processingTimes.reduce((sum, t) => sum + t, 0) / metrics.processingTimes.length
          : 0;
        
        const queueCompletedAndFailed = metrics.completed + metrics.failed;
        const queueFailureRate = queueCompletedAndFailed > 0
          ? metrics.failed / queueCompletedAndFailed
          : 0;
        
        queues[queueType] = {
          waiting: metrics.waiting,
          queued: metrics.queued,
          processing: metrics.processing,
          completed: metrics.completed,
          failed: metrics.failed,
          total: metrics.total,
          avgProcessingTime: Math.round(queueAvgTime),
          throughput: metrics.completed,
          failureRate: parseFloat(queueFailureRate.toFixed(4))
        };
      }

      return {
        queue: {
          waiting: statusCounts.waiting,
          queued: statusCounts.queued,
          processing: statusCounts.processing,
          completed: statusCounts.completed,
          failed: statusCounts.failed,
          total: statusCounts.total
        },
        queues, // Per-queue breakdown
        performance: {
          avgProcessingTime: Math.round(avgProcessingTime),
          throughput: statusCounts.completed,
          failureRate: parseFloat(failureRate.toFixed(4))
        },
        workers: {
          active: statusCounts.processing,
          idle: 2 - statusCounts.processing // Assuming 2 workers
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Error getting queue metrics:', error);
      throw error;
    }
  }

  /**
   * Get job details by ID
   */
  async getJobDetails(jobId) {
    try {
      if (!this.initialized) {
        this.initialize();
      }

      // Try different key patterns
      const patterns = [
        `rag-upload:job:${jobId}`,
        `presentron:job:${jobId}`,
        `rag-upload:job:rag-upload:job:${jobId}`,
        jobId // In case full key is provided
      ];

      for (const pattern of patterns) {
        const data = await this.redis.get(pattern);
        if (data) {
          return JSON.parse(data);
        }
      }

      return null;
    } catch (error) {
      logger.error(`Error getting job ${jobId}:`, error);
      throw error;
    }
  }

  /**
   * Get all jobs with pagination
   */
  async getAllJobs(limit = 50, offset = 0) {
    try {
      if (!this.initialized) {
        this.initialize();
      }

      const jobKeys = await this.redis.keys('*:job:*');
      const paginatedKeys = jobKeys.slice(offset, offset + limit);

      const jobs = [];
      for (const key of paginatedKeys) {
        try {
          const data = await this.redis.get(key);
          if (data) {
            const job = JSON.parse(data);
            job._key = key; // Include the Redis key
            jobs.push(job);
          }
        } catch (err) {
          logger.warn(`Failed to parse job ${key}:`, err.message);
        }
      }

      return {
        jobs,
        total: jobKeys.length,
        limit,
        offset
      };
    } catch (error) {
      logger.error('Error getting all jobs:', error);
      throw error;
    }
  }

  /**
   * Retry a failed job
   */
  async retryJob(jobId) {
    try {
      if (!this.initialized) {
        this.initialize();
      }

      const job = await this.getJobDetails(jobId);
      if (!job) {
        throw new Error('Job not found');
      }

      if (job.status !== 'failed') {
        throw new Error('Job is not in failed state');
      }

      // Reset status and re-queue
      job.status = 'queued';
      job.retried_at = new Date().toISOString();
      delete job.error;
      delete job.completed_at;

      // Determine the correct key pattern
      const key = job._key || `rag-upload:job:${jobId}`;
      await this.redis.setex(key, 86400, JSON.stringify(job));
      await this.redis.lpush('rag-upload:jobs', JSON.stringify(job));

      logger.info(`Job ${jobId} retried successfully`);
      return { success: true, jobId };
    } catch (error) {
      logger.error(`Error retrying job ${jobId}:`, error);
      throw error;
    }
  }

  /**
   * Cancel a job
   */
  async cancelJob(jobId) {
    try {
      if (!this.initialized) {
        this.initialize();
      }

      const job = await this.getJobDetails(jobId);
      if (!job) {
        throw new Error('Job not found');
      }

      if (job.status === 'processing') {
        throw new Error('Cannot cancel job that is currently processing');
      }

      if (job.status === 'completed') {
        throw new Error('Cannot cancel completed job');
      }

      // Update status
      job.status = 'cancelled';
      job.cancelled_at = new Date().toISOString();

      const key = job._key || `rag-upload:job:${jobId}`;
      await this.redis.setex(key, 86400, JSON.stringify(job));

      logger.info(`Job ${jobId} cancelled successfully`);
      return { success: true, jobId };
    } catch (error) {
      logger.error(`Error cancelling job ${jobId}:`, error);
      throw error;
    }
  }

  /**
   * Clear all failed jobs
   */
  async clearFailedJobs() {
    try {
      if (!this.initialized) {
        this.initialize();
      }

      const jobKeys = await this.redis.keys('*:job:*');
      let clearedCount = 0;

      for (const key of jobKeys) {
        const data = await this.redis.get(key);
        if (data) {
          const job = JSON.parse(data);
          if (job.status === 'failed') {
            await this.redis.del(key);
            clearedCount++;
          }
        }
      }

      logger.info(`Cleared ${clearedCount} failed jobs`);
      return { success: true, clearedCount };
    } catch (error) {
      logger.error('Error clearing failed jobs:', error);
      throw error;
    }
  }

  /**
   * Clean up old jobs (older than retention period)
   */
  async cleanupOldJobs(retentionHours = 72) {
    try {
      if (!this.initialized) {
        this.initialize();
      }

      const jobKeys = await this.redis.keys('*:job:*');
      const cutoffTime = Date.now() - (retentionHours * 60 * 60 * 1000);
      let cleanedCount = 0;

      for (const key of jobKeys) {
        const data = await this.redis.get(key);
        if (data) {
          const job = JSON.parse(data);
          const jobTime = job.completed_at || job.created_at;
          
          let jobTimestamp;
          if (typeof jobTime === 'number') {
            jobTimestamp = jobTime * 1000; // Convert seconds to milliseconds
          } else if (jobTime) {
            jobTimestamp = new Date(jobTime).getTime();
          }
          
          if (jobTimestamp && jobTimestamp < cutoffTime) {
            await this.redis.del(key);
            cleanedCount++;
          }
        }
      }

      logger.info(`Cleaned up ${cleanedCount} old jobs (older than ${retentionHours}h)`);
      return { success: true, cleanedCount };
    } catch (error) {
      logger.error('Error cleaning up old jobs:', error);
      throw error;
    }
  }

  /**
   * Disconnect from Redis
   */
  async disconnect() {
    try {
      if (this.redis) {
        await this.redis.quit();
        logger.info('QueueMonitorService: Redis disconnected');
      }
      // Close all queue instances
      for (const queue of Object.values(this.queues)) {
        await queue.close();
      }
      this.initialized = false;
    } catch (error) {
      logger.error('Error disconnecting QueueMonitorService:', error);
    }
  }
}

module.exports = new QueueMonitorService();
