/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — set LOG_LEVEL=silent (unless already set) so a CLI gate's own output isn't buried under the app logger's INFO lines. Import this FIRST, before any module that creates a logger.
 */

// The app logger (src/shared/logger) reads process.env.LOG_LEVEL when its logger is first created —
// which happens at import time for modules with a module-level `createChildLogger(...)`. Setting it
// here, in a module imported before those, makes a gate script quiet by default without depending on
// the shell being able to pass an inline env var. An explicit LOG_LEVEL always wins.
if (!process.env.LOG_LEVEL) {
  process.env.LOG_LEVEL = 'silent';
}
