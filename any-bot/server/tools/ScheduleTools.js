/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Schedule Tools - Agent-accessible scheduling tools
 * Registers scheduling capabilities as native tools in the ToolRegistry
 */

const ScheduleService = require('../services/ScheduleService');
const logger = require('../utils/logger');

/**
 * @description Exposes the scheduling subsystem to the agent as a set of native,
 * approval-gated tools so the LLM can create, inspect, pause/resume, and delete
 * scheduled work without bespoke wiring. Acts as the registration bridge between
 * the ScheduleService (which owns the actual scheduling/persistence) and the
 * ToolRegistry the agent invokes against, keeping schedule-management capabilities
 * discoverable and uniformly described.
 */
class ScheduleTools {
  /**
   * @description Wires this tool group to the registry it will publish into and
   * stands up its own ScheduleService instance so the tool handlers have a backing
   * service to delegate persistence and timing to.
   * @param {object} toolRegistry - The ToolRegistry that scheduling tools are registered into and invoked through.
   */
  constructor(toolRegistry) {
    this.toolRegistry = toolRegistry;
    this.scheduleService = new ScheduleService();
  }

  /**
   * Register all scheduling tools
   */
  registerAll() {
    this.registerScheduleTask();
    this.registerListSchedules();
    this.registerGetSchedule();
    this.registerPauseSchedule();
    this.registerResumeSchedule();
    this.registerDeleteSchedule();
    
    logger.info('✅ Schedule tools registered successfully');
  }

  /**
   * Register schedule_task tool
   */
  registerScheduleTask() {
    this.toolRegistry.register({
      name: 'schedule_task',
      description: 'Schedule a task to run at a specific time or repeatedly using cron patterns. Use this when the agent needs to create a recurring schedule (e.g., "run every morning at 6am") or a one-time delayed task (e.g., "run in 5 minutes"). The worker will execute the task at the scheduled time and call back to execute the actual task logic.',
      category: 'scheduling',
      requiresApproval: false,
      timeout: 30000,
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Human-readable name for the schedule (e.g., "Daily Morning Report")'
          },
          taskType: {
            type: 'string',
            description: 'Type of task to execute. Supported types: generate_report, send_notification, cleanup_data, backup_data, health_check, custom_task',
            enum: ['generate_report', 'send_notification', 'cleanup_data', 'backup_data', 'health_check', 'custom_task']
          },
          schedule: {
            type: 'object',
            description: 'Schedule configuration - either cron pattern for recurring or delay for one-time',
            properties: {
              type: {
                type: 'string',
                enum: ['cron', 'delayed'],
                description: 'Schedule type: "cron" for recurring, "delayed" for one-time'
              },
              pattern: {
                type: 'string',
                description: 'Cron pattern for recurring schedules (e.g., "0 6 * * *" for 6am daily). Required if type is "cron".'
              },
              timezone: {
                type: 'string',
                description: 'Timezone for cron schedules (e.g., "America/New_York"). Defaults to UTC.'
              },
              delay: {
                type: 'number',
                description: 'Delay in milliseconds for one-time tasks. Required if type is "delayed".'
              }
            },
            required: ['type']
          },
          payload: {
            type: 'object',
            description: 'Task-specific data to pass to the task handler. Can contain any task-specific parameters.'
          }
        },
        required: ['name', 'taskType', 'schedule']
      },
      handler: async (input) => {
        try {
          const result = await this.scheduleService.createSchedule(input);
          return {
            success: true,
            scheduleId: result.scheduleId,
            status: result.status,
            nextRun: result.nextRun,
            message: `Schedule "${input.name}" created successfully. ${result.schedule.type === 'cron' ? `Runs on pattern: ${result.schedule.pattern}` : `Runs in ${result.schedule.delay}ms`}`
          };
        } catch (error) {
          logger.error('schedule_task tool error:', error);
          return {
            success: false,
            error: error.message
          };
        }
      }
    });
  }

  /**
   * Register list_schedules tool
   */
  registerListSchedules() {
    this.toolRegistry.register({
      name: 'list_schedules',
      description: 'List all currently active schedules. Returns schedule IDs, names, statuses, and next run times. Use this to see what tasks are scheduled.',
      category: 'scheduling',
      requiresApproval: false,
      timeout: 10000,
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['active', 'paused', 'all'],
            description: 'Filter by status: "active", "paused", or "all". Defaults to "all".'
          }
        }
      },
      handler: async (input) => {
        try {
          const schedules = await this.scheduleService.listSchedules(input.status);
          return {
            success: true,
            count: schedules.length,
            schedules: schedules.map(s => ({
              scheduleId: s.scheduleId,
              name: s.name,
              taskType: s.taskType,
              status: s.status,
              nextRun: s.nextRun,
              schedule: s.schedule
            }))
          };
        } catch (error) {
          logger.error('list_schedules tool error:', error);
          return {
            success: false,
            error: error.message
          };
        }
      }
    });
  }

  /**
   * Register get_schedule tool
   */
  registerGetSchedule() {
    this.toolRegistry.register({
      name: 'get_schedule',
      description: 'Get detailed information about a specific schedule by ID. Returns complete schedule configuration, status, and metadata.',
      category: 'scheduling',
      requiresApproval: false,
      timeout: 10000,
      inputSchema: {
        type: 'object',
        properties: {
          scheduleId: {
            type: 'string',
            description: 'The ID of the schedule to retrieve'
          }
        },
        required: ['scheduleId']
      },
      handler: async (input) => {
        try {
          const schedule = await this.scheduleService.getSchedule(input.scheduleId);
          if (!schedule) {
            return {
              success: false,
              error: 'Schedule not found'
            };
          }
          return {
            success: true,
            schedule
          };
        } catch (error) {
          logger.error('get_schedule tool error:', error);
          return {
            success: false,
            error: error.message
          };
        }
      }
    });
  }

  /**
   * Register pause_schedule tool
   */
  registerPauseSchedule() {
    this.toolRegistry.register({
      name: 'pause_schedule',
      description: 'Pause a scheduled task temporarily without deleting it. The schedule configuration is preserved and can be resumed later. Use this to temporarily stop a recurring task.',
      category: 'scheduling',
      requiresApproval: false,
      timeout: 10000,
      inputSchema: {
        type: 'object',
        properties: {
          scheduleId: {
            type: 'string',
            description: 'The ID of the schedule to pause'
          }
        },
        required: ['scheduleId']
      },
      handler: async (input) => {
        try {
          await this.scheduleService.pauseSchedule(input.scheduleId);
          return {
            success: true,
            message: `Schedule ${input.scheduleId} paused successfully`
          };
        } catch (error) {
          logger.error('pause_schedule tool error:', error);
          return {
            success: false,
            error: error.message
          };
        }
      }
    });
  }

  /**
   * Register resume_schedule tool
   */
  registerResumeSchedule() {
    this.toolRegistry.register({
      name: 'resume_schedule',
      description: 'Resume a paused schedule. The schedule will start running again according to its original configuration. Use this to restart a temporarily paused task.',
      category: 'scheduling',
      requiresApproval: false,
      timeout: 10000,
      inputSchema: {
        type: 'object',
        properties: {
          scheduleId: {
            type: 'string',
            description: 'The ID of the schedule to resume'
          }
        },
        required: ['scheduleId']
      },
      handler: async (input) => {
        try {
          const result = await this.scheduleService.resumeSchedule(input.scheduleId);
          return {
            success: true,
            nextRun: result.nextRun,
            message: `Schedule ${input.scheduleId} resumed successfully. Next run: ${result.nextRun}`
          };
        } catch (error) {
          logger.error('resume_schedule tool error:', error);
          return {
            success: false,
            error: error.message
          };
        }
      }
    });
  }

  /**
   * Register delete_schedule tool
   */
  registerDeleteSchedule() {
    this.toolRegistry.register({
      name: 'delete_schedule',
      description: 'Permanently delete a schedule. This cannot be undone - the schedule configuration will be removed and the task will stop running. Use this when you no longer need a scheduled task.',
      category: 'scheduling',
      requiresApproval: true, // Requires approval since it's destructive
      timeout: 10000,
      inputSchema: {
        type: 'object',
        properties: {
          scheduleId: {
            type: 'string',
            description: 'The ID of the schedule to delete'
          }
        },
        required: ['scheduleId']
      },
      handler: async (input) => {
        try {
          await this.scheduleService.deleteSchedule(input.scheduleId);
          return {
            success: true,
            message: `Schedule ${input.scheduleId} deleted successfully`
          };
        } catch (error) {
          logger.error('delete_schedule tool error:', error);
          return {
            success: false,
            error: error.message
          };
        }
      }
    });
  }
}

module.exports = ScheduleTools;
