export const reviewServingPromptAnswerFilterKind = 'promptAnswer'

export const reviewServingLazyPromptAnswerPostingDiagnostics = {
  cacheReadinessKey: 'reviewServing.lazyPromptAnswerPosting.v1',
  canonicalSource: 'app.judgment/app.judgment_human/app.judgment_human_summary',
  readiness: 'readThrough',
} as const

export type ReviewServingLazyPromptAnswerPostingDatabase = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run?: (statement: string) => Promise<void>
}

export type ReviewServingLazyPromptAnswerPostingEnsureResult = {
  diagnostics: typeof reviewServingLazyPromptAnswerPostingDiagnostics
  missingFilterValues: readonly string[]
  requestedFilterValues: readonly string[]
  status: 'cacheHit' | 'cacheWritten' | 'emptyRequest'
  writtenBucketCount: number
}

const inflightEnsurePromises = new Map<string, Promise<ReviewServingLazyPromptAnswerPostingEnsureResult>>()

export const isReviewServingPromptAnswerFilterGroup = (group: {filterKind: string}) => {
  return group.filterKind === reviewServingPromptAnswerFilterKind
}

export const hasReviewServingPromptAnswerFilterGroup = (groups: readonly {filterKind: string}[]) => {
  return groups.some(isReviewServingPromptAnswerFilterGroup)
}

export const getReviewServingLazyPromptAnswerPostingSourceSql = (input: {
  filterValuesSql?: string
  listModeSql: string
  projectIdSql: string
  reviewConfigHashSql: string
  snapshotIdSql: string
}) => {
  const filterValuePredicate = input.filterValuesSql
    ? `WHERE prompt_answer.filter_value IN (SELECT unnest(${input.filterValuesSql}::VARCHAR[]))`
    : ''

  return `
    SELECT
      ${input.projectIdSql} AS project_id,
      ${input.reviewConfigHashSql} AS review_config_hash,
      ${input.snapshotIdSql} AS snapshot_id,
      [prompt_answer.article_id]::VARCHAR[] AS article_ids,
      '${reviewServingPromptAnswerFilterKind}' AS filter_kind,
      prompt_answer.filter_value,
      prompt_answer.list_mode_key
    FROM (
      WITH project_settings AS (
        SELECT
          project.id AS project_id,
          project.model_id,
          project.use_title,
          project.use_abstract,
          project.use_fulltext,
          project.use_fulltext_no_images,
          COALESCE(project.human_judgment_mode, 'prompt') AS human_judgment_mode
        FROM app.project project
        WHERE project.id = ${input.projectIdSql}
      ),
      scoped_serving AS (
        SELECT
          list_mode_state.article_id,
          list_mode.list_mode_key
        FROM mart.review_article_serving_list_mode_state_v4 list_mode_state
        CROSS JOIN (SELECT ${input.listModeSql} AS list_mode_key) list_mode
        WHERE list_mode_state.project_id = ${input.projectIdSql}
          AND list_mode_state.review_config_hash = ${input.reviewConfigHashSql}
          AND list_mode_state.snapshot_id = ${input.snapshotIdSql}
          AND CASE list_mode.list_mode_key
            WHEN 'llm' THEN list_mode_state.has_llm_list_mode
            WHEN 'human' THEN list_mode_state.has_human_list_mode
            WHEN 'both' THEN list_mode_state.has_both_list_mode
            ELSE FALSE
          END IS TRUE
      ),
      active_prompt AS (
        SELECT project_prompt.prompt_id
        FROM app.project_prompt project_prompt
        INNER JOIN app.prompt prompt
          ON prompt.id = project_prompt.prompt_id
        WHERE project_prompt.project_id = ${input.projectIdSql}
          AND project_prompt.enabled
          AND NOT project_prompt.archived
          AND COALESCE(prompt.archived, FALSE) = FALSE
      ),
      latest_llm_judgment AS (
        SELECT *
        FROM (
          SELECT
            judgment.article_id,
            judgment.prompt_id,
            judgment.answered_original,
            judgment.answered_original_as_array,
            ROW_NUMBER() OVER (
              PARTITION BY judgment.article_id, judgment.prompt_id
              ORDER BY judgment.created_at DESC NULLS LAST, judgment.id DESC
            ) AS judgment_rank
          FROM app."judgment" judgment
          INNER JOIN scoped_serving serving
            ON serving.article_id = judgment.article_id
            AND serving.list_mode_key IN ('llm', 'both')
          INNER JOIN project_settings project
            ON project.model_id = judgment.model_id
            AND project.use_title = judgment.use_title
            AND project.use_abstract = judgment.use_abstract
            AND project.use_fulltext = judgment.use_fulltext
            AND project.use_fulltext_no_images = judgment.use_fulltext_no_images
          INNER JOIN active_prompt prompt
            ON prompt.prompt_id = judgment.prompt_id
          WHERE judgment.deleted_at IS NULL
        ) ranked_judgment
        WHERE ranked_judgment.judgment_rank = 1
      )
      SELECT
        llm.article_id,
        serving.list_mode_key,
        concat('review:promptAnswer:', llm.prompt_id, ':', llm.answered_original) AS filter_value
      FROM latest_llm_judgment llm
      INNER JOIN scoped_serving serving
        ON serving.article_id = llm.article_id
        AND serving.list_mode_key IN ('llm', 'both')
      WHERE llm.answered_original IS NOT NULL
        AND llm.answered_original_as_array IS NULL
      UNION ALL
      SELECT
        llm.article_id,
        serving.list_mode_key,
        concat('review:promptAnswer:', llm.prompt_id, ':', answer.answer_value) AS filter_value
      FROM latest_llm_judgment llm
      INNER JOIN scoped_serving serving
        ON serving.article_id = llm.article_id
        AND serving.list_mode_key IN ('llm', 'both')
      CROSS JOIN UNNEST(COALESCE(llm.answered_original_as_array, []::VARCHAR[])) AS answer(answer_value)
      WHERE llm.answered_original_as_array IS NOT NULL
        AND answer.answer_value IS NOT NULL
      UNION ALL
      SELECT
        judgment_human.article_id,
        serving.list_mode_key,
        concat('human:promptAnswer:', judgment_human.prompt_id, ':', judgment_human.answer) AS filter_value
      FROM app."judgment_human" judgment_human
      INNER JOIN scoped_serving serving
        ON serving.article_id = judgment_human.article_id
        AND serving.list_mode_key IN ('human', 'both')
      INNER JOIN project_settings project
        ON project.project_id IS NOT DISTINCT FROM judgment_human.project_id
        AND project.human_judgment_mode <> 'summary'
      INNER JOIN active_prompt prompt
        ON prompt.prompt_id = judgment_human.prompt_id
      WHERE judgment_human.answer IS NOT NULL
      UNION ALL
      SELECT
        judgment_human_summary.article_id,
        serving.list_mode_key,
        concat('human:promptAnswer:summary:', judgment_human_summary.answer) AS filter_value
      FROM app."judgment_human_summary" judgment_human_summary
      INNER JOIN scoped_serving serving
        ON serving.article_id = judgment_human_summary.article_id
        AND serving.list_mode_key IN ('human', 'both')
      INNER JOIN project_settings project
        ON project.project_id = judgment_human_summary.project_id
        AND project.human_judgment_mode = 'summary'
      WHERE judgment_human_summary.answer IS NOT NULL
    ) prompt_answer
    ${filterValuePredicate}
  `
}

export const getReviewServingPromptAnswerPostingMissingValuesSql = (input: {
  filterValuesSql: string
  listModeSql: string
  projectIdSql: string
  reviewConfigHashSql: string
  snapshotIdSql: string
}) => {
  return `
    SELECT requested.filter_value AS filterValue
    FROM (SELECT DISTINCT unnest(${input.filterValuesSql}::VARCHAR[]) AS filter_value) requested
    WHERE requested.filter_value IS NOT NULL
      AND requested.filter_value <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM mart.review_article_filter_posting_serving_v4 posting
        WHERE posting.project_id = ${input.projectIdSql}
          AND posting.review_config_hash = ${input.reviewConfigHashSql}
          AND posting.snapshot_id = ${input.snapshotIdSql}
          AND posting.list_mode_key = ${input.listModeSql}
          AND posting.filter_kind = '${reviewServingPromptAnswerFilterKind}'
          AND posting.filter_value = requested.filter_value
      )
    ORDER BY requested.filter_value
  `
}

export const getReviewServingPromptAnswerPostingCacheWriteSqls = (input: {
  filterValuesSql: string
  listModeSql: string
  projectIdSql: string
  reviewConfigHashSql: string
  snapshotIdSql: string
}) => {
  const keyPredicate = `
    project_id = ${input.projectIdSql}
      AND review_config_hash = ${input.reviewConfigHashSql}
      AND snapshot_id = ${input.snapshotIdSql}
      AND list_mode_key = ${input.listModeSql}
      AND filter_kind = '${reviewServingPromptAnswerFilterKind}'
      AND filter_value IN (SELECT unnest(${input.filterValuesSql}::VARCHAR[]))
  `

  return [
    `
      DELETE FROM mart.review_article_filter_posting_serving_v4
      WHERE ${keyPredicate}
    `,
    `
      INSERT INTO mart.review_article_filter_posting_serving_v4 (
        project_id,
        review_config_hash,
        snapshot_id,
        article_ids,
        filter_kind,
        filter_value,
        list_mode_key
      )
      SELECT
        ${input.projectIdSql} AS project_id,
        ${input.reviewConfigHashSql} AS review_config_hash,
        ${input.snapshotIdSql} AS snapshot_id,
        COALESCE(
          list(DISTINCT source_article.article_id ORDER BY source_article.article_id)
            FILTER (WHERE source_article.article_id IS NOT NULL),
          []::VARCHAR[]
        ) AS article_ids,
        '${reviewServingPromptAnswerFilterKind}' AS filter_kind,
        requested.filter_value,
        ${input.listModeSql} AS list_mode_key
      FROM (SELECT DISTINCT unnest(${input.filterValuesSql}::VARCHAR[]) AS filter_value) requested
      LEFT JOIN (
        ${getReviewServingLazyPromptAnswerPostingSourceSql(input)}
      ) source
        ON source.filter_value = requested.filter_value
      LEFT JOIN UNNEST(COALESCE(source.article_ids, []::VARCHAR[])) AS source_article(article_id)
        ON TRUE
      WHERE requested.filter_value IS NOT NULL
        AND requested.filter_value <> ''
      GROUP BY requested.filter_value
    `,
  ]
}

const getSqlLiteral = (value: readonly string[] | string | null) => {
  if (value === null) {
    return 'NULL'
  }

  if (typeof value === 'string') {
    return `'${value.replaceAll("'", "''")}'`
  }

  return `[${value
    .map((entry) => {
      return `'${entry.replaceAll("'", "''")}'`
    })
    .join(', ')}]`
}

const executeStatement = async (database: ReviewServingLazyPromptAnswerPostingDatabase, statement: string) => {
  if (database.run) {
    await database.run(statement)
    return
  }

  await database.queryJson<unknown>(statement)
}

const executeTransaction = async (
  database: ReviewServingLazyPromptAnswerPostingDatabase,
  statements: readonly string[],
) => {
  await executeStatement(database, 'BEGIN TRANSACTION')

  try {
    for (const statement of statements) {
      await executeStatement(database, statement)
    }

    await executeStatement(database, 'COMMIT')
  } catch (error) {
    await executeStatement(database, 'ROLLBACK')
    throw error
  }
}

const getEnsureKey = (input: {
  filterValues: readonly string[]
  listModeKey: string
  projectId: string
  reviewConfigHash: string | null
  snapshotId: string
}) => {
  return JSON.stringify({
    filterValues: input.filterValues,
    listModeKey: input.listModeKey,
    projectId: input.projectId,
    reviewConfigHash: input.reviewConfigHash,
    snapshotId: input.snapshotId,
  })
}

const ensureReviewServingLazyPromptAnswerPostingBucketsUncoalesced = async (input: {
  database: ReviewServingLazyPromptAnswerPostingDatabase
  filterValues: readonly string[]
  listModeKey: string
  projectId: string
  reviewConfigHash: string | null
  snapshotId: string
}): Promise<ReviewServingLazyPromptAnswerPostingEnsureResult> => {
  const requestedFilterValues = [...new Set(input.filterValues)]
    .filter((value) => {
      return value.length > 0
    })
    .sort((left, right) => {
      return left.localeCompare(right)
    })

  if (requestedFilterValues.length === 0) {
    return {
      diagnostics: reviewServingLazyPromptAnswerPostingDiagnostics,
      missingFilterValues: [],
      requestedFilterValues,
      status: 'emptyRequest',
      writtenBucketCount: 0,
    }
  }

  const sqlInput = {
    filterValuesSql: getSqlLiteral(requestedFilterValues),
    listModeSql: getSqlLiteral(input.listModeKey),
    projectIdSql: getSqlLiteral(input.projectId),
    reviewConfigHashSql: getSqlLiteral(input.reviewConfigHash),
    snapshotIdSql: getSqlLiteral(input.snapshotId),
  }
  const missingRows = await input.database.queryJson<{filterValue: string}>(
    getReviewServingPromptAnswerPostingMissingValuesSql(sqlInput),
  )
  const missingFilterValues = missingRows
    .map((row) => {
      return row.filterValue
    })
    .filter((value) => {
      return requestedFilterValues.includes(value)
    })

  if (missingFilterValues.length === 0) {
    return {
      diagnostics: reviewServingLazyPromptAnswerPostingDiagnostics,
      missingFilterValues,
      requestedFilterValues,
      status: 'cacheHit',
      writtenBucketCount: 0,
    }
  }

  await executeTransaction(
    input.database,
    getReviewServingPromptAnswerPostingCacheWriteSqls({
      ...sqlInput,
      filterValuesSql: getSqlLiteral(missingFilterValues),
    }),
  )

  return {
    diagnostics: reviewServingLazyPromptAnswerPostingDiagnostics,
    missingFilterValues,
    requestedFilterValues,
    status: 'cacheWritten',
    writtenBucketCount: missingFilterValues.length,
  }
}

export const ensureReviewServingLazyPromptAnswerPostingBuckets = async (input: {
  database: ReviewServingLazyPromptAnswerPostingDatabase
  filterValues: readonly string[]
  listModeKey: string
  projectId: string
  reviewConfigHash: string | null
  snapshotId: string
}): Promise<ReviewServingLazyPromptAnswerPostingEnsureResult> => {
  const requestedFilterValues = [...new Set(input.filterValues)]
    .filter((value) => {
      return value.length > 0
    })
    .sort((left, right) => {
      return left.localeCompare(right)
    })
  const ensureKey = getEnsureKey({...input, filterValues: requestedFilterValues})
  const inflight = inflightEnsurePromises.get(ensureKey)

  if (inflight) {
    return inflight
  }

  const promise = ensureReviewServingLazyPromptAnswerPostingBucketsUncoalesced({
    ...input,
    filterValues: requestedFilterValues,
  }).finally(() => {
    inflightEnsurePromises.delete(ensureKey)
  })

  inflightEnsurePromises.set(ensureKey, promise)

  return promise
}
