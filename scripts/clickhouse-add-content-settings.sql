-- ClickHouse Migration: Add Content Settings Columns
-- Run this script to add useTitle, useAbstract, useFulltext, useFulltextNoImages columns
-- to existing ClickHouse tables.
--
-- Default values match the legacy behavior where title + abstract was assumed.
--
-- Usage:
--   clickhouse-client --database forska < scripts/clickhouse-add-content-settings.sql
--
-- Or in Docker:
--   docker exec -i clickhouse clickhouse-client --database forska < scripts/clickhouse-add-content-settings.sql

-- ============================================================
-- 1. Add columns to main analytics table
-- ============================================================
ALTER TABLE forska.judgments ADD COLUMN IF NOT EXISTS useTitle Bool DEFAULT true;
ALTER TABLE forska.judgments ADD COLUMN IF NOT EXISTS useAbstract Bool DEFAULT true;
ALTER TABLE forska.judgments ADD COLUMN IF NOT EXISTS useFulltext Bool DEFAULT false;
ALTER TABLE forska.judgments ADD COLUMN IF NOT EXISTS useFulltextNoImages Bool DEFAULT false;

-- ============================================================
-- 2. Verify columns exist
-- ============================================================
SELECT 'Columns added successfully. Verifying schema...' AS status;

SELECT name, type, default_expression
FROM system.columns
WHERE table = 'judgments' AND database = 'forska' AND name LIKE 'use%'
ORDER BY name;
