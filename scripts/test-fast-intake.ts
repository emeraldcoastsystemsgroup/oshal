/**
 * Standalone test for FastIntakeService — run with:
 *   npx ts-node -r tsconfig-paths/register scripts/test-fast-intake.ts
 *
 * Tests the Codex CLI subprocess invocation for ticket extraction.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const INTAKE_MODEL = process.env.INTAKE_MODEL ?? 'gpt-4o-mini';
const INTAKE_TIMEOUT_MS = 60_000;

const EXTRACTION_PROMPT = `You are the OSHAL Quick Intake Bot. Your ONLY job is to extract work ticket fields from the user message below and output ONLY a JSON object. Do NOT use any tools, do NOT read any files, do NOT write any files. Just output JSON.

RULES:
- Extract: title, description, priority (low/medium/high)
- If the request is clear enough, set needsClarification to false
- Only set needsClarification to true if truly ambiguous
- Default priority to "medium" if not specified
- Keep title under 80 characters
- Output ONLY valid JSON

OUTPUT FORMAT:
{"title":"brief ticket title","description":"full description","priority":"medium","needsClarification":false,"clarificationQuestion":null}`;

function resolveClineBinary(): string {
  return process.env.CLINE_CLI_PATH || process.env.CLAUDE_CODE_CLI_PATH || 'cline';
}

function resolveConfigDir(): string {
  const configured = process.env.CLINE_CONFIG_DIR;
  if (configured && configured.trim().length > 0) return path.resolve(configured);
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (homeDir) return path.resolve(homeDir, '.cline');
  return path.resolve(process.cwd(), '.cline');
}

// ── Check if cline binary exists ──────────────────────────────────────────────

async function checkClineBinary(): Promise<boolean> {
  return new Promise((resolve) => {
    const binary = resolveClineBinary();
    const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], shell: true });
    let output = '';
    child.stdout.on('data', (d) => { output += d.toString(); });
    child.on('error', () => resolve(false));
    child.on('close', (code) => {
      if (code === 0 || output.trim().length > 0) {
        console.log(`  Cline version: ${output.trim()}`);
        resolve(true);
      } else {
        resolve(false);
      }
    });
    setTimeout(() => { child.kill(); resolve(false); }, 5000);
  });
}

// ── Run extraction via Codex CLI ──────────────────────────────────────────────

async function testExtraction(message: string): Promise<void> {
  console.log(`\n─── Testing extraction ───`);
  console.log(`Input: "${message}"`);
  console.log(`Model: ${INTAKE_MODEL}`);

  const binary = resolveClineBinary();
  const configDir = resolveConfigDir();
  const workspacePath = path.join(process.cwd(), 'workspace', `intake-test-${Date.now()}`);
  fs.mkdirSync(workspacePath, { recursive: true });

  const prompt = `${EXTRACTION_PROMPT}\n\nUser message: "${message}"`;
  const promptFile = path.join(workspacePath, '_intake_prompt.md');
  fs.writeFileSync(promptFile, prompt, 'utf-8');
  const args = ['--json', '-y', '--cwd', workspacePath, '--config', configDir, '--model', INTAKE_MODEL,
    'Read _intake_prompt.md then use attempt_completion with ONLY the raw JSON object as the result text. No explanation, no markdown, no extra text — just the JSON.'];

  const start = Date.now();

  try {
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn(binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CLINE_CONFIG_DIR: configDir },
        shell: true,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, INTAKE_TIMEOUT_MS);

      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn: ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        if (timedOut) {
          reject(new Error(`Timed out after ${INTAKE_TIMEOUT_MS}ms`));
          return;
        }
        if (code !== 0 && stdout.length === 0) {
          reject(new Error(`Exit code ${code}, stderr: ${stderr.slice(0, 200)}`));
          return;
        }
        resolve(stdout);
      });
    });

    const elapsed = Date.now() - start;
    console.log(`\nRaw output length: ${result.length} chars (${elapsed}ms)`);

    // Extract completion text from JSON lines
    let completionText = '';
    for (const line of result.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        if (event.type === 'completion_result' || event.event === 'completion_result' || (event as any).say === 'completion_result') {
          completionText = (event.result as string) || (event.text as string) || '';
          break;
        }
      } catch { /* skip */ }
    }

    if (!completionText) {
      console.log('  No completion_result found — showing last 500 chars of output:');
      console.log(result.slice(-500));
      return;
    }

    console.log(`\nCompletion text:`);
    console.log(completionText);

    // Try to parse JSON from completion
    const jsonMatch = completionText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log('\n✓ Parsed ticket:');
      console.log(JSON.stringify(parsed, null, 2));
      if (parsed.needsClarification) {
        console.log(`\n→ CLARIFICATION NEEDED: "${parsed.clarificationQuestion}"`);
      } else {
        console.log(`\n→ TICKET READY: "${parsed.title}" [${parsed.priority}]`);
      }
    } else {
      console.log('\n✗ No JSON found in completion text');
    }

    console.log(`\n⏱  Response time: ${elapsed}ms`);
  } catch (err) {
    const elapsed = Date.now() - start;
    console.error(`\n✗ Error (${elapsed}ms): ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Fast Intake Service — Standalone Test (Codex CLI) ===\n');

  const binary = resolveClineBinary();
  const configDir = resolveConfigDir();
  console.log(`Binary: ${binary}`);
  console.log(`Config: ${configDir}`);
  console.log(`Model: ${INTAKE_MODEL}`);

  console.log('\nChecking Cline CLI...');
  const clineOk = await checkClineBinary();
  if (!clineOk) {
    console.error('✗ Cline CLI not found or not responding.');
    console.error('  Install with: npm install -g @anthropic-ai/cline');
    console.error(`  Or set CLINE_CLI_PATH env var to the binary location.`);
    process.exit(1);
  }
  console.log('✓ Cline CLI is available\n');

  // Run just one test case to validate the flow
  await testExtraction('Fix the login page CSS on mobile');

  console.log('\n=== Test complete ===');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});