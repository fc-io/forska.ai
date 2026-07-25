import {getSqlLiteral} from '../services/appQueryHelpers.ts'

export type ReviewServingDynamicCountPostingFilterGroup = {filterKind: string; filterValues: readonly string[]}

export type ReviewServingDynamicCountSqlInput = {
  includeUnassessedQueue?: boolean
  listModeKey: string
  postingFilterGroups?: readonly ReviewServingDynamicCountPostingFilterGroup[]
  projectId: string
  projectScopeIdentity?: string | null
  reviewConfigHash: string
  requireLlmJudgment?: boolean
  searchIdentity?: string | null
  searchTokenPrefixes?: readonly string[]
  servingPredicates?: readonly string[]
  snapshotId: string
}

const getPostingFilterGroupPredicate = (group: ReviewServingDynamicCountPostingFilterGroup, alias = 'posting') => {
  return `${alias}.filter_kind = ${getSqlLiteral(group.filterKind)}
          AND ${alias}.filter_value IN (SELECT unnest(${getSqlLiteral(group.filterValues)}::VARCHAR[]))`
}

const getPostingFilteredArticleIdsCte = (groups: readonly ReviewServingDynamicCountPostingFilterGroup[]) => {
  if (groups.length === 0) {
    return ''
  }

  const groupPredicates = groups.map((group) => {
    return `(${getPostingFilterGroupPredicate(group)})`
  })
  const matchedGroupCases = groups.map((group, index) => {
    return `WHEN ${getPostingFilterGroupPredicate(group)} THEN ${index}`
  })

  return `,
posting_filtered_article_ids AS (
  SELECT posting.article_id
  FROM mart.review_article_filter_posting_serving_v4 posting
  CROSS JOIN scoped
  WHERE posting.project_id = scoped.project_id
    AND posting.review_config_hash = scoped.review_config_hash
    AND posting.snapshot_id = scoped.snapshot_id
    AND posting.list_mode_key = scoped.list_mode_key
    AND (${groupPredicates.join('\n      OR ')})
  GROUP BY posting.article_id
  HAVING COUNT(DISTINCT CASE ${matchedGroupCases.join(' ')} END) = ${groups.length}
)`
}

const getSearchFilteredArticleIdsCte = (input: ReviewServingDynamicCountSqlInput) => {
  const tokenPrefixes = input.searchTokenPrefixes ?? []

  if (tokenPrefixes.length === 0) {
    return ''
  }

  return `,
search_filtered_article_ids AS (
  SELECT search.article_id
  FROM mart.review_title_search_serving_v4 search
  CROSS JOIN scoped
  JOIN (SELECT unnest(${getSqlLiteral(tokenPrefixes)}::VARCHAR[]) AS token_prefix) search_prefix
    ON starts_with(search.token, search_prefix.token_prefix)
  WHERE search.project_id = scoped.project_id
    AND search.search_identity = ${getSqlLiteral(input.searchIdentity ?? '')}
    AND search.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity ?? '')}
    AND search.snapshot_id = scoped.snapshot_id
  GROUP BY search.article_id
  HAVING COUNT(DISTINCT search_prefix.token_prefix) = ${tokenPrefixes.length}
)`
}

const getUnassessedQueueArticleIdsCte = (input: ReviewServingDynamicCountSqlInput) => {
  return input.includeUnassessedQueue
    ? `,
unassessed_queue_article_ids AS (
  SELECT DISTINCT queue.article_id
  FROM mart.review_unassessed_queue_serving_v4 queue
  CROSS JOIN scoped
  WHERE queue.project_id = scoped.project_id
    AND queue.review_config_hash IS NOT DISTINCT FROM scoped.review_config_hash
    AND queue.snapshot_id = scoped.snapshot_id
    AND queue.queue_kind = 'unassessed'
)`
    : ''
}

const getLlmJudgedArticleIdsCte = (input: ReviewServingDynamicCountSqlInput) => {
  return input.requireLlmJudgment
    ? `,
llm_judged_article_ids AS (
  SELECT DISTINCT detail.article_id
  FROM mart.review_article_judgment_detail_serving_v4 detail
  CROSS JOIN scoped
  WHERE detail.project_id = scoped.project_id
    AND detail.review_config_hash = scoped.review_config_hash
    AND detail.snapshot_id = scoped.snapshot_id
    AND detail.list_mode_key = 'llm'
    AND detail.payload_kind = 'llm'
    AND detail.placeholder_kind IS NULL
    AND detail.is_answered IS TRUE
)`
    : ''
}

const getFilteredJoinClauses = (input: ReviewServingDynamicCountSqlInput) => {
  return [
    (input.postingFilterGroups ?? []).length > 0
      ? 'JOIN posting_filtered_article_ids posting_filter_ids ON posting_filter_ids.article_id = filtered_article_ids.article_id'
      : '',
    (input.searchTokenPrefixes ?? []).length > 0
      ? 'JOIN search_filtered_article_ids search_filter_ids ON search_filter_ids.article_id = filtered_article_ids.article_id'
      : '',
    input.includeUnassessedQueue
      ? 'JOIN unassessed_queue_article_ids queue_filter_ids ON queue_filter_ids.article_id = filtered_article_ids.article_id'
      : '',
    input.requireLlmJudgment
      ? 'JOIN llm_judged_article_ids llm_judgment_ids ON llm_judgment_ids.article_id = filtered_article_ids.article_id'
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export const getReviewServingDynamicFilteredCountSql = (input: ReviewServingDynamicCountSqlInput) => {
  const postingGroups = input.postingFilterGroups ?? []
  const servingPredicates = input.servingPredicates?.filter(Boolean).join('\n') ?? ''

  return `
    WITH scoped AS (
      SELECT
        ${getSqlLiteral(input.projectId)} AS project_id,
        ${getSqlLiteral(input.reviewConfigHash)} AS review_config_hash,
        ${getSqlLiteral(input.snapshotId)} AS snapshot_id,
        ${getSqlLiteral(input.listModeKey)} AS list_mode_key
    ),
    scoped_serving AS (
      SELECT serving.article_id
      FROM mart.review_article_serving_v4 serving
      CROSS JOIN scoped
      WHERE serving.project_id = scoped.project_id
        AND serving.review_config_hash = scoped.review_config_hash
        AND serving.snapshot_id = scoped.snapshot_id
        AND serving.list_mode_key = scoped.list_mode_key
        ${servingPredicates}
    )${getPostingFilteredArticleIdsCte(postingGroups)}${getSearchFilteredArticleIdsCte(input)}${getUnassessedQueueArticleIdsCte(input)}${getLlmJudgedArticleIdsCte(input)}
    SELECT COUNT(DISTINCT filtered_article_ids.article_id) AS totalCount
    FROM scoped_serving filtered_article_ids
    ${getFilteredJoinClauses(input)}
  `
}
