/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const queueMonitorService = require('../services/QueueMonitorService');
const ScheduleService = require('../services/ScheduleService');
const logger = require('../utils/logger');

let serverAdapter = null;
let scheduleServiceInstance = null;

/**
 * Initialize Bull Board with all queue types
 */
function initializeBullBoard() {
  if (serverAdapter) {
    return serverAdapter;
  }

  try {
    // Create Express adapter
    serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/queue-dashboard');

    // Initialize queue monitor service
    queueMonitorService.initialize();

    // Get all queue instances and wrap them with BullMQAdapter
    const allQueues = queueMonitorService.getAllQueues();
    const queueAdapters = allQueues.map(queue => new BullMQAdapter(queue));

    // Create ScheduleService instance and get agent-scheduler queue
    if (!scheduleServiceInstance) {
      scheduleServiceInstance = new ScheduleService();
    }
    const schedulerQueue = scheduleServiceInstance.getSchedulerQueue();
    queueAdapters.push(new BullMQAdapter(schedulerQueue));

    // Create Bull Board with ALL queue types including agent-scheduler
    createBullBoard({
      queues: queueAdapters,
      serverAdapter
    });

    logger.info(`Bull Board initialized successfully with ${queueAdapters.length} queues`);
    return serverAdapter;
  } catch (error) {
    logger.error('Failed to initialize Bull Board:', error);
    throw error;
  }
}

/**
 * Get the server adapter (initialize if needed)
 */
function getBullBoardAdapter() {
  if (!serverAdapter) {
    return initializeBullBoard();
  }
  return serverAdapter;
}

module.exports = {
  initializeBullBoard,
  getBullBoardAdapter
};
