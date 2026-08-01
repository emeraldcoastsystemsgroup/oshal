-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Widen the per-user channel enum with 'voice': the welcome wizard's notifications step offers "call me", which needs a per-user voice channel (079 shipped email/sms/telegram/none only — voice existed solely at the operator env tier). The pair below is idempotent: DROP IF EXISTS + ADD re-runs cleanly on an already-widened DB. Constraint name is the auto-name Postgres gave 079's inline CHECK.

ALTER TABLE user_notification_prefs
  DROP CONSTRAINT IF EXISTS user_notification_prefs_channel_check;

ALTER TABLE user_notification_prefs
  ADD CONSTRAINT user_notification_prefs_channel_check
  CHECK (channel IN ('email','sms','voice','telegram','none'));
