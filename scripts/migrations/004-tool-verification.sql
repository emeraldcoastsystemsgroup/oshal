/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block
 */

-- Migration 004: Tool Verification Results
-- Adds table for storing tool installation verification results
-- Author: maintainer@emeraldcoastsystemsgroup.com
-- Date: 2026-03-09

-- Tool verification results table
CREATE TABLE IF NOT EXISTS tool_verification_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tool_id UUID NOT NULL REFERENCES tools(tool_id) ON DELETE CASCADE,
    tool_name VARCHAR(100) NOT NULL,
    verify_command TEXT,
    status VARCHAR(20) NOT NULL CHECK (status IN ('passed', 'failed', 'error', 'skipped', 'pending')),
    exit_code INTEGER,
    stdout TEXT,
    stderr TEXT,
    duration_ms INTEGER,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    verified_by VARCHAR(100) DEFAULT 'system',
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookups by tool
CREATE INDEX IF NOT EXISTS idx_verification_tool_id ON tool_verification_results(tool_id);

-- Index for latest verification per tool
CREATE INDEX IF NOT EXISTS idx_verification_verified_at ON tool_verification_results(verified_at DESC);

-- Index for status filtering
CREATE INDEX IF NOT EXISTS idx_verification_status ON tool_verification_results(status);

-- Composite index for latest result per tool
CREATE INDEX IF NOT EXISTS idx_verification_tool_latest ON tool_verification_results(tool_id, verified_at DESC);

-- Add last_verified_at column to tools table for quick status lookup
ALTER TABLE tools ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ;
ALTER TABLE tools ADD COLUMN IF NOT EXISTS last_verification_status VARCHAR(20);