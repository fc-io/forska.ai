-- Migration to drop all materialized views and the mv_refresh_status table
-- These were introduced in 0040_materialized_views.sql but are no longer used

-- Drop materialized views (order doesn't matter for drops)
DROP MATERIALIZED VIEW IF EXISTS "mv_project_human_filter_options" CASCADE;
DROP MATERIALIZED VIEW IF EXISTS "mv_project_llm_filter_options" CASCADE;
DROP MATERIALIZED VIEW IF EXISTS "mv_article_human_assessment_status" CASCADE;
DROP MATERIALIZED VIEW IF EXISTS "mv_article_llm_assessment_status" CASCADE;
DROP MATERIALIZED VIEW IF EXISTS "mv_project_article_scope" CASCADE;

-- Drop the refresh status tracking table
DROP TABLE IF EXISTS "mv_refresh_status" CASCADE;
