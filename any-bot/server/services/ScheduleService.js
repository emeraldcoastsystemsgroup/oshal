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
const { v4: uuidv4 } = require('uuid');

/**
 * @description Manages agent task schedules backed by BullMQ and Redis. Exists to
 * give the agent a durable, restart-safe way to register one-time and recurring
 * (cron-pattern) jobs, persist their metadata separately from the queue, and
 * pause/resume/trigger/delete them without losing audit information such as
 * execution counts and next-run times.
 */
class ScheduleService {
  /**
   * @description Creates an uninitialized service instance. Connection and queue
   * setup are deferred to initialize() so the service can be constructed cheaply
   * (e.g. at module load) before Redis is reachable or needed.
   */
  constructor() {
    this.redis = null;
    this.schedulerQueue = null;
    this.initialized = false;
  }

  /**
   * Initialize Redis connection and scheduler queue
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
          logger.info(`ScheduleService Redis retry attempt ${times}, waiting ${delay}ms`);
          return delay;
        },
        maxRetriesPerRequest: null,
        enableReadyCheck: false
      });

      this.redis.on('connect', () => {
        logger.info('ScheduleService: Redis connected');
      });

      this.redis.on('error', (err) => {
        logger.error('ScheduleService: Redis error:', err);
      });

      // Create agent-scheduler queue
      this.schedulerQueue = new BullMQQueue('agent-scheduler', {
        connection: this.redis,
        prefix: 'agent-scheduler'
      });

      this.initialized = true;
      logger.info('ScheduleService initialized with agent-scheduler queue');
    } catch (error) {
      logger.error('Failed to initialize ScheduleService:', error);
      throw error;
    }
  }

  /**
   * Get scheduler queue instance for Bull Board
   */
  getSchedulerQueue() {
    if (!this.initialized) {
      this.initialize();
    }
    return this.schedulerQueue;
  }

  /**
   * Create a new schedule
   */
  async createSchedule(scheduleData) {
    try {
      if (!this.initialized) {
        this.initialize();
      }

      const {
        taskType,
        schedule,
        taskData,
        repeatOptions = {},
        createdBy = 'agent'
      } = scheduleData;

      // Validate required fields
      if (!taskType || !schedule || !taskData) {
        throw new Error('Missing required fields: taskType, schedule, taskData');
      }

      const scheduleId = `schedule-${uuidv4()}`;
      const now = new Date().toISOString();

      // Prepare schedule record
      const scheduleRecord = {
        scheduleId,
        taskType,
        pattern: schedule,
        repeatOptions,
        taskData,
        createdAt: now,
        createdBy,
        lastExecution: null,
        nextExecution: null,
        executionCount: 0,
        status: 'active'
      };

      // Store schedule metadata in Redis
      await this.redis.setex(
        `agent-scheduler:schedule:${scheduleId}`,
        86400 * 30, // 30 days TTL
        JSON.stringify(scheduleRecord)
      );

      // Add job to BullMQ with repeat pattern
      let jobOptions = {
        jobId: scheduleId
      };

      if (schedule === 'once') {
        // One-time delayed job
        jobOptions.delay = repeatOptions.delay || 0;
      } else {
        // Repeatable job with cron pattern
        jobOptions.repeat = {
          pattern: schedule,
          limit: repeatOptions.limit || undefined,
          endDate: repeatOptions.endDate || undefined,
          immediately: repeatOptions.immediately || false
        };
      }

      await this.schedulerQueue.add(
        taskType,
        {
          scheduleId,
          taskType,
          taskData,
          createdBy
        },
        jobOptions
      );

      // Calculate next execution time
      if (schedule !== 'once') {
        const repeatableJobs = await this.schedulerQueue.getRepeatableJobs();
        const job = repeatableJobs.find(j => j.key.includes(scheduleId));
        if (job && job.next) {
          scheduleRecord.nextExecution = new Date(job.next).toISOString();
          await this.redis.setex(
            `agent-scheduler:schedule:${scheduleId}`,
            86400 * 30,
            JSON.stringify(scheduleRecord)
          );
        }
      }

      logger.info(`Schedule created: ${scheduleId} (${taskType})`);
      return scheduleRecord;
    } catch (error) {
      logger.error('Error creating schedule:', error);
      throw error;
    }
  }

  /**
   * Get all schedules
   */
  async getAllSchedules() {
    try {
      if (!this.initialized) {
        this.initialize();
      }

      const scheduleKeys = await this.redis.keys('agent-scheduler:schedule:*');
      const schedules = [];

      for (const key of scheduleKeys) {
        const data = await this.redis.get(key);
        if (data) {
          schedules.push(JSON.parse(data));
        }
      }

      // Sort by creation date (newest first)
      schedules.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      return schedules;
    } catch (error) {
      logger.error('Error getting all schedules:', error);
      throw error;
    }
  }

  /**
   * Get schedule by ID
   */
  async getSchedule(scheduleId) {
    try {
      if (!this.initialized) {
        this.initialize();
      }

      const data = await this.redis.get(`agent-scheduler:schedule:${scheduleId}`);
      if (!data) {
        return null;
      }

      return JSON.parse(data);
    } catch (error) {
      logger.error(`Error getting schedule ${scheduleId}:`, error);
      throw error;
    }
  }

  /**
   * Update schedule
   */
  async updateSchedule(scheduleId, updates) {
    try {
      if (!this.initialized) {
        this.initialize();
      }

      const schedule = await this.getSchedule(scheduleId);
      if (!schedule) {
        throw new Error('Schedule not found');
      }

      // Merge updates
      const updatedSchedule = {
        ...schedule,
        ...updates,
        updatedAt: new Date().toISOString()
      };

      // Update Redis
      await this.redis.setex(
        `agent-scheduler:schedule:${scheduleId}`,
        86400 * 30,
        JSON.stringify(updatedSchedule)
      );

      logger.info(`Schedule updated: ${scheduleId}`);
      return updatedSchedule;
    } catch (error) {
      logger.error(`Error updating schedule ${scheduleId}:`, error);
      throw error;
    }
  }

  /**
   * Pause a schedule
   */
  async pauseSchedule(scheduleId) {
    try {
      if (!this.initialized) {
        this.initialize();
      }

      const schedule = await this.getSchedule(scheduleId);
      if (!schedule) {
        throw new Error('Schedule not found');
      }

      // Update status
      schedule.status = 'paused';
      schedule.pausedAt = new Date().toISOString();

      await this.redis.setex(
        `agent-scheduler:schedule:${scheduleId}`,
        86400 * 30,
        JSON.stringify(schedule)
      );

      // Remove repeatable job from BullMQ
      const repeatableJobs = await this.schedulerQueue.getRepeatableJobs();
      const job = repeatableJobs.find(j => j.key.includes(scheduleId));
      if (job) {
        await this.schedulerQueue.removeRepeatableByKey(job.key);
      }

      logger.info(`Schedule paused: ${scheduleId}`);
      return schedule;
    } catch (error) {
      logger.error(`Error pausing schedule ${scheduleId}:`, error);
      throw error;
    }
  }

  /**
   * Resume a paused schedule
   */
  async resumeSchedule(scheduleId) {
    try {
      if (!this.initialized) {
        this.initialize();
      }

      const schedule = await this.getSchedule(scheduleId);
      if (!schedule) {
        throw new Error('Schedule not found');
      }

      if (schedule.status !== 'paused') {
        throw new Error('Schedule is not paused');
      }

      // Update status
      schedule.status = 'active';
      schedule.resumedAt = new Date().toISOString();
      delete schedule.pausedAt;

      await this.redis.setex(
        `agent-scheduler:schedule:${scheduleId}`,
        86400 * 30,
        JSON.stringify(schedule)
      );

      // Re-add repeatable job to BullMQ
      if (schedule.pattern !== 'once') {
        await this.schedulerQueue.add(
          schedule.taskType,
          {
            scheduleId,
            taskType: schedule.taskType,
            taskData: schedule.taskData,
            createdBy: schedule.createdBy
          },
          {
            jobId: scheduleId,
            repeat: {
              pattern: schedule.pattern,
              limit: schedule.repeatOptions.limit || undefined,
              endDate: schedule.repeatOptions.endDate || undefined
            }
          }
        );
      }

      logger.info(`Schedule resumed: ${scheduleId}`);
      return schedule;
    } catch (error) {
      logger.error(`Error resuming schedule ${scheduleId}:`, error);
      throw error;
    }
  }

  /**
   * Trigger a schedule immediately (one-shot, regardless of status)
   * Does NOT require the schedule to be paused first.
   */
  async triggerNow(scheduleId) {
    try {
      if (!this.initialized) {
        this.initialize();
      }

      const schedule = await this.getSchedule(scheduleId);
      if (!schedule) {
        throw new Error('Schedule not found');
      }

      // Add a one-time immediate job (no repeat options)
      const immediateJobId = `${scheduleId}-manual-${Date.now()}`;
      await this.schedulerQueue.add(
        schedule.taskType,
        {
          scheduleId,
          taskType: schedule.taskType,
          taskData: schedule.taskData,
          createdBy: 'manual-trigger',
          triggeredAt: new Date().toISOString(),
        },
        {
          jobId: immediateJobId,
          // No repeat — fires once immediately
        }
      );

      logger.info(`Schedule triggered immediately: ${scheduleId} (job: ${immediateJobId})`);
      return { success: true, scheduleId, jobId: immediateJobId, triggeredAt: new Date().toISOString() };
    } catch (error) {
      logger.error(`Error triggering schedule ${scheduleId}:`, error);
      throw error;
    }
  }

  /**
   * Delete a schedule
   */
  async deleteSchedule(scheduleId) {
    try {
      if (!this.initialized) {
        this.initialize();
      }

      const schedule = await this.getSchedule(scheduleId);
      if (!schedule) {
        throw new Error('Schedule not found');
      }

      // Remove from Redis
      await this.redis.del(`agent-scheduler:schedule:${scheduleId}`);

      // Remove repeatable job from BullMQ
      const repeatableJobs = await this.schedulerQueue.getRepeatableJobs();
      const job = repeatableJobs.find(j => j.key.includes(scheduleId));
      if (job) {
        await this.schedulerQueue.removeRepeatableByKey(job.key);
      }

      logger.info(`Schedule deleted: ${scheduleId}`);
      return { success: true, scheduleId };
    } catch (error) {
      logger.error(`Error deleting schedule ${scheduleId}:`, error);
      throw error;
    }
  }

  /**
   * Record schedule execution
   */
  async recordExecution(scheduleId, result) {
    try {
      if (!this.initialized) {
        this.initialize();
      }

      const schedule = await this.getSchedule(scheduleId);
      if (!schedule) {
        logger.warn(`Schedule not found for execution record: ${scheduleId}`);
        return;
      }

      // Update execution metadata
      schedule.lastExecution = new Date().toISOString();
      schedule.executionCount = (schedule.executionCount || 0) + 1;
      schedule.lastResult = result;

      // Calculate next execution for repeatable jobs
      if (schedule.pattern !== 'once') {
        const repeatableJobs = await this.schedulerQueue.getRepeatableJobs();
        const job = repeatableJobs.find(j => j.key.includes(scheduleId));
        if (job && job.next) {
          schedule.nextExecution = new Date(job.next).toISOString();
        }
      }

      await this.redis.setex(
        `agent-scheduler:schedule:${scheduleId}`,
        86400 * 30,
        JSON.stringify(schedule)
      );

      logger.info(`Execution recorded for schedule: ${scheduleId}`);
    } catch (error) {
      logger.error(`Error recording execution for ${scheduleId}:`, error);
    }
  }

  /**
   * Disconnect from Redis
   */
  async disconnect() {
    try {
      if (this.schedulerQueue) {
        await this.schedulerQueue.close();
      }
      if (this.redis) {
        await this.redis.quit();
        logger.info('ScheduleService: Redis disconnected');
      }
      this.initialized = false;
    } catch (error) {
      logger.error('Error disconnecting ScheduleService:', error);
    }
  }
}

module.exports = ScheduleService;
