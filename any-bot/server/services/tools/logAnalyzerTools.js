/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Log Analyzer Tool Implementations — File-based log analysis
 * 
 * Provides real implementation for:
 * - analyze-logs: Reads log files and produces structured analysis reports
 * 
 * PHASE_16: Auto-discovered by app.js dynamic tool file scanning
 */

const logger = require('../../utils/logger');
const fs = require('fs');
const path = require('path');

/**
 * Analyze log files and return structured report.
 */
async function analyzeLogs(params) {
  const { logPath = '/app/logs/combined.log', lines = 200, format = 'md' } = params;

  logger.info(`[logAnalyzerTools] analyze-logs: path="${logPath}", lines=${lines}, format="${format}"`);

  try {
    // Read log file
    if (!fs.existsSync(logPath)) {
      // Try alternate paths
      const altPaths = ['/app/logs/combined.log', '/app/logs/app.log', '/app/logs/error.log'];
      let found = null;
      for (const alt of altPaths) {
        if (fs.existsSync(alt)) { found = alt; break; }
      }
      if (!found) {
        return { error: `Log file not found: ${logPath}`, hint: 'Available paths: /app/logs/combined.log, /app/logs/app.log' };
      }
    }

    const content = fs.readFileSync(logPath, 'utf8');
    const allLines = content.split('\n').filter(l => l.trim());
    const recentLines = allLines.slice(-lines);

    // Parse and categorize
    let errors = 0, warnings = 0, info = 0, debug = 0;
    const errorMessages = [];
    const warnMessages = [];

    for (const line of recentLines) {
      const lower = line.toLowerCase();
      if (lower.includes('error') || lower.includes('exception') || lower.includes('fail')) {
        errors++;
        if (errorMessages.length < 10) errorMessages.push(line.substring(0, 200));
      } else if (lower.includes('warn')) {
        warnings++;
        if (warnMessages.length < 5) warnMessages.push(line.substring(0, 200));
      } else if (lower.includes('debug')) {
        debug++;
      } else {
        info++;
      }
    }

    const stats = { total: recentLines.length, errors, warnings, info, debug };

    if (format === 'json') {
      return {
        success: true,
        format: 'json',
        output: JSON.stringify({
          logPath,
          analyzedLines: recentLines.length,
          stats,
          topErrors: errorMessages,
          topWarnings: warnMessages,
          timestamp: new Date().toISOString(),
        }, null, 2),
      };
    }

    // Markdown format
    let md = `# 📋 Log Analysis Report\n`;
    md += `**File:** ${logPath} | **Lines analyzed:** ${recentLines.length}\n`;
    md += `**Timestamp:** ${new Date().toISOString()}\n\n`;
    md += `## Summary\n`;
    md += `| Level | Count | % |\n|-------|-------|---|\n`;
    md += `| ❌ Errors | ${errors} | ${((errors/recentLines.length)*100).toFixed(1)}% |\n`;
    md += `| ⚠️ Warnings | ${warnings} | ${((warnings/recentLines.length)*100).toFixed(1)}% |\n`;
    md += `| ℹ️ Info | ${info} | ${((info/recentLines.length)*100).toFixed(1)}% |\n`;
    md += `| 🔍 Debug | ${debug} | ${((debug/recentLines.length)*100).toFixed(1)}% |\n\n`;

    if (errorMessages.length > 0) {
      md += `## Top Errors\n`;
      for (const msg of errorMessages) {
        md += `- \`${msg.replace(/\x1b\[\d+m/g, '').substring(0, 150)}\`\n`;
      }
      md += '\n';
    }

    if (warnMessages.length > 0) {
      md += `## Top Warnings\n`;
      for (const msg of warnMessages) {
        md += `- \`${msg.replace(/\x1b\[\d+m/g, '').substring(0, 150)}\`\n`;
      }
    }

    logger.info(`[logAnalyzerTools] analyze-logs: success (${stats.total} lines, ${errors} errors, ${warnings} warnings)`);
    return { success: true, format: 'md', output: md, stats };

  } catch (error) {
    logger.error(`[logAnalyzerTools] analyze-logs error: ${error.message}`);
    return { error: error.message };
  }
}

module.exports = {
  'analyze-logs': analyzeLogs,
};
