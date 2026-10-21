CREATE TEMP TABLE covidence_source_url_backfill AS
SELECT
  source_record.id AS source_record_id,
  source_record.article_id,
  source_record.import_route_id,
  source_record.source_record_key,
  source_record.created_at,
  NULLIF(trim(json_extract_string(source_record.raw_payload, '$.covidence.citation.doi')), '') AS doi_value,
  NULLIF(trim(json_extract_string(source_record.raw_payload, '$.covidence.citation.url')), '') AS url_value
FROM app.article_import_route_source_record source_record
INNER JOIN app.import_route import_route ON import_route.id = source_record.import_route_id
WHERE starts_with(import_route.route, 'covidence:')
  AND source_record.raw_payload IS NOT NULL;

CREATE TEMP MACRO covidence_source_url_backfill_url(url_text) AS CASE
  WHEN regexp_matches(url_text, '^https?://', 'i')
    AND NOT regexp_matches(url_text, '^https?://(www\.)?(dx\.)?doi\.org([/?#:]|$)', 'i')
    THEN url_text
END;

CREATE TEMP TABLE covidence_source_url_backfill_value AS
SELECT
  source_record_id,
  article_id,
  import_route_id,
  source_record_key,
  created_at,
  COALESCE(
    covidence_source_url_backfill_url(doi_value),
    covidence_source_url_backfill_url(url_value)
  ) AS source_url
FROM covidence_source_url_backfill;

DELETE FROM covidence_source_url_backfill_value
WHERE source_url IS NULL;

CREATE TEMP MACRO covidence_source_url_backfill_patch(existing_metadata, source_url) AS CASE
  WHEN json_extract_string(existing_metadata, '$.sourceUrl') IS NULL
    THEN '{"sourceUrl":' || CAST(to_json(source_url) AS VARCHAR) || '}'
  ELSE '{}'
END;

UPDATE app.article_import_route_source_record
SET import_metadata = json_merge_patch(
  COALESCE(app.article_import_route_source_record.import_metadata, CAST('{}' AS JSON)),
  CAST(patch.patch_json AS JSON)
)
FROM (
  SELECT
    source_record.id,
    covidence_source_url_backfill_patch(source_record.import_metadata, backfill.source_url) AS patch_json
  FROM covidence_source_url_backfill_value backfill
  INNER JOIN app.article_import_route_source_record source_record ON source_record.id = backfill.source_record_id
  WHERE source_record.import_metadata IS NULL OR json_type(source_record.import_metadata) = 'OBJECT'
) patch
WHERE app.article_import_route_source_record.id = patch.id
  AND patch.patch_json <> '{}';

UPDATE app.article_import_route
SET import_metadata = json_merge_patch(
  COALESCE(app.article_import_route.import_metadata, CAST('{}' AS JSON)),
  CAST(patch.patch_json AS JSON)
)
FROM (
  SELECT
    article_import_route.id,
    covidence_source_url_backfill_patch(article_import_route.import_metadata, backfill.source_url) AS patch_json
  FROM covidence_source_url_backfill_value backfill
  INNER JOIN app.article_import_route article_import_route
    ON article_import_route.import_route_id = backfill.import_route_id
    AND article_import_route.source_record_key = backfill.source_record_key
  WHERE article_import_route.import_metadata IS NULL OR json_type(article_import_route.import_metadata) = 'OBJECT'
) patch
WHERE app.article_import_route.id = patch.id
  AND patch.patch_json <> '{}';

UPDATE app.article
SET source_metadata = json_merge_patch(
  COALESCE(app.article.source_metadata, CAST('{}' AS JSON)),
  CAST(patch.patch_json AS JSON)
)
FROM (
  SELECT
    article.id,
    covidence_source_url_backfill_patch(article.source_metadata, backfill.source_url) AS patch_json
  FROM (
    SELECT
      *,
      ROW_NUMBER() OVER (PARTITION BY article_id ORDER BY created_at ASC, source_record_id ASC) AS article_rank
    FROM covidence_source_url_backfill_value
  ) backfill
  INNER JOIN app.article article ON article.id = backfill.article_id
  WHERE backfill.article_rank = 1
    AND (article.source_metadata IS NULL OR json_type(article.source_metadata) = 'OBJECT')
) patch
WHERE app.article.id = patch.id
  AND patch.patch_json <> '{}';

DROP MACRO covidence_source_url_backfill_patch;

DROP MACRO covidence_source_url_backfill_url;

DROP TABLE covidence_source_url_backfill_value;

DROP TABLE covidence_source_url_backfill;
