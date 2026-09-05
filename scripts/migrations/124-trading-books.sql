-- 124-trading-books.sql — ADR-134 multi-account trading books (PR1 foundation).
--
-- Mirrors the runtime self-heal rails (trading-accounts-store / trading-books-store /
-- trading-schema + the five side-stores) for FRESH installs and offline application. Every
-- statement is idempotent; the runtime rails converge to the identical shape (proven by
-- tests/unit/trading-books-schema.spec.ts).
--
-- ORDERING IS LOAD-BEARING (adversarial live-safety review): columns → mint books → INSTALL THE
-- FILL TRIGGER → backfill → indexes. Writers do not stop for a deploy window (reconcile fires
-- every 5 minutes even when the market is closed; un-redeployed store twins insert book-less rows
-- until their own docker-cp), so the BEFORE INSERT trigger must be armed BEFORE the backfill
-- sweep — an insert landing between a backfill-first UPDATE and a later trigger install would
-- stay NULL forever and silently escape the (user_sub, book_id, client_order_id) twin-order
-- arbiter (NULL never conflicts in a unique index).

-- ── 1. Discovered broker accounts ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oshal_trading_accounts (
  account_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_sub           TEXT NOT NULL,
  broker             TEXT NOT NULL CHECK (broker IN ('schwab','alpaca')),
  connection_key     TEXT NOT NULL DEFAULT 'default',
  account_number_enc TEXT NOT NULL,   -- DEK-encrypted (connector-token-crypto envelope): GLBA-class NPI;
                                      -- bot nodes connect as a SUPERUSER (RLS-exempt), so plaintext at
                                      -- rest is the bot-injection audit's escalation prize.
  account_digest     TEXT NOT NULL,   -- HMAC-SHA256(SESSION_SECRET, sub||':'||number) — deterministic identity.
  account_last4      TEXT NOT NULL,   -- display suffix; routes return masked forms ONLY.
  account_hash       TEXT,
  account_type       TEXT,
  nickname           TEXT,
  discovered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_accounts_identity   ON oshal_trading_accounts (user_sub, broker, account_digest);
-- Non-partial pair uniqueness so the books FK below can be COMPOSITE — the DB wall against binding
-- a book to another user's account (FK validation bypasses RLS on the referenced table).
CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_accounts_owner_pair ON oshal_trading_accounts (user_sub, account_id);
ALTER TABLE oshal_trading_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_trading_accounts FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'oshal_trading_accounts_owner_or_operator' AND polrelid = 'oshal_trading_accounts'::regclass) THEN
    CREATE POLICY oshal_trading_accounts_owner_or_operator ON oshal_trading_accounts
      AS PERMISSIVE FOR ALL
      USING (user_sub = current_setting('oshal.current_sub', true) OR current_setting('oshal.is_operator', true) = 'on')
      WITH CHECK (user_sub = current_setting('oshal.current_sub', true) OR current_setting('oshal.is_operator', true) = 'on');
  END IF;
END $$;

-- ── 2. Trading books ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oshal_trading_books (
  book_id         UUID PRIMARY KEY,     -- legacy books: md5('oshal-book:'||sub||':'||kind)::uuid
  user_sub        TEXT NOT NULL,
  ref             TEXT NOT NULL,        -- 'paper' | 'live' | 'b-xxxxxxxx' (rides requestId/decision_id text)
  label           TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('paper','live')),
  broker          TEXT CHECK (broker IN ('schwab','alpaca')),
  account_id      UUID,                 -- IMMUTABLE once the book has ledger/HWM rows (enforced in the core store)
  connection_key  TEXT,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  learn           BOOLEAN NOT NULL DEFAULT false,
  capital_cap_usd NUMERIC(18,2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (account_id IS NULL OR broker IS NOT NULL),
  FOREIGN KEY (user_sub, account_id) REFERENCES oshal_trading_accounts (user_sub, account_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_books_ref   ON oshal_trading_books (user_sub, ref);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_books_acct  ON oshal_trading_books (user_sub, account_id) WHERE account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_books_learn ON oshal_trading_books (user_sub) WHERE learn;
ALTER TABLE oshal_trading_books ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_trading_books FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'oshal_trading_books_owner_or_operator' AND polrelid = 'oshal_trading_books'::regclass) THEN
    CREATE POLICY oshal_trading_books_owner_or_operator ON oshal_trading_books
      AS PERMISSIVE FOR ALL
      USING (user_sub = current_setting('oshal.current_sub', true) OR current_setting('oshal.is_operator', true) = 'on')
      WITH CHECK (user_sub = current_setting('oshal.current_sub', true) OR current_setting('oshal.is_operator', true) = 'on');
  END IF;
END $$;

-- ── 3. The straggler-writer fill function (canonical copy lives in trading-books-store) ─────────
CREATE OR REPLACE FUNCTION oshal_trading_book_id_fill() RETURNS trigger AS $fn$
BEGIN
  IF NEW.book_id IS NULL AND NEW.user_sub IS NOT NULL AND NEW.mode IS NOT NULL THEN
    NEW.book_id := md5('oshal-book:' || NEW.user_sub || ':' || NEW.mode)::uuid;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

-- ── 4. Mint legacy books from every user the trading tables know (guarded per source table) ─────
DO $$
DECLARE src text;
BEGIN
  FOREACH src IN ARRAY ARRAY['oshal_trading_orders','oshal_trading_signals','oshal_trading_equity_hwm'] LOOP
    IF to_regclass(src) IS NOT NULL THEN
      EXECUTE format(
        'INSERT INTO oshal_trading_books (book_id, user_sub, ref, label, kind, learn, enabled)
         SELECT DISTINCT md5(''oshal-book:'' || user_sub || '':paper'')::uuid, user_sub,
                ''paper'', ''Paper (reference book)'', ''paper'', true, true
           FROM %I WHERE user_sub IS NOT NULL
         ON CONFLICT (book_id) DO NOTHING', src);
      EXECUTE format(
        'INSERT INTO oshal_trading_books (book_id, user_sub, ref, label, kind, learn, enabled)
         SELECT DISTINCT md5(''oshal-book:'' || user_sub || '':live'')::uuid, user_sub,
                ''live'', ''Live (legacy account)'', ''live'', false, true
           FROM %I WHERE user_sub IS NOT NULL AND mode = ''live''
         ON CONFLICT (book_id) DO NOTHING', src);
    END IF;
  END LOOP;
END $$;

-- ── 5. book_id re-key: column → trigger → backfill → indexes, per table ─────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'oshal_trading_signals','oshal_trading_decisions','oshal_trading_orders','oshal_trading_predictions',
    'oshal_trading_equity_hwm','oshal_trading_daily_equity','oshal_trading_peaks',
    'oshal_trading_rotation_state','oshal_trading_gate_blocks'
  ] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS book_id UUID', t);
      EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_book_fill ON %I', replace(t, 'oshal_trading_', 'trd_'), t);
      EXECUTE format('CREATE TRIGGER trg_%s_book_fill BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION oshal_trading_book_id_fill()',
                     replace(t, 'oshal_trading_', 'trd_'), t);
      EXECUTE format('UPDATE %I SET book_id = md5(''oshal-book:''||user_sub||'':''||mode)::uuid WHERE book_id IS NULL AND user_sub IS NOT NULL', t);
    END IF;
  END LOOP;
END $$;
-- daily_equity additionally denormalizes the ref for the raw-pool host report scripts (ADR-124:
-- they read as the enforcing role with no GUC — a join to the FORCE-RLS'd books table reads zero rows).
-- GUARDED (2026-09-05): the five side-store tables are RUNTIME-created by the trading feature.
-- A deployment that never ran trading (the gsquared CRM box) has none of them, and the bare
-- ALTER below killed its managed-postgres launcher gate — the whole stack refused to start.
DO $$
BEGIN
  IF to_regclass('oshal_trading_daily_equity') IS NOT NULL THEN
    ALTER TABLE oshal_trading_daily_equity ADD COLUMN IF NOT EXISTS book_ref TEXT;
    UPDATE oshal_trading_daily_equity SET book_ref = mode WHERE book_ref IS NULL;
  END IF;
END $$;

-- Book-scoped arbiters COEXIST with the legacy mode-scoped ones until the PR4 cutover (under the
-- flag-off bijection they always agree; a rolled-back image still finds its old ON CONFLICT targets).
DO $$
DECLARE t text; stmt text;
BEGIN
  FOR t, stmt IN SELECT * FROM (VALUES
    ('oshal_trading_signals',        'CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_signals_dedup_book ON oshal_trading_signals (user_sub, book_id, content_hash)'),
    ('oshal_trading_signals',        'CREATE INDEX IF NOT EXISTS idx_trd_signals_user_book ON oshal_trading_signals (user_sub, book_id, observed_at DESC)'),
    ('oshal_trading_decisions',      'CREATE INDEX IF NOT EXISTS idx_trd_decisions_user_book ON oshal_trading_decisions (user_sub, book_id, created_at DESC)'),
    ('oshal_trading_orders',         'CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_orders_client_book ON oshal_trading_orders (user_sub, book_id, client_order_id)'),
    ('oshal_trading_predictions',    'CREATE INDEX IF NOT EXISTS idx_trd_pred_open_book ON oshal_trading_predictions (book_id, created_at) WHERE resolved = false'),
    ('oshal_trading_equity_hwm',     'CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_hwm_book ON oshal_trading_equity_hwm (user_sub, book_id)'),
    ('oshal_trading_daily_equity',   'CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_daily_eq_book ON oshal_trading_daily_equity (user_sub, book_id, et_day)'),
    ('oshal_trading_peaks',          'CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_peaks_book ON oshal_trading_peaks (user_sub, book_id, symbol)'),
    ('oshal_trading_rotation_state', 'CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_rotation_book ON oshal_trading_rotation_state (user_sub, book_id)'),
    ('oshal_trading_gate_blocks',    'CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_gate_blocks_book ON oshal_trading_gate_blocks (user_sub, book_id, gate, symbol, et_day)')
  ) AS v(tbl, ddl) LOOP
    IF to_regclass(t) IS NOT NULL THEN EXECUTE stmt; END IF;
  END LOOP;
END $$;

-- gate_blocks gains the RLS it was missing by omission (schema-map finding). Guarded: the
-- table is runtime-created; on a trading-less box there is nothing to secure yet — the runtime
-- rail creates it WITH this policy when the feature first runs.
DO $$ BEGIN
  IF to_regclass('oshal_trading_gate_blocks') IS NULL THEN RETURN; END IF;
  ALTER TABLE oshal_trading_gate_blocks ENABLE ROW LEVEL SECURITY;
  ALTER TABLE oshal_trading_gate_blocks FORCE ROW LEVEL SECURITY;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'oshal_trading_gate_blocks_owner_or_operator' AND polrelid = to_regclass('oshal_trading_gate_blocks')) THEN
    CREATE POLICY oshal_trading_gate_blocks_owner_or_operator ON oshal_trading_gate_blocks
      AS PERMISSIVE FOR ALL
      USING (user_sub = current_setting('oshal.current_sub', true) OR current_setting('oshal.is_operator', true) = 'on')
      WITH CHECK (user_sub = current_setting('oshal.current_sub', true) OR current_setting('oshal.is_operator', true) = 'on');
  END IF;
END $$;
