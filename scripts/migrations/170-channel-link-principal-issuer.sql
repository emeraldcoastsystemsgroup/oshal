-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR                                    | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1   | maintainer@emeraldcoastsystemsgroup.com   | Chat-channel links record the linking user's VERIFIED principal issuer. An inbound Telegram/Discord/SMS/WhatsApp message has no session, and user-bound bot delegation refuses a subject without its issuer, so the issuer is captured from the signed-in session when the link code is minted (channel_link_codes.user_issuer) and copied onto the binding when the code is redeemed (channel_links.user_issuer). Existing rows stay NULL: a NULL-issuer link is refused at dispatch with a re-link instruction and is never given a guessed issuer. Mirrored by ChannelLinkService.ensureSchema for a box that has not applied this file.

-- ChannelLinkService creates both tables lazily on a box that has never linked a channel. Skip a
-- table that is absent rather than abort: the runtime DDL mirror adds the column when it creates it.
DO $$
BEGIN
  IF to_regclass('public.channel_links') IS NULL THEN
    RAISE NOTICE '170: channel_links absent - skipped (ChannelLinkService.ensureSchema adds user_issuer)';
  ELSE
    ALTER TABLE channel_links ADD COLUMN IF NOT EXISTS user_issuer TEXT;
  END IF;
  IF to_regclass('public.channel_link_codes') IS NULL THEN
    RAISE NOTICE '170: channel_link_codes absent - skipped (ChannelLinkService.ensureSchema adds user_issuer)';
  ELSE
    ALTER TABLE channel_link_codes ADD COLUMN IF NOT EXISTS user_issuer TEXT;
  END IF;
END $$;
