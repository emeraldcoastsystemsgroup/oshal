# Backlog: Bot UI DB Persistence (Option B)

**Priority:** Medium  
**Created:** 2026-04-19  
**Status:** Not started  

## Problem

Bot UI registrations currently use the dynamic tool path (Redis with TTL). This works but:
- UIs disappear if the bot restarts and the controller hasn't processed the re-registration yet
- The `ui` field on `CreateToolSchema` is commented out (`tool-schemas.ts:70`)
- The `tools` table has no `ui` column

## What to do

1. Add migration: `ALTER TABLE tools ADD COLUMN IF NOT EXISTS ui JSONB DEFAULT NULL;`
2. Uncomment `ui: ToolUiConfigSchema` in `tool-schemas.ts:70`
3. Update `ToolRepository` to read/write the `ui` column
4. Bots can then register persistent tools with UI config via the DB path
5. `GET /api/tools` returns `ui` field naturally — no dynamic merge needed
6. RibbonNav already handles it (filters `t.enabled && t.ui`)

## Why not now

The dynamic path (Option A) works today. The bot registers on startup, TTL keeps it alive, ribbon picks it up. Option B is a durability improvement, not a blocker.
