-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Security Center
--   (ADR-055). A swarm app that watches the platform's OWN security posture and runtime.
--   Two owner-scoped stores. SCANS records each run (what was checked, how long, how many
--   hits). FINDINGS is the canonical hit table across all four scopes — posture (committed
--   secrets, unauthenticated routes, vulnerable dependencies), runtime threats (anomalous
--   bot/tool/auth bursts), money anomalies (large/unjustified/mode-violating ledger rows),
--   and access/audit (cross-app access-control violations).
--
--   Findings dedup on (user_sub, fingerprint): re-running a scan refreshes last_seen and the
--   evidence in place rather than piling up duplicates, and PRESERVES an operator's triage
--   (a finding already marked 'ignored'/'resolved' is not silently reopened). The accountable
--   security-analyst bot's triage lands in assessment/assessed_at; ticket_id is set only when
--   a finding is escalated into the ticketing spine. No secrets or raw credential VALUES are
--   stored here — evidence keeps the location + a redacted preview, never the live secret.
-- -----------------------------------------------------------------------------

-- 1) SCANS — one row per scan run. A scan covers one or more "kinds" (the four scopes).
CREATE TABLE IF NOT EXISTS oshal_security_scans (
    scan_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_sub       TEXT NOT NULL,
    kinds          TEXT[] NOT NULL,          -- subset of {posture,runtime,ledger,audit}
    status         TEXT NOT NULL DEFAULT 'running',  -- 'running' | 'complete' | 'error'
    finding_count  INT NOT NULL DEFAULT 0,
    new_count      INT NOT NULL DEFAULT 0,   -- findings first seen on this run
    summary        JSONB,                    -- per-kind counts, scanner availability, errors
    error          TEXT,
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sec_scans_user ON oshal_security_scans (user_sub, started_at DESC);

-- 2) FINDINGS — the canonical hit table. One row per distinct issue (by fingerprint).
CREATE TABLE IF NOT EXISTS oshal_security_findings (
    finding_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_sub       TEXT NOT NULL,
    category       TEXT NOT NULL,            -- 'secret'|'route_auth'|'dependency'|'threat'|'ledger'|'audit'
    severity       TEXT NOT NULL,            -- 'critical'|'high'|'medium'|'low'|'info'
    title          TEXT NOT NULL,
    detail         TEXT NOT NULL DEFAULT '', -- human-readable explanation
    source         TEXT,                     -- file path / route / table / agent the hit came from
    evidence       JSONB,                    -- structured, REDACTED context (never the live secret value)
    fingerprint    TEXT NOT NULL,            -- stable dedup key (category + location + signature)
    status         TEXT NOT NULL DEFAULT 'open',  -- 'open'|'triaged'|'resolved'|'ignored'
    assessment     JSONB,                    -- the security-analyst bot's structured triage
    assessed_at    TIMESTAMPTZ,
    ticket_id      UUID,                     -- set when escalated into the ticketing spine
    first_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sec_findings_dedup ON oshal_security_findings (user_sub, fingerprint);
CREATE INDEX IF NOT EXISTS idx_sec_findings_user ON oshal_security_findings (user_sub, status, severity, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_sec_findings_cat ON oshal_security_findings (user_sub, category, last_seen DESC);
