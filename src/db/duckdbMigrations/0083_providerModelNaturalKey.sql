CREATE TEMP TABLE provider_model_natural_key_model_reference AS
SELECT
  model.id AS model_id,
  CASE
    WHEN model.id IN (
      SELECT model_id
      FROM app.project
    )
      OR model.id IN (
        SELECT selected_model.model_id
        FROM app.comparison_project
        CROSS JOIN UNNEST(model_ids) AS selected_model(model_id)
      )
    THEN 0
    ELSE 1
  END AS project_reference_rank,
  CASE
    WHEN model.id IN (
      SELECT full_text_conversion_model_id
      FROM app.user_config
      WHERE full_text_conversion_model_id IS NOT NULL
    )
      OR model.id IN (
        SELECT full_text_conversion_model_id
        FROM app.article
        WHERE full_text_conversion_model_id IS NOT NULL
      )
    THEN 0
    ELSE 1
  END AS conversion_reference_rank,
  CASE
    WHEN model.id IN (
      SELECT model_id
      FROM app.judgment
    )
      OR model.id IN (
        SELECT model_id
        FROM app.judgment_execution_snapshot
      )
      OR model.id IN (
        SELECT model_id
        FROM app.judgment_job_sqlite_outbox_import
        WHERE model_id IS NOT NULL
      )
      OR model.id IN (
        SELECT model_id
        FROM mart.judgment_fact
      )
      OR model.id IN (
        SELECT model_id
        FROM mart.prompt_answer_fact
      )
      OR model.id IN (
        SELECT model_id
        FROM mart.review_article_serving_detail
      )
      OR model.id IN (
        SELECT model_id
        FROM mart.comparison_cell_serving
        WHERE model_id IS NOT NULL
      )
    THEN 0
    ELSE 1
  END AS judgment_reference_rank,
  CASE
    WHEN COALESCE(model.enabled, TRUE) = FALSE OR model.metadata_json IS NOT NULL THEN 0
    ELSE 1
  END AS configured_rank
FROM app.model model;

CREATE TEMP TABLE provider_model_natural_key_model_map AS
WITH ranked_model AS (
  SELECT
    model.id,
    FIRST_VALUE(model.id) OVER (
      PARTITION BY model.provider_connection_id, model.remote_model_id, COALESCE(model.variant, '')
      ORDER BY
        model_reference.project_reference_rank ASC,
        model_reference.conversion_reference_rank ASC,
        model_reference.judgment_reference_rank ASC,
        model_reference.configured_rank ASC,
        model.created_at ASC,
        model.id ASC
    ) AS canonical_model_id
  FROM app.model model
  INNER JOIN provider_model_natural_key_model_reference model_reference ON model_reference.model_id = model.id
  WHERE model.remote_model_id IS NOT NULL
)
SELECT
  id AS duplicate_model_id,
  canonical_model_id
FROM ranked_model
WHERE id <> canonical_model_id;

CREATE TEMP TABLE provider_model_natural_key_judgment_map AS
WITH judgment_target AS (
  SELECT
    j.id,
    j.model_id,
    COALESCE(model_map.canonical_model_id, j.model_id) AS canonical_model_id,
    j.article_id,
    j.prompt_id,
    j.use_title,
    j.use_abstract,
    j.use_fulltext,
    j.use_fulltext_no_images,
    j.delete_generation,
    j.created_at
  FROM app.judgment j
  LEFT JOIN provider_model_natural_key_model_map model_map ON model_map.duplicate_model_id = j.model_id
  WHERE model_map.duplicate_model_id IS NOT NULL
    OR j.model_id IN (
      SELECT canonical_model_id
      FROM provider_model_natural_key_model_map
    )
),
ranked_judgment AS (
  SELECT
    id,
    FIRST_VALUE(id) OVER (
      PARTITION BY
        article_id,
        prompt_id,
        canonical_model_id,
        use_title,
        use_abstract,
        use_fulltext,
        use_fulltext_no_images,
        delete_generation
      ORDER BY
        CASE WHEN model_id = canonical_model_id THEN 0 ELSE 1 END ASC,
        created_at ASC,
        id ASC
    ) AS canonical_judgment_id
  FROM judgment_target
)
SELECT
  id AS duplicate_judgment_id,
  canonical_judgment_id
FROM ranked_judgment
WHERE id <> canonical_judgment_id;

CREATE TEMP TABLE provider_model_natural_key_judgment_assessment_target AS
WITH affected_judgment AS (
  SELECT
    canonical_judgment_id AS judgment_id,
    canonical_judgment_id AS target_judgment_id
  FROM provider_model_natural_key_judgment_map
  UNION
  SELECT
    duplicate_judgment_id AS judgment_id,
    canonical_judgment_id AS target_judgment_id
  FROM provider_model_natural_key_judgment_map
),
ranked_assessment AS (
  SELECT
    assessment.id AS assessment_id,
    assessment.judgment_id,
    affected_judgment.target_judgment_id,
    ROW_NUMBER() OVER (
      PARTITION BY affected_judgment.target_judgment_id
      ORDER BY
        CASE WHEN assessment.judgment_id = affected_judgment.target_judgment_id THEN 0 ELSE 1 END ASC,
        assessment.created_at ASC,
        assessment.id ASC
    ) AS target_rank
  FROM app.judgment_assessment assessment
  INNER JOIN affected_judgment ON affected_judgment.judgment_id = assessment.judgment_id
)
SELECT
  assessment_id,
  judgment_id,
  target_judgment_id,
  target_rank
FROM ranked_assessment;

CREATE TEMP TABLE provider_model_natural_key_comparison_project_serving_target AS
SELECT DISTINCT id AS comparison_project_id
FROM app.comparison_project
WHERE EXISTS (
  SELECT 1
  FROM UNNEST(model_ids) AS selected_model(model_id)
  WHERE selected_model.model_id IN (
    SELECT duplicate_model_id
    FROM provider_model_natural_key_model_map
  )
)
UNION
SELECT DISTINCT comparison_project_id
FROM mart.comparison_cell_serving
WHERE model_id IN (
  SELECT duplicate_model_id
  FROM provider_model_natural_key_model_map
);

DELETE FROM app.judgment_assessment
WHERE id IN (
  SELECT assessment_id
  FROM provider_model_natural_key_judgment_assessment_target
  WHERE target_rank > 1
);

UPDATE app.judgment_assessment
SET
  judgment_id = (
    SELECT target_judgment_id
    FROM provider_model_natural_key_judgment_assessment_target assessment_target
    WHERE assessment_target.assessment_id = app.judgment_assessment.id
  ),
  updated_at = current_timestamp
WHERE id IN (
  SELECT assessment_id
  FROM provider_model_natural_key_judgment_assessment_target
  WHERE target_rank = 1
    AND judgment_id <> target_judgment_id
);

CREATE TEMP TABLE provider_model_natural_key_updated_judgment_assessment_backup AS
SELECT *
FROM app.judgment_assessment
WHERE judgment_id IN (
  SELECT id
  FROM app.judgment
  WHERE model_id IN (
    SELECT duplicate_model_id
    FROM provider_model_natural_key_model_map
  )
    AND id NOT IN (
      SELECT duplicate_judgment_id
      FROM provider_model_natural_key_judgment_map
    )
);

DELETE FROM app.judgment_assessment
WHERE id IN (
  SELECT id
  FROM provider_model_natural_key_updated_judgment_assessment_backup
);

DELETE FROM mart.prompt_answer_fact
WHERE judgment_id IN (
  SELECT duplicate_judgment_id
  FROM provider_model_natural_key_judgment_map
);

DELETE FROM mart.review_article_serving_detail
WHERE judgment_id IN (
  SELECT duplicate_judgment_id
  FROM provider_model_natural_key_judgment_map
);

DELETE FROM mart.judgment_fact
WHERE judgment_id IN (
  SELECT duplicate_judgment_id
  FROM provider_model_natural_key_judgment_map
);

DELETE FROM app.judgment
WHERE id IN (
  SELECT duplicate_judgment_id
  FROM provider_model_natural_key_judgment_map
);

UPDATE app.project
SET
  model_id = (
    SELECT canonical_model_id
    FROM provider_model_natural_key_model_map model_map
    WHERE model_map.duplicate_model_id = app.project.model_id
  ),
  updated_at = current_timestamp
WHERE model_id IN (
  SELECT duplicate_model_id
  FROM provider_model_natural_key_model_map
);

UPDATE app.user_config
SET
  full_text_conversion_model_id = (
    SELECT canonical_model_id
    FROM provider_model_natural_key_model_map model_map
    WHERE model_map.duplicate_model_id = app.user_config.full_text_conversion_model_id
  ),
  updated_at = current_timestamp
WHERE full_text_conversion_model_id IN (
  SELECT duplicate_model_id
  FROM provider_model_natural_key_model_map
);

UPDATE app.article
SET
  full_text_conversion_model_id = (
    SELECT canonical_model_id
    FROM provider_model_natural_key_model_map model_map
    WHERE model_map.duplicate_model_id = app.article.full_text_conversion_model_id
  ),
  updated_at = current_timestamp
WHERE full_text_conversion_model_id IN (
  SELECT duplicate_model_id
  FROM provider_model_natural_key_model_map
);

UPDATE app.comparison_project
SET
  model_ids = (
    SELECT list(mapped_model_id ORDER BY first_ordinal)
    FROM (
      SELECT
        COALESCE(
          (
            SELECT canonical_model_id
            FROM provider_model_natural_key_model_map model_map
            WHERE model_map.duplicate_model_id = selected_model.model_id
          ),
          selected_model.model_id
        ) AS mapped_model_id,
        MIN(selected_model.ordinal) AS first_ordinal
      FROM UNNEST(model_ids) WITH ORDINALITY AS selected_model(model_id, ordinal)
      GROUP BY mapped_model_id
    )
  ),
  updated_at = current_timestamp
WHERE EXISTS (
  SELECT 1
  FROM UNNEST(model_ids) AS selected_model(model_id)
  WHERE selected_model.model_id IN (
    SELECT duplicate_model_id
    FROM provider_model_natural_key_model_map
  )
);

UPDATE app.provider_connection
SET
  config_json = json_merge_patch(
    COALESCE(config_json, CAST('{}' AS JSON)),
    json_object(
      'disabledModelIds',
      (
        SELECT list(disabled_model_id ORDER BY first_ordinal)
        FROM (
          SELECT
            COALESCE(model_map.canonical_model_id, disabled_model.model_id) AS disabled_model_id,
            MIN(disabled_model.ordinal) AS first_ordinal
          FROM UNNEST(CAST(json_extract(config_json, '$.disabledModelIds') AS VARCHAR[])) WITH ORDINALITY AS disabled_model(model_id, ordinal)
          LEFT JOIN provider_model_natural_key_model_map model_map ON model_map.duplicate_model_id = disabled_model.model_id
          GROUP BY disabled_model_id
        )
      )
    )
  ),
  updated_at = current_timestamp
WHERE EXISTS (
  SELECT 1
  FROM UNNEST(CAST(json_extract(config_json, '$.disabledModelIds') AS VARCHAR[])) AS disabled_model(model_id)
  WHERE disabled_model.model_id IN (
    SELECT duplicate_model_id
    FROM provider_model_natural_key_model_map
  )
);

UPDATE app.comparison_project_serving_generation
SET
  active_generation = 0,
  serving_status = 'stale',
  serving_generation = NULL,
  serving_started_at = NULL,
  serving_completed_at = NULL,
  serving_failed_at = NULL,
  serving_error = NULL,
  serving_phase = NULL,
  serving_phase_started_at = NULL,
  serving_last_progressed_at = NULL,
  serving_staged_article_count = 0,
  serving_staged_cell_count = 0,
  serving_staged_filter_member_count = 0,
  serving_staged_filter_stats_count = 0,
  generation_updated_at = current_timestamp
WHERE comparison_project_id IN (
  SELECT comparison_project_id
  FROM provider_model_natural_key_comparison_project_serving_target
);

UPDATE app.judgment
SET
  model_id = (
    SELECT canonical_model_id
    FROM provider_model_natural_key_model_map model_map
    WHERE model_map.duplicate_model_id = app.judgment.model_id
  ),
  updated_at = current_timestamp
WHERE model_id IN (
  SELECT duplicate_model_id
  FROM provider_model_natural_key_model_map
);

INSERT INTO app.judgment_assessment BY NAME
SELECT *
FROM provider_model_natural_key_updated_judgment_assessment_backup;

UPDATE app.judgment_execution_snapshot
SET model_id = (
  SELECT canonical_model_id
  FROM provider_model_natural_key_model_map model_map
  WHERE model_map.duplicate_model_id = app.judgment_execution_snapshot.model_id
)
WHERE model_id IN (
  SELECT duplicate_model_id
  FROM provider_model_natural_key_model_map
);

UPDATE app.judgment_job_sqlite_outbox_import
SET
  judgment_id = (
    SELECT canonical_judgment_id
    FROM provider_model_natural_key_judgment_map judgment_map
    WHERE judgment_map.duplicate_judgment_id = app.judgment_job_sqlite_outbox_import.judgment_id
  ),
  updated_at = current_timestamp
WHERE judgment_id IN (
  SELECT duplicate_judgment_id
  FROM provider_model_natural_key_judgment_map
);

UPDATE app.judgment_job_sqlite_outbox_import
SET
  model_id = (
    SELECT canonical_model_id
    FROM provider_model_natural_key_model_map model_map
    WHERE model_map.duplicate_model_id = app.judgment_job_sqlite_outbox_import.model_id
  ),
  updated_at = current_timestamp
WHERE model_id IN (
  SELECT duplicate_model_id
  FROM provider_model_natural_key_model_map
);

UPDATE mart.judgment_fact
SET model_id = (
  SELECT canonical_model_id
  FROM provider_model_natural_key_model_map model_map
  WHERE model_map.duplicate_model_id = mart.judgment_fact.model_id
)
WHERE model_id IN (
  SELECT duplicate_model_id
  FROM provider_model_natural_key_model_map
);

UPDATE mart.prompt_answer_fact
SET model_id = (
  SELECT canonical_model_id
  FROM provider_model_natural_key_model_map model_map
  WHERE model_map.duplicate_model_id = mart.prompt_answer_fact.model_id
)
WHERE model_id IN (
  SELECT duplicate_model_id
  FROM provider_model_natural_key_model_map
);

UPDATE mart.review_article_serving_detail
SET model_id = (
  SELECT canonical_model_id
  FROM provider_model_natural_key_model_map model_map
  WHERE model_map.duplicate_model_id = mart.review_article_serving_detail.model_id
)
WHERE model_id IN (
  SELECT duplicate_model_id
  FROM provider_model_natural_key_model_map
);

UPDATE mart.comparison_cell_serving
SET model_id = (
  SELECT canonical_model_id
  FROM provider_model_natural_key_model_map model_map
  WHERE model_map.duplicate_model_id = mart.comparison_cell_serving.model_id
)
WHERE model_id IN (
  SELECT duplicate_model_id
  FROM provider_model_natural_key_model_map
);

DELETE FROM app.model
WHERE id IN (
  SELECT duplicate_model_id
  FROM provider_model_natural_key_model_map
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_model_provider_remote_variant_unique
ON app.model(provider_connection_id, remote_model_id, COALESCE(variant, ''));

DROP TABLE provider_model_natural_key_updated_judgment_assessment_backup;
DROP TABLE provider_model_natural_key_comparison_project_serving_target;
DROP TABLE provider_model_natural_key_judgment_assessment_target;
DROP TABLE provider_model_natural_key_judgment_map;
DROP TABLE provider_model_natural_key_model_map;
DROP TABLE provider_model_natural_key_model_reference;
