/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of RAGIngestionIntegrationService
 */

/* eslint-disable import/no-cycle */

import { RAGIngestionConfig } from '@/shared/types/tool';
import axios from 'axios';

/**
 * @description Service for integrating RAG ingestion tool.
 * Provides methods for healthcheck, ingestion, and status reporting.
 */
export class RAGIngestionIntegrationService {
  private config: RAGIngestionConfig;

  /**
   * @description Initialize RAG ingestion integration with config
   * @param config - RAG ingestion integration configuration
   */
  constructor(config: RAGIngestionConfig) {
    this.config = config;
  }

  /**
   * @description Perform healthcheck on RAG ingestion endpoint
   * @returns Promise resolving to healthcheck status (true if healthy)
   */
  async healthcheck(): Promise<boolean> {
    try {
      const url = `${this.config.endpoint}/health`;
      const response = await axios.get(url);
      return response.status === 200;
    } catch (error) {
      // logger.error({ err: error, target: url }, 'RAG ingestion healthcheck failed');
      return false;
    }
  }

  /**
   * @description Ingest data into RAG system
   * @param fileData - File data to ingest (format, content, metadata)
   * @returns Promise resolving to ingestion result
   */
  async ingest(fileData: { format: string; content: Buffer | string; metadata?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const url = `${this.config.endpoint}/ingest`;
    try {
      const response = await axios.post(url, fileData);
      return response.data;
    } catch (error) {
      // logger.error({ err: error, target: url }, 'RAG ingestion failed');
      throw error;
    }
  }

  /**
   * @description Get RAG ingestion service status
   * @returns Promise resolving to status object
   */
  async getStatus(): Promise<{ healthy: boolean; lastChecked: Date }> {
    const healthy = await this.healthcheck();
    return {
      healthy,
      lastChecked: new Date(),
    };
  }
}