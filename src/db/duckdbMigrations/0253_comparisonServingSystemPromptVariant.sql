CREATE TABLE IF NOT EXISTS mart.comparison_system_prompt_variant_serving (
  comparison_project_id VARCHAR NOT NULL,
  generation BIGINT NOT NULL,
  system_prompt_variant VARCHAR NOT NULL DEFAULT 'legacy',
  variant_updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);
