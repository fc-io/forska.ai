ALTER TABLE app.user_config ADD COLUMN IF NOT EXISTS full_text_conversion_model_id VARCHAR;

ALTER TABLE app.article ADD COLUMN IF NOT EXISTS full_text_conversion_model_id VARCHAR;

ALTER TABLE app.article ADD COLUMN IF NOT EXISTS full_text_conversion_metadata JSON;

CREATE TABLE app.full_text_conversion_model_user_config_validation (
  id VARCHAR PRIMARY KEY,
  model_id VARCHAR NOT NULL REFERENCES app.model(id)
);

INSERT INTO app.full_text_conversion_model_user_config_validation (id, model_id)
SELECT id, full_text_conversion_model_id
FROM app.user_config
WHERE full_text_conversion_model_id IS NOT NULL;

DROP TABLE app.full_text_conversion_model_user_config_validation;

CREATE TABLE app.full_text_conversion_model_article_validation (
  id VARCHAR PRIMARY KEY,
  model_id VARCHAR NOT NULL REFERENCES app.model(id)
);

INSERT INTO app.full_text_conversion_model_article_validation (id, model_id)
SELECT id, full_text_conversion_model_id
FROM app.article
WHERE full_text_conversion_model_id IS NOT NULL;

DROP TABLE app.full_text_conversion_model_article_validation;
