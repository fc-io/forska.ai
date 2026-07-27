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

const isStateFilterGroup = (group: ReviewServingDynamicCountPostingFilterGroup) => {
  return ['duplicateFlag', 'conflictFlag', 'llmStatus', 'humanStatus', 'llmHasJudgment'].includes(group.filterKind)
}

const getStateFilterGroupPredicate = (group: ReviewServingDynamicCountPostingFilterGroup, alias = 'state') => {
  if (group.filterKind === 'duplicateFlag') {
    return group.filterValues.includes('true') ? `${alias}.duplicate_flag IS TRUE` : ''
  }

  if (group.filterKind === 'conflictFlag') {
    return group.filterValues.includes('true') ? `${alias}.conflict_flag IS TRUE` : ''
  }

  if (group.filterKind === 'llmStatus') {
    return `${alias}.llm_status IN (SELECT unnest(${getSqlLiteral(group.filterValues)}::VARCHAR[]))`
  }

  if (group.filterKind === 'humanStatus') {
    return `${alias}.human_status IN (SELECT unnest(${getSqlLiteral(group.filterValues)}::VARCHAR[]))`
  }

  if (group.filterKind === 'llmHasJudgment') {
    const includesTrue = group.filterValues.includes('true')
    const includesFalse = group.filterValues.includes('false')

    if (includesTrue && includesFalse) {
      return ''
    }

    return includesTrue ? `${alias}.llm_has_judgment IS TRUE` : `${alias}.llm_has_judgment IS NOT TRUE`
  }

  return ''
}

const getListModeMembershipPredicate = (stateAlias: string, listModeExpression: string) => {
  return `CASE ${listModeExpression}
        WHEN 'llm' THEN ${stateAlias}.has_llm_list_mode
        WHEN 'human' THEN ${stateAlias}.has_human_list_mode
        WHEN 'both' THEN ${stateAlias}.has_both_list_mode
        WHEN 'unassessed' THEN ${stateAlias}.has_unassessed_list_mode
        ELSE FALSE
      END IS TRUE`
}

const getPostingFilteredArticleIdsCte = (groups: readonly ReviewServingDynamicCountPostingFilterGroup[]) => {
  if (groups.length === 0) {
    return ''
  }

  const groupPredicates = groups.map((group) => {
    return `(${getPostingFilterGroupPredicate(group)})`
  })

  if (groups.length === 1) {
    return `,
posting_filtered_article_ids AS (
  SELECT DISTINCT posting_article.article_id
  FROM (
    SELECT posting.article_ids
    FROM mart.review_article_filter_posting_serving_v4 posting
    CROSS JOIN scoped
    WHERE posting.project_id = scoped.project_id
      AND posting.review_config_hash = scoped.review_config_hash
      AND posting.snapshot_id = scoped.snapshot_id
      AND posting.list_mode_key = scoped.list_mode_key
      AND (${groupPredicates.join('\n        OR ')})
  ) posting
  CROSS JOIN UNNEST(posting.article_ids) AS posting_article(article_id)
)`
  }

  const matchedGroupCases = groups.map((group, index) => {
    return `WHEN ${getPostingFilterGroupPredicate(group)} THEN ${index}`
  })
  const requiredGroupRows = groups.map((_group, index) => {
    return `(${index})`
  })

  return `,
matched_posting_rows AS (
  SELECT
    posting.article_ids,
    posting.filter_kind,
    posting.filter_value,
    CASE ${matchedGroupCases.join(' ')} END AS matched_group_index,
    SUM(array_length(posting.article_ids)) OVER (
      PARTITION BY CASE ${matchedGroupCases.join(' ')} END
    ) AS matched_group_article_id_count
  FROM mart.review_article_filter_posting_serving_v4 posting
  CROSS JOIN scoped
  WHERE posting.project_id = scoped.project_id
    AND posting.review_config_hash = scoped.review_config_hash
    AND posting.snapshot_id = scoped.snapshot_id
    AND posting.list_mode_key = scoped.list_mode_key
    AND (${groupPredicates.join('\n      OR ')})
),
posting_anchor_rows AS (
  SELECT anchor.article_ids, anchor.matched_group_index
  FROM matched_posting_rows anchor
  WHERE NOT EXISTS (
    SELECT 1
    FROM matched_posting_rows smaller_anchor_group
    WHERE smaller_anchor_group.matched_group_article_id_count < anchor.matched_group_article_id_count
      OR (
        smaller_anchor_group.matched_group_article_id_count = anchor.matched_group_article_id_count
        AND smaller_anchor_group.matched_group_index < anchor.matched_group_index
      )
  )
),
posting_anchor_group AS (
  SELECT DISTINCT matched_group_index
  FROM posting_anchor_rows
),
posting_candidate_article_groups AS (
  SELECT DISTINCT candidate_article.article_id, candidate.matched_group_index
  FROM matched_posting_rows candidate
  CROSS JOIN posting_anchor_group anchor_group
  CROSS JOIN UNNEST(candidate.article_ids) AS candidate_article(article_id)
  WHERE candidate.matched_group_index <> anchor_group.matched_group_index
),
posting_filtered_article_ids AS (
  SELECT DISTINCT anchor_article.article_id
  FROM posting_anchor_rows anchor
  CROSS JOIN UNNEST(anchor.article_ids) AS anchor_article(article_id)
  WHERE NOT EXISTS (
    SELECT 1
    FROM (VALUES ${requiredGroupRows.join(', ')}) AS required_posting_group(required_group_index)
    WHERE required_posting_group.required_group_index <> anchor.matched_group_index
      AND NOT EXISTS (
        SELECT 1
        FROM posting_candidate_article_groups candidate
        WHERE candidate.matched_group_index = required_posting_group.required_group_index
          AND candidate.article_id = anchor_article.article_id
      )
  )
)`
}

const getDirectServingStateJoinSql = (stateAlias = 'list_mode_state') => {
  return [
    `mart.review_article_serving_base_v4 serving`,
    `CROSS JOIN scoped`,
    `INNER JOIN mart.review_article_serving_list_mode_state_v4 ${stateAlias}`,
    `  ON ${stateAlias}.project_id = serving.project_id`,
    ` AND ${stateAlias}.project_id = scoped.project_id`,
    ` AND ${stateAlias}.review_config_hash = serving.review_config_hash`,
    ` AND ${stateAlias}.review_config_hash = scoped.review_config_hash`,
    ` AND ${stateAlias}.snapshot_id = serving.snapshot_id`,
    ` AND ${stateAlias}.snapshot_id = scoped.snapshot_id`,
    ` AND ${stateAlias}.article_id = serving.article_id`,
    ` AND ${getListModeMembershipPredicate(stateAlias, 'scoped.list_mode_key')}`,
  ].join('\n      ')
}

const getNormalizedSearchTokenPrefixes = (input: ReviewServingDynamicCountSqlInput) => {
  const tokenPrefixes = input.searchTokenPrefixes ?? []

  return [
    ...new Set(
      tokenPrefixes.filter((tokenPrefix) => {
        return tokenPrefix.length > 0
      }),
    ),
  ]
}

const getSearchFilteredArticleIdsCte = (input: ReviewServingDynamicCountSqlInput) => {
  const tokenPrefixes = getNormalizedSearchTokenPrefixes(input)
  const hasSearchCandidateArticleIds =
    (input.postingFilterGroups ?? []).some((group) => {
      return !isStateFilterGroup(group)
    }) || input.includeUnassessedQueue

  if (tokenPrefixes.length === 0) {
    return ''
  }

  if (!hasSearchCandidateArticleIds) {
    return `,
search_filtered_article_ids AS (
  SELECT search_article.article_id AS article_id
  FROM mart.review_title_search_serving_v4 search
  JOIN (SELECT unnest(${getSqlLiteral(tokenPrefixes)}::VARCHAR[]) AS token_prefix) search_prefix
    ON starts_with(search.token, search_prefix.token_prefix)
  CROSS JOIN scoped
  CROSS JOIN unnest(search.article_ids) AS search_article(article_id)
  WHERE search.project_id = scoped.project_id
    AND search.search_identity = ${getSqlLiteral(input.searchIdentity ?? '')}
    AND search.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity ?? '')}
    AND search.snapshot_id = scoped.snapshot_id
  GROUP BY search_article.article_id
  HAVING COUNT(DISTINCT search_prefix.token_prefix) = ${tokenPrefixes.length}
)`
  }

  return `,
expanded_search_article_ids AS (
  SELECT DISTINCT search_prefix.token_prefix, search_candidate_article.article_id AS article_id
  FROM search_candidate_article_ids search_candidate_article
  JOIN mart.review_title_search_serving_v4 search
    ON list_contains(search.article_ids, search_candidate_article.article_id)
  JOIN (SELECT unnest(${getSqlLiteral(tokenPrefixes)}::VARCHAR[]) AS token_prefix) search_prefix
    ON starts_with(search.token, search_prefix.token_prefix)
  CROSS JOIN scoped
  WHERE search.project_id = scoped.project_id
    AND search.search_identity = ${getSqlLiteral(input.searchIdentity ?? '')}
    AND search.project_scope_identity = ${getSqlLiteral(input.projectScopeIdentity ?? '')}
    AND search.snapshot_id = scoped.snapshot_id
),
search_filtered_article_ids AS (
  SELECT expanded_search_article_ids.article_id AS article_id
  FROM expanded_search_article_ids
  GROUP BY expanded_search_article_ids.article_id
  HAVING COUNT(DISTINCT expanded_search_article_ids.token_prefix) = ${tokenPrefixes.length}
)`
}

const getSearchCandidateArticleIdsCte = (input: ReviewServingDynamicCountSqlInput) => {
  if (getNormalizedSearchTokenPrefixes(input).length === 0) {
    return ''
  }

  const postingGroups = (input.postingFilterGroups ?? []).filter((group) => {
    return !isStateFilterGroup(group)
  })

  if (postingGroups.length === 0 && !input.includeUnassessedQueue) {
    return ''
  }

  return `,
search_candidate_article_ids AS (
  SELECT DISTINCT candidate.article_id
  FROM scoped_serving candidate
  ${
    postingGroups.length > 0
      ? 'JOIN posting_filtered_article_ids posting_filter_ids ON posting_filter_ids.article_id = candidate.article_id'
      : ''
  }
  ${
    input.includeUnassessedQueue
      ? 'JOIN unassessed_queue_article_ids queue_filter_ids ON queue_filter_ids.article_id = candidate.article_id'
      : ''
  }
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

const getFilteredJoinClauses = (input: ReviewServingDynamicCountSqlInput) => {
  const postingGroups = (input.postingFilterGroups ?? []).filter((group) => {
    return !isStateFilterGroup(group)
  })

  return [
    postingGroups.length > 0
      ? 'JOIN posting_filtered_article_ids posting_filter_ids ON posting_filter_ids.article_id = filtered_article_ids.article_id'
      : '',
    getNormalizedSearchTokenPrefixes(input).length > 0
      ? 'JOIN search_filtered_article_ids search_filter_ids ON search_filter_ids.article_id = filtered_article_ids.article_id'
      : '',
    input.includeUnassessedQueue
      ? 'JOIN unassessed_queue_article_ids queue_filter_ids ON queue_filter_ids.article_id = filtered_article_ids.article_id'
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

const canUsePostingOnlyDynamicCount = (
  input: ReviewServingDynamicCountSqlInput,
  postingGroups: readonly ReviewServingDynamicCountPostingFilterGroup[],
  stateGroups: readonly ReviewServingDynamicCountPostingFilterGroup[],
) => {
  return (
    postingGroups.length > 0
    && stateGroups.length === 0
    && getNormalizedSearchTokenPrefixes(input).length === 0
    && !input.includeUnassessedQueue
    && !input.requireLlmJudgment
    && (input.servingPredicates ?? []).filter(Boolean).length === 0
  )
}

const canUseStateOnlyDynamicCount = (
  input: ReviewServingDynamicCountSqlInput,
  postingGroups: readonly ReviewServingDynamicCountPostingFilterGroup[],
  stateGroups: readonly ReviewServingDynamicCountPostingFilterGroup[],
) => {
  return (
    postingGroups.length === 0
    && (stateGroups.length > 0 || Boolean(input.requireLlmJudgment))
    && getNormalizedSearchTokenPrefixes(input).length === 0
    && !input.includeUnassessedQueue
    && (input.servingPredicates ?? []).filter(Boolean).length === 0
  )
}

const getListModeStatePredicates = (
  input: ReviewServingDynamicCountSqlInput,
  stateGroups: readonly ReviewServingDynamicCountPostingFilterGroup[],
) => {
  return [
    ...stateGroups.map((group) => {
      return getStateFilterGroupPredicate(group, 'list_mode_state')
    }),
    input.requireLlmJudgment ? 'list_mode_state.llm_has_judgment IS TRUE' : '',
  ]
    .filter(Boolean)
    .map((predicate) => {
      return `AND ${predicate}`
    })
    .join('\n        ')
}

export const getReviewServingDynamicFilteredCountSql = (input: ReviewServingDynamicCountSqlInput) => {
  const postingGroups = (input.postingFilterGroups ?? []).filter((group) => {
    return !isStateFilterGroup(group)
  })
  const stateGroups = (input.postingFilterGroups ?? []).filter(isStateFilterGroup)

  if (canUsePostingOnlyDynamicCount(input, postingGroups, stateGroups)) {
    return `
    WITH scoped AS (
      SELECT
        ${getSqlLiteral(input.projectId)} AS project_id,
        ${getSqlLiteral(input.reviewConfigHash)} AS review_config_hash,
        ${getSqlLiteral(input.snapshotId)} AS snapshot_id,
        ${getSqlLiteral(input.listModeKey)} AS list_mode_key
    )${getPostingFilteredArticleIdsCte(postingGroups)}
    SELECT COUNT(DISTINCT filtered_article_ids.article_id) AS totalCount
    FROM posting_filtered_article_ids filtered_article_ids
  `
  }

  const statePredicates = getListModeStatePredicates(input, stateGroups)

  if (canUseStateOnlyDynamicCount(input, postingGroups, stateGroups)) {
    return `
    WITH scoped AS (
      SELECT
        ${getSqlLiteral(input.projectId)} AS project_id,
        ${getSqlLiteral(input.reviewConfigHash)} AS review_config_hash,
        ${getSqlLiteral(input.snapshotId)} AS snapshot_id,
        ${getSqlLiteral(input.listModeKey)} AS list_mode_key
    )
    SELECT COUNT(DISTINCT list_mode_state.article_id) AS totalCount
    FROM mart.review_article_serving_list_mode_state_v4 list_mode_state
    CROSS JOIN scoped
    WHERE list_mode_state.project_id = scoped.project_id
      AND list_mode_state.review_config_hash = scoped.review_config_hash
      AND list_mode_state.snapshot_id = scoped.snapshot_id
      AND ${getListModeMembershipPredicate('list_mode_state', 'scoped.list_mode_key')}
        ${statePredicates}
  `
  }

  const servingPredicates = input.servingPredicates?.filter(Boolean).join('\n') ?? ''
  const scopedServingCte = `
    scoped_serving AS (
      SELECT serving.article_id
      FROM ${getDirectServingStateJoinSql()}
      WHERE serving.project_id = scoped.project_id
        AND serving.review_config_hash = scoped.review_config_hash
        AND serving.snapshot_id = scoped.snapshot_id
        ${statePredicates}
        ${servingPredicates}
    )`

  return `
    WITH scoped AS (
      SELECT
        ${getSqlLiteral(input.projectId)} AS project_id,
        ${getSqlLiteral(input.reviewConfigHash)} AS review_config_hash,
        ${getSqlLiteral(input.snapshotId)} AS snapshot_id,
        ${getSqlLiteral(input.listModeKey)} AS list_mode_key
    ),${scopedServingCte}${getPostingFilteredArticleIdsCte(postingGroups)}${getUnassessedQueueArticleIdsCte(input)}${getSearchCandidateArticleIdsCte(input)}${getSearchFilteredArticleIdsCte(input)}
    SELECT COUNT(DISTINCT filtered_article_ids.article_id) AS totalCount
    FROM scoped_serving filtered_article_ids
    ${getFilteredJoinClauses(input)}
  `
}
