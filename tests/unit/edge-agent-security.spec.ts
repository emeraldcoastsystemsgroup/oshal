/**
 * Security regression checks for the privileged edge-agent cockpit. These source-level checks
 * intentionally avoid importing the module, which creates persistent edge-agent identity state
 * and pulls in live Redis/Postgres worker dependencies at module initialization.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'src/features/edge-agent/edge-agent-server.ts'),
  'utf8',
);

describe('edge-agent privileged cockpit hardening', () => {
  it('binds to loopback by default and fails closed for remote binding without a token', () => {
    expect(source).toContain("process.env.EDGE_AGENT_HOST ?? '127.0.0.1'");
    expect(source).toContain("app.listen(UI_PORT, UI_HOST");
    expect(source).toContain('EDGE_AGENT_TOKEN must be explicitly set when EDGE_AGENT_HOST is not loopback.');
  });

  it('authenticates the complete edge-agent API namespace', () => {
    expect(source).toContain("app.use('/api/edge-agent'");
    expect(source).toContain("req.header('x-edge-agent-token')");
    expect(source).toContain("return res.status(401)");
    expect(source).toContain('timingSafeEqual(actual, supplied)');
  });

  it('never accepts an MCP executable or its arguments from an HTTP request', () => {
    expect(source).toContain("if ('mcpCommand' in req.body || 'mcpArgs' in req.body)");
    expect(source).toContain('process.env.EDGE_AGENT_MCP_COMMAND');
    expect(source).not.toMatch(/new McpStdioClient\(\{ command: opts\./);
  });
});
