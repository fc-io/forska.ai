UPDATE mart.review_article_judgment_detail_serving_v4
SET answered_original_as_array = NULL
WHERE payload_kind = 'human'
  AND answered_original_as_array IS NOT NULL;
