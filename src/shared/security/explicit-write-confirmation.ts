/**
 * Explicit write confirmation guard.
 *
 * Real-world mutations must cross an API boundary with a positive user/action
 * signal. Browser prompts, bot prompts, and cron metadata are useful UX, but
 * the server still needs one small fail-closed check.
 */

export const CONFIRMATION_REQUIRED_ERROR = 'confirmation_required';

export function hasExplicitWriteConfirmation(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const value = (body as Record<string, unknown>).confirm;
  return value === true;
}

export function confirmationRequiredPayload(guard: string, action: string): Record<string, unknown> {
  return {
    error: CONFIRMATION_REQUIRED_ERROR,
    guard,
    message: `${action} requires confirm: true. No write was attempted.`,
  };
}
