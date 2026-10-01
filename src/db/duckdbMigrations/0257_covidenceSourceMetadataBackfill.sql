CREATE TEMP TABLE covidence_source_metadata_backfill AS
SELECT
  source_record.id AS source_record_id,
  source_record.article_id,
  source_record.import_route_id,
  source_record.source_record_key,
  source_record.created_at,
  TRY_CAST(COALESCE(
    NULLIF(regexp_extract(json_extract_string(source_record.raw_payload, '$.covidence.citation.year'), '\b\d{4}\b'), ''),
    NULLIF(regexp_extract(json_extract_string(source_record.raw_payload, '$.covidence.citation.publication_year'), '\b\d{4}\b'), ''),
    NULLIF(regexp_extract(json_extract_string(source_record.raw_payload, '$.covidence.citation.published_year'), '\b\d{4}\b'), ''),
    NULLIF(regexp_extract(json_extract_string(source_record.raw_payload, '$.covidence.citation.publication_date'), '\b\d{4}\b'), ''),
    NULLIF(regexp_extract(json_extract_string(source_record.raw_payload, '$.covidence.citation.date'), '\b\d{4}\b'), '')
  ) AS INTEGER) AS publication_year,
  COALESCE(
    NULLIF(trim(json_extract_string(source_record.raw_payload, '$.covidence.citation.published_month')), ''),
    NULLIF(trim(json_extract_string(source_record.raw_payload, '$.covidence.citation.publication_month')), ''),
    NULLIF(trim(json_extract_string(source_record.raw_payload, '$.covidence.citation.month')), '')
  ) AS publication_month,
  COALESCE(
    NULLIF(trim(json_extract_string(source_record.raw_payload, '$.covidence.citation.volume')), ''),
    NULLIF(trim(json_extract_string(source_record.raw_payload, '$.covidence.citation.vl')), '')
  ) AS volume,
  COALESCE(
    NULLIF(trim(json_extract_string(source_record.raw_payload, '$.covidence.citation.issue')), ''),
    NULLIF(trim(json_extract_string(source_record.raw_payload, '$.covidence.citation.is')), '')
  ) AS issue,
  NULLIF(trim(json_extract_string(source_record.raw_payload, '$.covidence.citation.pages')), '') AS pages,
  NULLIF(trim(json_extract_string(source_record.raw_payload, '$.covidence.citation.sp')), '') AS start_page,
  NULLIF(trim(json_extract_string(source_record.raw_payload, '$.covidence.citation.ep')), '') AS end_page,
  COALESCE(
    NULLIF(trim(json_extract_string(source_record.raw_payload, '$.covidence.citation.publication_type')), ''),
    NULLIF(trim(json_extract_string(source_record.raw_payload, '$.covidence.citation.reference_type')), '')
  ) AS publication_type,
  NULLIF(trim(json_extract_string(source_record.raw_payload, '$.covidence.citation.accession_number')), '') AS accession_number
FROM app.article_import_route_source_record source_record
INNER JOIN app.import_route import_route ON import_route.id = source_record.import_route_id
WHERE starts_with(import_route.route, 'covidence:')
  AND source_record.raw_payload IS NOT NULL;

CREATE TEMP TABLE covidence_source_metadata_backfill_value AS
SELECT
  source_record_id,
  article_id,
  import_route_id,
  source_record_key,
  created_at,
  publication_year,
  publication_month,
  volume,
  issue,
  COALESCE(
    pages,
    CASE
      WHEN start_page IS NOT NULL
        AND end_page IS NOT NULL
        AND end_page <> start_page
        AND NOT contains(start_page, '-')
        THEN start_page || '-' || end_page
      ELSE start_page
    END
  ) AS pages,
  publication_type,
  accession_number
FROM covidence_source_metadata_backfill;

CREATE TEMP MACRO covidence_source_metadata_backfill_patch(
  existing_metadata,
  publication_year,
  publication_month,
  volume,
  issue,
  pages,
  publication_type,
  accession_number
) AS '{' || concat_ws(
  ',',
  CASE
    WHEN json_extract_string(existing_metadata, '$.publicationYear') IS NULL AND publication_year IS NOT NULL
      THEN '"publicationYear":' || CAST(publication_year AS VARCHAR)
  END,
  CASE
    WHEN json_extract_string(existing_metadata, '$.publicationMonth') IS NULL AND publication_month IS NOT NULL
      THEN '"publicationMonth":' || CAST(to_json(publication_month) AS VARCHAR)
  END,
  CASE
    WHEN json_extract_string(existing_metadata, '$.volume') IS NULL AND volume IS NOT NULL
      THEN '"volume":' || CAST(to_json(volume) AS VARCHAR)
  END,
  CASE
    WHEN json_extract_string(existing_metadata, '$.issue') IS NULL AND issue IS NOT NULL
      THEN '"issue":' || CAST(to_json(issue) AS VARCHAR)
  END,
  CASE
    WHEN json_extract_string(existing_metadata, '$.pages') IS NULL AND pages IS NOT NULL
      THEN '"pages":' || CAST(to_json(pages) AS VARCHAR)
  END,
  CASE
    WHEN json_extract_string(existing_metadata, '$.publicationType') IS NULL AND publication_type IS NOT NULL
      THEN '"publicationType":' || CAST(to_json(publication_type) AS VARCHAR)
  END,
  CASE
    WHEN json_extract_string(existing_metadata, '$.accessionNumber') IS NULL AND accession_number IS NOT NULL
      THEN '"accessionNumber":' || CAST(to_json(accession_number) AS VARCHAR)
  END
) || '}';

UPDATE app.article_import_route_source_record
SET import_metadata = json_merge_patch(
  COALESCE(app.article_import_route_source_record.import_metadata, CAST('{}' AS JSON)),
  CAST(patch.patch_json AS JSON)
)
FROM (
  SELECT source_record.id, covidence_source_metadata_backfill_patch(
    source_record.import_metadata,
    backfill.publication_year,
    backfill.publication_month,
    backfill.volume,
    backfill.issue,
    backfill.pages,
    backfill.publication_type,
    backfill.accession_number
  ) AS patch_json
  FROM covidence_source_metadata_backfill_value backfill
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
  SELECT article_import_route.id, covidence_source_metadata_backfill_patch(
    article_import_route.import_metadata,
    backfill.publication_year,
    backfill.publication_month,
    backfill.volume,
    backfill.issue,
    backfill.pages,
    backfill.publication_type,
    backfill.accession_number
  ) AS patch_json
  FROM covidence_source_metadata_backfill_value backfill
  INNER JOIN app.article_import_route article_import_route
    ON article_import_route.import_route_id = backfill.import_route_id
    AND article_import_route.source_record_key = backfill.source_record_key
  WHERE article_import_route.import_metadata IS NULL OR json_type(article_import_route.import_metadata) = 'OBJECT'
) patch
WHERE app.article_import_route.id = patch.id
  AND patch.patch_json <> '{}';

UPDATE app.review_import_article_hot_field
SET publication_year = link_year.publication_year
FROM (
  SELECT
    article_import_route.import_route_id,
    article_import_route.article_id,
    article_import_route.source_record_key,
    TRY_CAST(json_extract_string(article_import_route.import_metadata, '$.publicationYear') AS INTEGER) AS publication_year
  FROM app.article_import_route article_import_route
  INNER JOIN app.import_route import_route ON import_route.id = article_import_route.import_route_id
  WHERE starts_with(import_route.route, 'covidence:')
    AND article_import_route.import_metadata IS NOT NULL
    AND json_type(article_import_route.import_metadata) = 'OBJECT'
) link_year
WHERE app.review_import_article_hot_field.import_route_id = link_year.import_route_id
  AND app.review_import_article_hot_field.article_id = link_year.article_id
  AND app.review_import_article_hot_field.source_record_key = link_year.source_record_key
  AND app.review_import_article_hot_field.publication_year IS NULL
  AND link_year.publication_year IS NOT NULL;

UPDATE app.article
SET source_metadata = json_merge_patch(
  COALESCE(app.article.source_metadata, CAST('{}' AS JSON)),
  CAST(patch.patch_json AS JSON)
)
FROM (
  SELECT article.id, covidence_source_metadata_backfill_patch(
    article.source_metadata,
    backfill.publication_year,
    backfill.publication_month,
    backfill.volume,
    backfill.issue,
    backfill.pages,
    backfill.publication_type,
    backfill.accession_number
  ) AS patch_json
  FROM (
    SELECT
      *,
      ROW_NUMBER() OVER (PARTITION BY article_id ORDER BY created_at ASC, source_record_id ASC) AS article_rank
    FROM covidence_source_metadata_backfill_value
  ) backfill
  INNER JOIN app.article article ON article.id = backfill.article_id
  WHERE backfill.article_rank = 1
    AND (article.source_metadata IS NULL OR json_type(article.source_metadata) = 'OBJECT')
) patch
WHERE app.article.id = patch.id
  AND patch.patch_json <> '{}';

DROP MACRO covidence_source_metadata_backfill_patch;

DROP TABLE covidence_source_metadata_backfill_value;

DROP TABLE covidence_source_metadata_backfill;
