-- =============================================================================
-- Migration 084: Pumpkin prop platform tables (?app=pumpkin)
-- -----------------------------------------------------------------------------
-- DATE         | AUTHOR                                    | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Per-user SAVED look
--              | presets + last-used settings for the animated jack-o'-lantern
--              | Halloween prop. Built-in presets ship in code (src/features/pumpkin);
--              | only a user's OWN customized looks + their active preset/mode persist
--              | here, keyed by OIDC sub. Idempotent — mirrors ensurePumpkinSchema()
--              | in pumpkin-routes.ts. Ephemeral projector "rooms" are in-memory only
--              | (pairing-style volatility), so nothing device-facing is stored here.
-- =============================================================================

-- A user's saved custom looks. Built-in presets are code-defined and never stored;
-- this holds only looks the operator tweaked and saved from the control surface.
CREATE TABLE IF NOT EXISTS pumpkin_presets (
  user_sub   VARCHAR(255) NOT NULL,
  name       VARCHAR(64)  NOT NULL,
  config     JSONB        NOT NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_sub, name)
);

-- The user's last-used preset + mode, so the control surface and projector page
-- can restore the previous look without a query param. One row per user.
CREATE TABLE IF NOT EXISTS pumpkin_settings (
  user_sub      VARCHAR(255) PRIMARY KEY,
  active_preset VARCHAR(64)  NOT NULL DEFAULT 'inflatable',
  mode          VARCHAR(16)  NOT NULL DEFAULT 'mimic',
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
