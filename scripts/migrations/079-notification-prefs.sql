-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Notification preference center: per-user, per-topic routing over the existing transports (own-Gmail email / own-Twilio SMS / Telegram-when-token-lands / none). One row per (user_sub, topic); no row = default routing (email when the user has a Gmail-send connection, else none). Quiet hours are LOCAL America/Chicago hours enforced by the NotificationRouter, stored as plain 0-23 smallints. phone/telegram_chat_id are the per-user destinations the channel needs (mirrors career_digest_settings.notify_phone, 077).

CREATE TABLE IF NOT EXISTS user_notification_prefs (
  user_sub          VARCHAR(255) NOT NULL,                 -- OIDC subject: the self-scoped owner of the pref
  topic             VARCHAR(64)  NOT NULL,                 -- producer-defined topic key, e.g. 'career-digest'
  channel           VARCHAR(16)  NOT NULL DEFAULT 'email'
                    CHECK (channel IN ('email','sms','telegram','none')),
  enabled           BOOLEAN      NOT NULL DEFAULT TRUE,    -- FALSE = mute this topic without losing the saved routing
  quiet_hours_start SMALLINT     CHECK (quiet_hours_start BETWEEN 0 AND 23),  -- America/Chicago hour; NULL = no quiet window
  quiet_hours_end   SMALLINT     CHECK (quiet_hours_end   BETWEEN 0 AND 23),  -- window may wrap midnight (start > end)
  phone             TEXT,                                  -- E.164 destination for the sms channel (user's own cell)
  telegram_chat_id  TEXT,                                  -- per-user Telegram chat id (usable once TELEGRAM_BOT_TOKEN lands)
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_sub, topic)
);
