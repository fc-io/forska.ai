ALTER TABLE app.article ADD COLUMN IF NOT EXISTS full_text_canonical_hash VARCHAR;

ALTER TABLE app.article ADD COLUMN IF NOT EXISTS full_text_canonical_version VARCHAR;

ALTER TABLE app.article ADD COLUMN IF NOT EXISTS full_text_figure_mode_built VARCHAR;
