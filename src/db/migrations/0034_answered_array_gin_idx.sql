-- Add GIN index to speed overlap queries on answered_original_as_array
-- Note: This migration complements query-time normalization that falls back to answered_original
-- for rows where answered_original_as_array is null.

CREATE INDEX IF NOT EXISTS "judgments_answered_original_as_array_gin_idx"
  ON "judgments" USING GIN ("answered_original_as_array");

