UPDATE mart.review_article_serving_payload_v4 AS payload
SET
  article_title = COALESCE(payload.article_title, serving.article_title),
  article_external_id = COALESCE(payload.article_external_id, serving.article_external_id),
  article_updated_at = COALESCE(payload.article_updated_at, serving.article_updated_at),
  arxiv_id = COALESCE(payload.arxiv_id, serving.arxiv_id),
  biorxiv_id = COALESCE(payload.biorxiv_id, serving.biorxiv_id),
  medrxiv_id = COALESCE(payload.medrxiv_id, serving.medrxiv_id),
  doi = COALESCE(payload.doi, serving.doi),
  pmid = COALESCE(payload.pmid, serving.pmid),
  journal_title = COALESCE(payload.journal_title, serving.journal_title),
  url = COALESCE(payload.url, serving.url),
  full_text_pdf = COALESCE(payload.full_text_pdf, serving.full_text_pdf),
  full_text_fetched_at = COALESCE(payload.full_text_fetched_at, serving.full_text_fetched_at),
  full_text_conversion_status = COALESCE(
    payload.full_text_conversion_status,
    serving.full_text_conversion_status
  ),
  payload_updated_at = current_timestamp
FROM (
  SELECT
    project_id,
    snapshot_id,
    article_id,
    any_value(article_title) AS article_title,
    any_value(article_external_id) AS article_external_id,
    any_value(article_updated_at) AS article_updated_at,
    any_value(arxiv_id) AS arxiv_id,
    any_value(biorxiv_id) AS biorxiv_id,
    any_value(medrxiv_id) AS medrxiv_id,
    any_value(doi) AS doi,
    any_value(pmid) AS pmid,
    any_value(journal_title) AS journal_title,
    any_value(url) AS url,
    any_value(full_text_pdf) AS full_text_pdf,
    any_value(full_text_fetched_at) AS full_text_fetched_at,
    any_value(full_text_conversion_status) AS full_text_conversion_status
  FROM mart.review_article_serving_v4
  GROUP BY project_id, snapshot_id, article_id
) serving
WHERE serving.project_id = payload.project_id
  AND serving.snapshot_id = payload.snapshot_id
  AND serving.article_id = payload.article_id
  AND (
    payload.article_title IS NULL
    OR payload.article_external_id IS NULL
    OR payload.article_updated_at IS NULL
    OR payload.arxiv_id IS NULL
    OR payload.biorxiv_id IS NULL
    OR payload.medrxiv_id IS NULL
    OR payload.doi IS NULL
    OR payload.pmid IS NULL
    OR payload.journal_title IS NULL
    OR payload.url IS NULL
    OR payload.full_text_pdf IS NULL
    OR payload.full_text_fetched_at IS NULL
    OR payload.full_text_conversion_status IS NULL
  );
