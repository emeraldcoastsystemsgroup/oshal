/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — tail-read log file with structured filtering by ticketId, level, module, and free text
 */

import fs from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'LogReaderService' });

/** @description Shape of one parsed log entry returned to the API consumer. */
export interface LogEntry {
  level: number;
  levelLabel: string;
  time: string;
  msg: string;
  module?: string;
  ticketId?: string;
  agentId?: string;
  runId?: string;
  phase?: string;
  round?: number;
  [key: string]: unknown;
}

/** @description Query parameters accepted by the log reader. */
export interface LogQuery {
  ticketIds?: string[];
  levels?: string[];
  module?: string;
  search?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

/** @description Result shape returned by the log reader. */
export interface LogQueryResult {
  entries: LogEntry[];
  total: number;
  hasMore: boolean;
}

const PINO_LEVELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

const LEVEL_NAME_TO_NUM: Record<string, number> = {
  trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60,
};

/** Default and maximum read window in bytes (1 MB). */
const DEFAULT_READ_BYTES = 1_048_576;
const MAX_READ_BYTES = 4_194_304;

/**
 * @description Reads structured JSON logs from the pino log file,
 * filtering by ticket, level, module, and free text.
 * Reads from the tail of the file so newest entries appear first.
 */
export class LogReaderService {
  private readonly logFilePath: string;

  constructor(logFilePath?: string) {
    const logFileName = `${process.env.SERVICE_NAME || 'OSHAL'}.log`;
    this.logFilePath = logFilePath ?? path.resolve(process.cwd(), 'output', 'logs', logFileName);
  }

  /**
   * @description Query log entries with filters.
   * Reads the tail of the log file, parses line-delimited JSON, applies filters,
   * and returns paginated results (newest first).
   */
  async query(query: LogQuery): Promise<LogQueryResult> {
    const limit = Math.min(query.limit ?? 200, 1000);
    const offset = query.offset ?? 0;

    if (!fs.existsSync(this.logFilePath)) {
      logger.warn({ logFilePath: this.logFilePath }, 'Log file not found');
      return { entries: [], total: 0, hasMore: false };
    }

    const stat = fs.statSync(this.logFilePath);
    if (stat.size === 0) {
      return { entries: [], total: 0, hasMore: false };
    }

    // Read a chunk from the tail; double once if we don't find enough entries.
    let readBytes = DEFAULT_READ_BYTES;
    let allEntries = this.readTailAndParse(stat.size, readBytes, query);

    if (allEntries.length < limit + offset && readBytes < stat.size) {
      readBytes = Math.min(MAX_READ_BYTES, stat.size);
      allEntries = this.readTailAndParse(stat.size, readBytes, query);
    }

    const total = allEntries.length;
    const page = allEntries.slice(offset, offset + limit);

    logger.debug(
      { total, returned: page.length, offset, limit, filters: Object.keys(query).length },
      'Log query completed',
    );

    return { entries: page, total, hasMore: offset + limit < total };
  }

  /**
   * @description Returns the list of distinct module names found in a recent sample of log lines.
   */
  async getModules(): Promise<string[]> {
    if (!fs.existsSync(this.logFilePath)) return [];
    const stat = fs.statSync(this.logFilePath);
    if (stat.size === 0) return [];

    const lines = this.readTailLines(stat.size, DEFAULT_READ_BYTES);
    const modules = new Set<string>();
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.module) modules.add(parsed.module as string);
      } catch { /* skip malformed lines */ }
    }
    return Array.from(modules).sort();
  }

  // ── Internal helpers ──────────────────────────────────────────────

  private readTailAndParse(fileSize: number, readBytes: number, query: LogQuery): LogEntry[] {
    const lines = this.readTailLines(fileSize, readBytes);
    // Reverse so newest is first.
    lines.reverse();
    return this.filterAndMap(lines, query);
  }

  private readTailLines(fileSize: number, readBytes: number): string[] {
    const start = Math.max(0, fileSize - readBytes);
    const buf = Buffer.alloc(Math.min(readBytes, fileSize));
    const fd = fs.openSync(this.logFilePath, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    const raw = buf.toString('utf8');
    // If we started mid-file, drop the first partial line.
    const lines = raw.split('\n').filter(Boolean);
    if (start > 0 && lines.length > 0) lines.shift();
    return lines;
  }

  private filterAndMap(lines: string[], query: LogQuery): LogEntry[] {
    const ticketSet = query.ticketIds?.length ? new Set(query.ticketIds) : null;
    const levelSet = query.levels?.length
      ? new Set(query.levels.map(l => LEVEL_NAME_TO_NUM[l.toLowerCase()]).filter(Boolean))
      : null;
    const sinceMs = query.since ? new Date(query.since).getTime() : null;
    const untilMs = query.until ? new Date(query.until).getTime() : null;
    const searchLower = query.search?.toLowerCase() ?? null;
    const moduleFilter = query.module?.toLowerCase() ?? null;

    const entries: LogEntry[] = [];

    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch { continue; }

      // Level filter
      const level = parsed.level as number;
      if (levelSet && !levelSet.has(level)) continue;

      // Module filter
      if (moduleFilter && (parsed.module as string || '').toLowerCase() !== moduleFilter) continue;

      // Ticket filter
      if (ticketSet && !ticketSet.has(parsed.ticketId as string)) continue;

      // Time filter
      const time = parsed.time as string;
      if (time) {
        const ms = new Date(time).getTime();
        if (sinceMs && ms < sinceMs) continue;
        if (untilMs && ms > untilMs) continue;
      }

      // Free text search
      if (searchLower && !line.toLowerCase().includes(searchLower)) continue;

      entries.push(this.toLogEntry(parsed));
    }

    return entries;
  }

  private toLogEntry(raw: Record<string, unknown>): LogEntry {
    const level = raw.level as number;
    return {
      ...raw,
      level,
      levelLabel: PINO_LEVELS[level] ?? 'unknown',
      time: raw.time as string ?? '',
      msg: raw.msg as string ?? '',
      module: raw.module as string | undefined,
      ticketId: raw.ticketId as string | undefined,
      agentId: raw.agentId as string | undefined,
      runId: raw.runId as string | undefined,
      phase: raw.phase as string | undefined,
      round: raw.round as number | undefined,
    };
  }
}
