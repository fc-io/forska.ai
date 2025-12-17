-- Migration: Fix B-tree index size issue for judgments.answered_original
--
-- Problem: The answered_original column can contain large text values that exceed
-- PostgreSQL's B-tree maximum row size (~2704 bytes). This causes errors during
-- bulk inserts/updates like database merges.
--
-- Solution: Replace the full-column indexes with expression indexes that use
-- LEFT(answered_original, 100) to limit the indexed portion.

-- Drop the existing problematic indexes
DROP INDEX IF EXISTS public.judgments_article_prompt_answered_idx;
DROP INDEX IF EXISTS public.judgments_prompt_article_answered_idx;
DROP INDEX IF EXISTS public.judgments_prompt_article_covering_idx;

-- Recreate with expression-based prefixes to avoid size issues
-- Note: These use LEFT(answered_original, 100) which is sufficient for most
-- query optimizations while staying well under the B-tree size limit
CREATE INDEX IF NOT EXISTS judgments_article_prompt_answered_idx
  ON public.judgments (article_id, prompt_id, (LEFT(answered_original, 100)));

CREATE INDEX IF NOT EXISTS judgments_prompt_article_answered_idx
  ON public.judgments (prompt_id, article_id, (LEFT(answered_original, 100)));

CREATE INDEX IF NOT EXISTS judgments_prompt_article_covering_idx
  ON public.judgments (prompt_id, article_id, (LEFT(answered_original, 100)));
