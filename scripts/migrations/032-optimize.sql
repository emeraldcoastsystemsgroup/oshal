-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Model Optimize app
--   (native migration of the standalone ai-optimize :8799). Phase 1: per-user roster of
--   provider/model/harness "configs" to race a prompt across. Single-tenant now, the
--   tenant_id column is reserved everywhere a user is scoped (mirrors career-hunter) so
--   true multi-tenant is a config flip, not a migration. Provider keys are NOT stored here
--   — they reuse the per-user oshal_connections store (ADR-042), never an app secret file.
-- -----------------------------------------------------------------------------

-- One row per saved config in a user's race roster. (provider, model, harness) is unique
-- per user so re-saving the same row updates rather than duplicates. `label` is a friendly
-- name (e.g. "codex high"); `args` is an optional JSON array of extra CLI args (reasoning
-- effort, etc.); `enabled` lets a user keep a row but skip it in a race.
CREATE TABLE IF NOT EXISTS optimize_configs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   TEXT NOT NULL DEFAULT 'default',
    user_sub    TEXT NOT NULL,
    provider    TEXT NOT NULL,        -- registry provider id (anthropic, openai, gemini, …)
    model       TEXT NOT NULL,        -- provider model id
    harness     TEXT NOT NULL,        -- resolved harness (claude-code, codex-cli, gemini-cli, cline, …)
    label       TEXT,                 -- friendly display name
    args        TEXT,                 -- optional JSON array of extra CLI args
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, user_sub, provider, model, harness)
);
CREATE INDEX IF NOT EXISTS idx_optimize_configs_user ON optimize_configs(user_sub);
