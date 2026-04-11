import {
  buildNumericFilterResult,
  buildNumericFilterResultFromValues,
  type NumericFilterResult,
} from '../../server/routes/projectsRoutes/articlesReviewsFiltersNumeric.ts'
import {isNumericType} from '../../server/routes/projectsRoutes/articlesReviewsFiltersUtils.ts'
import {
  deriveStrictSummaryAnswer,
  hasMatchingJudgmentAnswer,
  getNormalizedSummaryAnswer,
  normalizeSummaryAnswerValue,
} from '../../server/utils/judgmentAnswers.ts'
import {createRateLimitedLogger} from '../../server/utils/rateLimitedLogger.ts'
import {
  type ArticleSourceMetadata,
  emptyArticleSourceMetadata,
  getArticleSourceMetadataValue,
} from '../../utils/articleSourceMetadata.ts'
import {getDuckdbSqlBoolean, getDuckdbSqlString, getDuckdbSqlStringList, runDuckdbJsonQuery} from './duckdbRunner.ts'
import type {
  ArticlesReviewsBothParams,
  ArticlesReviewsBothResponse,
  ArticlesReviewsCountParams,
  ArticlesReviewsCountResponse,
  ArticlesReviewsParams,
  ArticlesReviewsResponse,
  DatabaseFilterParams,
  DatabaseFilterResult,
  HumanAnswersByPrompt,
  OlapJudgmentRow,
  PaginationCursor,
  PromptQueueEntry,
  SelectArticleIdsArgs,
  UnassessedArticleRow,
  UnassessedArticlesParams,
  UnassessedCountParams,
  UnassessedPairsParams,
  UnassessedPairsResult,
} from './olapTypes.ts'

type ProjectOlapScope = {
  projectId: string
  humanJudgmentMode: 'prompt' | 'summary'
  promptRows: Array<{
    id: string
    order: number | null
    promptHeading: string | null
    originalText: string
    type: string | null
    criteriaDisposition: 'include' | 'exclude' | null
  }>
  promptIds: string[]
  promptOrderMap: Record<string, number>
  promptNameById: Record<string, string>
  routeIds: string[]
  dateFrom: Date | null
  dateTo: Date | null
  modelId: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}

type ScopedArticleRow = {
  id: string
  createdAt: Date
  updatedAt: Date
  articleId: string | null
  articleTitle: string
  articleCreatedAt: Date | null
  articleUpdatedAt: Date | null
  importRoute: string | null
  url: string | null
  fullTextPDF: string | null
  fullTextFetchedAt: Date | null
  fullTextConversionStatus: string | null
  sourceMetadata: ArticleSourceMetadata
}

type HumanAnswerRow = {articleId: string; promptId: string; answer: string | null; updatedAt: Date | null}
type HumanSummaryRow = {articleId: string; answer: string | null; updatedAt: Date | null}
type UnassessedCandidateRow = {
  articleId: string
  articleCreatedAt: Date | null
  articleUpdatedAt: Date | null
  llmJudgedPromptIds: string[]
}

const rawFallbackQueueLogger = createRateLimitedLogger({windowMs: 30_000})

const getDuckdbJudgmentProjectWhereClause = (params: {judgmentAlias: string; projectId: string}) => {
  return `COALESCE(${params.judgmentAlias}.project_id, ${params.judgmentAlias}.snapshot_project_id) = ${getDuckdbSqlString(params.projectId)}`
}

const getPromptFilters = (promptsFilter?: Record<string, string[]>) => {
  return Object.entries(promptsFilter ?? {}).filter(([, answers]) => {
    return Array.isArray(answers) && answers.length > 0
  })
}

const getEmptyDatabaseFilters = (prompts: DatabaseFilterParams['prompts']) => {
  return prompts
    .filter((prompt) => {
      return prompt.strategy === 'database'
    })
    .map((prompt) => {
      return {promptId: prompt.promptId, promptName: prompt.promptName, answeredOriginalValues: []}
    })
}

const getEmptyNumericFilters = (prompts: DatabaseFilterParams['prompts']) => {
  return prompts
    .filter((prompt) => {
      return prompt.strategy === 'numeric'
    })
    .map((prompt) => {
      return buildNumericFilterResult(prompt.promptId, prompt.promptName, null, null, prompt.specialValues ?? [])
    })
}

const getPromptOrderMap = (promptRows: ProjectOlapScope['promptRows']) => {
  return promptRows.reduce<Record<string, number>>((rowMap, row, index) => {
    return {...rowMap, [row.id]: row.order ?? index}
  }, {})
}

const getPromptNameById = (promptRows: ProjectOlapScope['promptRows']) => {
  return promptRows.reduce<Record<string, string>>((rowMap, row) => {
    return {...rowMap, [row.id]: row.promptHeading || row.originalText}
  }, {})
}

const parseDateFromInput = (value: string | null | undefined, timeSuffix: string) => {
  return value ? new Date(`${value}${timeSuffix}`) : null
}

const getStrictIntegerValue = (value: string | null | undefined) => {
  const trimmedValue = value?.trim() ?? ''
  return /^[-+]?\d+$/.exec(trimmedValue) ? Number.parseInt(trimmedValue, 10) : null
}

const getEffectiveFromDate = (projectDateFrom: Date | null, fromDate: Date | null) => {
  return projectDateFrom && fromDate
    ? projectDateFrom > fromDate
      ? projectDateFrom
      : fromDate
    : (projectDateFrom ?? fromDate)
}

const getEffectiveToDate = (projectDateTo: Date | null, toDate: Date | null) => {
  return projectDateTo && toDate ? (projectDateTo < toDate ? projectDateTo : toDate) : (projectDateTo ?? toDate)
}

const getDuckdbDateValue = (value: unknown): Date | null => {
  if (value === null || value === undefined || value === '') {
    return null
  }

  if (value instanceof Date) {
    return value
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return new Date(Number(value))
  }

  const trimmedValue = typeof value === 'string' ? value.trim() : ''

  if (!trimmedValue) {
    return null
  }

  const numericValue = Number(trimmedValue)
  if (Number.isFinite(numericValue) && /^-?\d+(\.\d+)?$/.exec(trimmedValue) !== null) {
    return new Date(numericValue)
  }

  const parsedDate = new Date(trimmedValue)
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate
}

const getDuckdbBooleanValue = (value: unknown, fallback: boolean) => {
  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return Number(value) !== 0
  }

  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return normalized === 'true' || normalized === '1'
    ? true
    : normalized === 'false' || normalized === '0'
      ? false
      : fallback
}

const getDuckdbJsonValue = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value
  }

  try {
    return getDuckdbJsonValue(JSON.parse(value) as unknown)
  } catch {
    return value
  }
}

const getPaginationCursorSummary = (cursor: PaginationCursor | null) => {
  return cursor ? {lastArticleId: cursor.lastArticleId.slice(0, 8), lastDate: cursor.lastDate.toISOString()} : null
}

const getDuckdbArticleSourceMetadata = (sourceMetadata: unknown) => {
  return getArticleSourceMetadataValue(getDuckdbJsonValue(sourceMetadata)) ?? emptyArticleSourceMetadata
}

const getMatchesCovidenceSourceMetadataFilters = (params: {
  sourceMetadata: ArticleSourceMetadata
  hasDuplicateStudyRecords?: boolean
  hasStudyDecisionConflict?: boolean
}) => {
  return (
    (!params.hasDuplicateStudyRecords || params.sourceMetadata.covidence?.hasDuplicateStudyRecords === true)
    && (!params.hasStudyDecisionConflict || params.sourceMetadata.covidence?.hasStudyDecisionConflict === true)
  )
}

const getDuckdbCovidenceMetadataWhereParts = (params: {
  sourceMetadataExpression: string
  hasDuplicateStudyRecords?: boolean
  hasStudyDecisionConflict?: boolean
}) => {
  return [
    params.hasDuplicateStudyRecords
      ? `LOWER(COALESCE(json_extract_string(${params.sourceMetadataExpression}, '$.covidence.hasDuplicateStudyRecords'), 'false')) = 'true'`
      : null,
    params.hasStudyDecisionConflict
      ? `LOWER(COALESCE(json_extract_string(${params.sourceMetadataExpression}, '$.covidence.hasStudyDecisionConflict'), 'false')) = 'true'`
      : null,
  ].filter((part): part is string => {
    return part !== null
  })
}

const getDuckdbStringArrayValue = (value: unknown) => {
  const normalizedValue = getDuckdbJsonValue(value)
  return Array.isArray(normalizedValue)
    ? normalizedValue.filter((entry): entry is string => {
        return typeof entry === 'string'
      })
    : []
}

type ReviewPageCursor = {articleCreatedAt: string | null; articleId: string}

const getHasPromptFilters = (prompts?: Record<string, string[]>) => {
  return Object.values(prompts ?? {}).some((values) => {
    return Array.isArray(values) && values.length > 0
  })
}

const getPromptFilterEntries = (prompts?: Record<string, string[]>) => {
  return getPromptFilters(prompts)
}

const encodeReviewPageCursor = (cursor: ReviewPageCursor) => {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

const decodeReviewPageCursor = (cursor: string | null | undefined): ReviewPageCursor | null => {
  if (!cursor) {
    return null
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<ReviewPageCursor>
    return typeof parsed.articleId === 'string'
      && (typeof parsed.articleCreatedAt === 'string' || parsed.articleCreatedAt === null)
      ? {articleId: parsed.articleId, articleCreatedAt: parsed.articleCreatedAt}
      : null
  } catch {
    return null
  }
}

const getDuckdbTimestampLiteral = (value: Date) => {
  return `TIMESTAMPTZ ${getDuckdbSqlString(value.toISOString())}`
}

const getDuckdbScopeClause = (params: {articleAlias: string; routeIds: string[]; projectId: string}) => {
  const routeClause =
    params.routeIds.length > 0
      ? `EXISTS (
          SELECT 1 FROM app.article_import_route arl
          WHERE arl.article_id = ${params.articleAlias}.id
            AND arl.import_route_id IN (${getDuckdbSqlStringList(params.routeIds).join(', ')})
        )`
      : null
  const projectClause = `EXISTS (
    SELECT 1 FROM app.project_article pa
    WHERE pa.article_id = ${params.articleAlias}.id
      AND pa.project_id = ${getDuckdbSqlString(params.projectId)}
  )`
  return routeClause ? `(${routeClause} OR ${projectClause})` : projectClause
}

const getDuckdbSqlArrayLiteral = (values: string[]) => {
  return `[${getDuckdbSqlStringList(values).join(', ')}]`
}

const getProjectMartFreshnessClause = () => {
  return `(
    refresh_state.project_id IS NULL
    OR CAST(refresh_state.dirty_token AS BIGINT) <= CAST(refresh_state.last_completed_refresh_token AS BIGINT)
  )`
}

const getDuckdbPromptTypeById = (scope: ProjectOlapScope) => {
  return scope.promptRows.reduce<Record<string, string | null>>((rowMap, row) => {
    return {...rowMap, [row.id]: row.type}
  }, {})
}

const getDuckdbAnswerArrayExpression = (rowAlias: string) => {
  return `CASE
    WHEN ${rowAlias}.answered_original_as_array IS NOT NULL
      AND array_length(${rowAlias}.answered_original_as_array) > 0
      THEN ${rowAlias}.answered_original_as_array
    WHEN json_valid(${rowAlias}.answered_original)
      AND TRIM(COALESCE(${rowAlias}.answered_original, '')) LIKE '[%'
      THEN json_extract_string(${rowAlias}.answered_original, '$[*]')
    ELSE []::VARCHAR[]
  END`
}

const getDuckdbReviewedPromptHavingParts = (scope: ProjectOlapScope, prompts?: Record<string, string[]>) => {
  const promptTypeById = getDuckdbPromptTypeById(scope)
  const promptFilters = getPromptFilters(prompts)

  return promptFilters.reduce<string[]>((havingParts, [promptId, answeredValues]) => {
    const promptType = promptTypeById[promptId]
    const isNumericPrompt = promptType ? isNumericType(promptType) : false

    if (isNumericPrompt) {
      const parsedFilters = answeredValues.reduce<{
        binRanges: Array<{min: number; max: number}>
        specialValues: string[]
      }>(
        (filters, value) => {
          if (!value.startsWith('bin:')) {
            return {...filters, specialValues: [...filters.specialValues, value]}
          }

          const [, minRaw = '', maxRaw = ''] = value.split(':')
          const min = Number.parseInt(minRaw, 10)
          const max = Number.parseInt(maxRaw, 10)

          return Number.isNaN(min) || Number.isNaN(max)
            ? filters
            : {...filters, binRanges: [...filters.binRanges, {min, max}]}
        },
        {binRanges: [], specialValues: []},
      )
      const numericValueExpression = `TRY_CAST(TRIM(COALESCE(j.answered_original, '')) AS BIGINT)`
      const rangeCondition =
        parsedFilters.binRanges.length > 0
          ? `(${parsedFilters.binRanges
              .map((range) => {
                return `(${numericValueExpression} >= ${range.min} AND ${numericValueExpression} <= ${range.max})`
              })
              .join(' OR ')})`
          : null
      const specialCondition =
        parsedFilters.specialValues.length > 0
          ? `TRIM(COALESCE(j.answered_original, '')) IN (${getDuckdbSqlStringList(parsedFilters.specialValues).join(', ')})`
          : null
      const conditions = [rangeCondition, specialCondition].filter((condition): condition is string => {
        return condition !== null
      })

      return conditions.length === 0
        ? havingParts
        : [
            ...havingParts,
            `COUNT(*) FILTER (WHERE j.prompt_id = ${getDuckdbSqlString(promptId)} AND (${conditions.join(' OR ')})) > 0`,
          ]
    }

    const answerArrayExpression = getDuckdbAnswerArrayExpression('j')
    const quotedValues = getDuckdbSqlStringList(answeredValues).join(', ')
    return [
      ...havingParts,
      `COUNT(*) FILTER (
        WHERE j.prompt_id = ${getDuckdbSqlString(promptId)}
          AND (
            (array_length(${answerArrayExpression}) > 0 AND list_has_any(${answerArrayExpression}, ${getDuckdbSqlArrayLiteral(answeredValues)}))
            OR (array_length(${answerArrayExpression}) = 0 AND TRIM(COALESCE(j.answered_original, '')) IN (${quotedValues}))
          )
      ) > 0`,
    ]
  }, [])
}

const getDuckdbReviewedPageCursorWhereClause = (cursor: ReviewPageCursor) => {
  const createdAtLiteral = cursor.articleCreatedAt
    ? getDuckdbTimestampLiteral(new Date(cursor.articleCreatedAt))
    : `TIMESTAMPTZ '0001-01-01T00:00:00.000Z'`

  return `(
    COALESCE(a.article_created_at, TIMESTAMPTZ '0001-01-01T00:00:00.000Z') < ${createdAtLiteral}
    OR (
      COALESCE(a.article_created_at, TIMESTAMPTZ '0001-01-01T00:00:00.000Z') = ${createdAtLiteral}
      AND a.id > ${getDuckdbSqlString(cursor.articleId)}
    )
  )`
}

const getDuckdbServingPostingSelection = (scope: ProjectOlapScope, prompts?: Record<string, string[]>) => {
  const promptFilters = getPromptFilterEntries(prompts)

  if (promptFilters.length === 0) {
    return null
  }

  const promptTypeById = getDuckdbPromptTypeById(scope)
  const dictionaryConditions = promptFilters
    .map(([promptId, answeredValues]) => {
      const promptType = promptTypeById[promptId]
      const isNumericPrompt = promptType ? isNumericType(promptType) : false

      if (!isNumericPrompt) {
        return `(d.prompt_id = ${getDuckdbSqlString(promptId)} AND d.answer_value IN (${getDuckdbSqlStringList(answeredValues).join(', ')}))`
      }

      const parsedFilters = answeredValues.reduce<{
        binRanges: Array<{min: number; max: number}>
        specialValues: string[]
      }>(
        (filters, value) => {
          if (!value.startsWith('bin:')) {
            return {...filters, specialValues: [...filters.specialValues, value]}
          }

          const [, minRaw = '', maxRaw = ''] = value.split(':')
          const min = Number.parseInt(minRaw, 10)
          const max = Number.parseInt(maxRaw, 10)

          return Number.isNaN(min) || Number.isNaN(max)
            ? filters
            : {...filters, binRanges: [...filters.binRanges, {min, max}]}
        },
        {binRanges: [], specialValues: []},
      )
      const numericCondition =
        parsedFilters.binRanges.length === 0
          ? null
          : `(${parsedFilters.binRanges
              .map((range) => {
                return `(d.numeric_answer_value >= ${range.min} AND d.numeric_answer_value <= ${range.max})`
              })
              .join(' OR ')})`
      const specialCondition =
        parsedFilters.specialValues.length === 0
          ? null
          : `d.answer_value IN (${getDuckdbSqlStringList(parsedFilters.specialValues).join(', ')})`
      const answerCondition = [numericCondition, specialCondition].filter((part): part is string => {
        return part !== null
      })

      return answerCondition.length === 0
        ? null
        : `(d.prompt_id = ${getDuckdbSqlString(promptId)} AND (${answerCondition.join(' OR ')}))`
    })
    .filter((part): part is string => {
      return part !== null
    })

  if (dictionaryConditions.length === 0) {
    return null
  }

  return {
    promptCount: promptFilters.length,
    sql: `
      selected_answers AS (
        SELECT d.prompt_id, d.answer_id
        FROM app.review_answer_dictionary d
        WHERE d.project_id = ${getDuckdbSqlString(scope.projectId)}
          AND (${dictionaryConditions.join(' OR ')})
      ),
      matched_article_id AS (
        SELECT member.article_id AS articleId
        FROM mart.review_article_filter_member member
        INNER JOIN active_generation active
          ON active.projectId = member.project_id
         AND active.generation = member.generation
        INNER JOIN selected_answers
          ON selected_answers.prompt_id = member.prompt_id
         AND selected_answers.answer_id = member.answer_id
        WHERE member.project_id = ${getDuckdbSqlString(scope.projectId)}
        GROUP BY member.article_id
        HAVING COUNT(DISTINCT member.prompt_id) = ${promptFilters.length}
      )
    `,
  }
}

const getDuckdbServingBaseWhereParts = (params: {
  scope: ProjectOlapScope
  hasDuplicateStudyRecords?: boolean
  hasStudyDecisionConflict?: boolean
  from?: string | null
  to?: string | null
  search?: string | null
  cursor?: string | null
}) => {
  const requestFromDate = parseDateFromInput(params.from, 'T00:00:00.000Z')
  const requestToDate = parseDateFromInput(params.to, 'T23:59:59.999Z')
  const effectiveFromDate = getEffectiveFromDate(params.scope.dateFrom, requestFromDate)
  const effectiveToDate = getEffectiveToDate(params.scope.dateTo, requestToDate)
  const trimmedSearch = params.search?.trim() ?? ''
  const decodedCursor = decodeReviewPageCursor(params.cursor)

  return [
    `s.project_id = ${getDuckdbSqlString(params.scope.projectId)}`,
    effectiveFromDate ? `s.article_created_at >= ${getDuckdbTimestampLiteral(effectiveFromDate)}` : null,
    effectiveToDate ? `s.article_created_at <= ${getDuckdbTimestampLiteral(effectiveToDate)}` : null,
    trimmedSearch
      ? `LOWER(COALESCE(s.article_title, '')) LIKE LOWER(${getDuckdbSqlString(`%${trimmedSearch}%`)})`
      : null,
    decodedCursor
      ? `(
          COALESCE(s.article_created_at, TIMESTAMPTZ '0001-01-01T00:00:00.000Z') < ${
            decodedCursor.articleCreatedAt
              ? getDuckdbTimestampLiteral(new Date(decodedCursor.articleCreatedAt))
              : `TIMESTAMPTZ '0001-01-01T00:00:00.000Z'`
          }
          OR (
            COALESCE(s.article_created_at, TIMESTAMPTZ '0001-01-01T00:00:00.000Z') = ${
              decodedCursor.articleCreatedAt
                ? getDuckdbTimestampLiteral(new Date(decodedCursor.articleCreatedAt))
                : `TIMESTAMPTZ '0001-01-01T00:00:00.000Z'`
            }
            AND s.article_id > ${getDuckdbSqlString(decodedCursor.articleId)}
          )
        )`
      : null,
    ...getDuckdbCovidenceMetadataWhereParts({
      sourceMetadataExpression: 's.source_metadata',
      hasDuplicateStudyRecords: params.hasDuplicateStudyRecords,
      hasStudyDecisionConflict: params.hasStudyDecisionConflict,
    }),
  ].filter((part): part is string => {
    return part !== null
  })
}

const getDuckdbServingWhereParts = (params: {
  scope: ProjectOlapScope
  from?: string | null
  to?: string | null
  search?: string | null
  cursor?: string | null
}) => {
  return getDuckdbServingReviewWhereParts({...params, requireAnyLlmJudgments: true})
}

const getDuckdbServingReviewWhereParts = (params: {
  scope: ProjectOlapScope
  hasDuplicateStudyRecords?: boolean
  hasStudyDecisionConflict?: boolean
  from?: string | null
  to?: string | null
  search?: string | null
  requireAllHumanAnswers?: boolean
  requireAllLlmJudgments?: boolean
  requireAnyLlmJudgments?: boolean
  requireIncompleteLlm?: boolean
}) => {
  return [
    ...getDuckdbServingBaseWhereParts(params),
    params.requireAllLlmJudgments
      ? 's.has_all_llm_judgments = TRUE'
      : params.requireAnyLlmJudgments
        ? 'COALESCE(s.llm_judged_prompt_count, 0) > 0'
        : null,
    params.requireAllHumanAnswers ? 's.has_all_human_answers = TRUE' : null,
    params.requireIncompleteLlm ? 's.has_all_llm_judgments = FALSE' : null,
  ].filter((part): part is string => {
    return part !== null
  })
}

const getReviewedPageRowsFromServingMart = async (params: {
  scope: ProjectOlapScope
  page: number
  limit: number
  hasDuplicateStudyRecords?: boolean
  hasStudyDecisionConflict?: boolean
  from?: string | null
  to?: string | null
  search?: string | null
  cursor?: string | null
  prompts?: Record<string, string[]>
}) => {
  const whereParts = getDuckdbServingWhereParts(params)
  const offset = params.cursor ? 0 : Math.max(params.page - 1, 0) * params.limit
  const postingSelection = getDuckdbServingPostingSelection(params.scope, params.prompts)
  const withPrefix = `WITH active_generation AS (
        SELECT project_id AS projectId, active_generation AS generation
        FROM app.project_review_serving_generation
        WHERE project_id = ${getDuckdbSqlString(params.scope.projectId)}
      )`
  const withClause = postingSelection ? `${withPrefix}, ${postingSelection.sql}` : withPrefix
  const joinClause = postingSelection ? 'INNER JOIN matched_article_id matched ON matched.articleId = s.article_id' : ''
  const rows = await runDuckdbJsonQuery<{
    articleCreatedAt: unknown
    articleExternalId: string | null
    articleId: string
    articleTitle: string
    articleUpdatedAt: unknown
    fullTextConversionStatus: string | null
    fullTextFetchedAt: unknown
    fullTextPDF: string | null
    sourceMetadata: unknown
    url: string | null
  }>(`
    ${withClause}
    SELECT
      s.article_id AS articleId,
      s.article_external_id AS articleExternalId,
      s.article_title AS articleTitle,
      s.article_created_at AS articleCreatedAt,
      s.article_updated_at AS articleUpdatedAt,
      s.url AS url,
      s.full_text_pdf AS fullTextPDF,
      s.full_text_fetched_at AS fullTextFetchedAt,
      s.full_text_conversion_status AS fullTextConversionStatus,
      s.source_metadata AS sourceMetadata
    FROM mart.review_article_serving s
    INNER JOIN active_generation active
      ON active.projectId = s.project_id
     AND active.generation = s.generation
    ${joinClause}
    WHERE ${whereParts.join(' AND ')}
    ORDER BY COALESCE(s.article_created_at, TIMESTAMPTZ '0001-01-01T00:00:00.000Z') DESC, s.article_id ASC
    LIMIT ${params.limit + 1}
    OFFSET ${offset}
  `)
  const hasMore = rows.length > params.limit
  const pageRows = rows.slice(0, params.limit)
  const lastRow = pageRows[pageRows.length - 1]

  return {
    nextCursor:
      hasMore && lastRow
        ? encodeReviewPageCursor({
            articleCreatedAt: getDuckdbDateValue(lastRow.articleCreatedAt)?.toISOString() ?? null,
            articleId: lastRow.articleId,
          })
        : null,
    rows: pageRows.map((row) => {
      const sourceMetadata = getDuckdbArticleSourceMetadata(row.sourceMetadata)

      return {
        articleCreatedAt: getDuckdbDateValue(row.articleCreatedAt),
        articleId: row.articleExternalId,
        articleTitle: row.articleTitle,
        articleUpdatedAt: getDuckdbDateValue(row.articleUpdatedAt),
        fullTextConversionStatus: row.fullTextConversionStatus,
        fullTextFetchedAt: getDuckdbDateValue(row.fullTextFetchedAt),
        fullTextPDF: row.fullTextPDF,
        id: row.articleId,
        journalTitle: sourceMetadata.journalTitle,
        sourceMetadata,
        url: row.url,
      }
    }),
  }
}

const countReviewedServingRows = async (params: {
  scope: ProjectOlapScope
  hasDuplicateStudyRecords?: boolean
  hasStudyDecisionConflict?: boolean
  from?: string | null
  to?: string | null
  search?: string | null
  prompts?: Record<string, string[]>
}) => {
  const whereParts = getDuckdbServingWhereParts({...params, cursor: null})
  const postingSelection = getDuckdbServingPostingSelection(params.scope, params.prompts)
  const withPrefix = `WITH active_generation AS (
        SELECT project_id AS projectId, active_generation AS generation
        FROM app.project_review_serving_generation
        WHERE project_id = ${getDuckdbSqlString(params.scope.projectId)}
      )`
  const withClause = postingSelection ? `${withPrefix}, ${postingSelection.sql}` : withPrefix
  const joinClause = postingSelection ? 'INNER JOIN matched_article_id matched ON matched.articleId = s.article_id' : ''
  const rows = await runDuckdbJsonQuery<{totalCount: number}>(`
    ${withClause}
    SELECT COUNT(*) AS totalCount
    FROM mart.review_article_serving s
    INNER JOIN active_generation active
      ON active.projectId = s.project_id
     AND active.generation = s.generation
    ${joinClause}
    WHERE ${whereParts.join(' AND ')}
  `)

  return Number(rows[0]?.totalCount ?? 0)
}

const getBothPageRowsFromServing = async (params: {
  scope: ProjectOlapScope
  page: number
  limit: number
  hasDuplicateStudyRecords?: boolean
  hasStudyDecisionConflict?: boolean
  from?: string | null
  to?: string | null
  search?: string | null
  prompts?: Record<string, string[]>
}) => {
  const offset = Math.max(params.page - 1, 0) * params.limit
  const whereParts = getDuckdbServingReviewWhereParts({
    ...params,
    requireAllHumanAnswers: true,
    requireAllLlmJudgments: true,
  })
  const postingSelection = getDuckdbServingPostingSelection(params.scope, params.prompts)
  const withPrefix = `WITH active_generation AS (
      SELECT project_id AS projectId, active_generation AS generation
      FROM app.project_review_serving_generation
      WHERE project_id = ${getDuckdbSqlString(params.scope.projectId)}
    )`
  const withClause = postingSelection ? `${withPrefix}, ${postingSelection.sql}` : withPrefix
  const joinClause = postingSelection ? 'INNER JOIN matched_article_id matched ON matched.articleId = s.article_id' : ''
  const countRows = await runDuckdbJsonQuery<{totalCount: number}>(`
    ${withClause}
    SELECT COUNT(*) AS totalCount
    FROM mart.review_article_serving s
    INNER JOIN active_generation active
      ON active.projectId = s.project_id
     AND active.generation = s.generation
    ${joinClause}
    WHERE ${whereParts.join(' AND ')}
  `)
  const totalCount = Number(countRows[0]?.totalCount ?? 0)
  const rows = await runDuckdbJsonQuery<{
    articleCreatedAt: unknown
    articleId: string
    articleTitle: string
    articleUpdatedAt: unknown
    sourceMetadata: unknown
  }>(`
    ${withClause}
    SELECT
      s.article_id AS articleId,
      s.article_title AS articleTitle,
      s.article_created_at AS articleCreatedAt,
      s.article_updated_at AS articleUpdatedAt,
      s.source_metadata AS sourceMetadata
    FROM mart.review_article_serving s
    INNER JOIN active_generation active
      ON active.projectId = s.project_id
     AND active.generation = s.generation
    ${joinClause}
    WHERE ${whereParts.join(' AND ')}
    ORDER BY COALESCE(s.article_created_at, TIMESTAMPTZ '0001-01-01T00:00:00.000Z') DESC, s.article_id ASC
    LIMIT ${params.limit}
    OFFSET ${offset}
  `)

  return {
    rows: rows.map((row) => {
      return {
        articleCreatedAt: getDuckdbDateValue(row.articleCreatedAt),
        articleUpdatedAt: getDuckdbDateValue(row.articleUpdatedAt),
        id: row.articleId,
        articleTitle: row.articleTitle,
        sourceMetadata: getDuckdbArticleSourceMetadata(row.sourceMetadata),
      }
    }),
    totalCount,
  }
}

const countUnassessedRowsFromServing = async (params: {
  scope: ProjectOlapScope
  hasDuplicateStudyRecords?: boolean
  hasStudyDecisionConflict?: boolean
  from?: string | null
  to?: string | null
  search?: string | null
}) => {
  const whereParts = getDuckdbServingReviewWhereParts({...params, requireIncompleteLlm: true})
  const rows = await runDuckdbJsonQuery<{totalCount: number}>(`
    WITH active_generation AS (
      SELECT project_id AS projectId, active_generation AS generation
      FROM app.project_review_serving_generation
      WHERE project_id = ${getDuckdbSqlString(params.scope.projectId)}
    )
    SELECT COUNT(*) AS totalCount
    FROM mart.review_article_serving s
    INNER JOIN active_generation active
      ON active.projectId = s.project_id
     AND active.generation = s.generation
    WHERE ${whereParts.join(' AND ')}
  `)

  return Number(rows[0]?.totalCount ?? 0)
}

const getUnassessedRowsFromServing = async (params: {
  scope: ProjectOlapScope
  limit?: number
  offset?: number
  hasDuplicateStudyRecords?: boolean
  hasStudyDecisionConflict?: boolean
  from?: string | null
  to?: string | null
  search?: string | null
}) => {
  const totalCount = await countUnassessedRowsFromServing(params)
  const whereParts = getDuckdbServingReviewWhereParts({...params, requireIncompleteLlm: true})
  const limitClause = params.limit == null ? '' : `LIMIT ${params.limit}`
  const offsetClause = params.offset == null ? '' : `OFFSET ${params.offset}`
  const rows = await runDuckdbJsonQuery<{
    articleCreatedAt: unknown
    articleId: string
    articleTitle: string
    articleUpdatedAt: unknown
    llmJudgedPromptIds: unknown
  }>(`
    WITH active_generation AS (
      SELECT project_id AS projectId, active_generation AS generation
      FROM app.project_review_serving_generation
      WHERE project_id = ${getDuckdbSqlString(params.scope.projectId)}
    )
    SELECT
      s.article_id AS articleId,
      s.article_title AS articleTitle,
      s.article_created_at AS articleCreatedAt,
      s.article_updated_at AS articleUpdatedAt,
      TO_JSON(s.llm_judged_prompt_ids) AS llmJudgedPromptIds
    FROM mart.review_article_serving s
    INNER JOIN active_generation active
      ON active.projectId = s.project_id
     AND active.generation = s.generation
    WHERE ${whereParts.join(' AND ')}
    ORDER BY COALESCE(s.article_updated_at, s.article_created_at, TIMESTAMPTZ '1970-01-01T00:00:00.000Z') DESC, s.article_id DESC
    ${limitClause}
    ${offsetClause}
  `)

  return {
    rows: rows.map((row) => {
      return {
        id: row.articleId,
        articleId: row.articleId,
        articleTitle: row.articleTitle,
        articleCreatedAt: getDuckdbDateValue(row.articleCreatedAt),
        articleUpdatedAt: getDuckdbDateValue(row.articleUpdatedAt),
        llmJudgedPromptIds: getDuckdbStringArrayValue(row.llmJudgedPromptIds),
      }
    }),
    totalCount,
  }
}

const getUnassessedCandidateRowsFromServing = async (params: {
  scope: ProjectOlapScope
  cursor: PaginationCursor | null
  limit: number
}) => {
  const whereParts = getDuckdbServingReviewWhereParts({...params, requireIncompleteLlm: true})
  const cursorClause = params.cursor
    ? `(
        COALESCE(s.article_updated_at, s.article_created_at, TIMESTAMPTZ '1970-01-01T00:00:00.000Z') < ${getDuckdbTimestampLiteral(params.cursor.lastDate)}
        OR (
          COALESCE(s.article_updated_at, s.article_created_at, TIMESTAMPTZ '1970-01-01T00:00:00.000Z') = ${getDuckdbTimestampLiteral(params.cursor.lastDate)}
          AND s.article_id < ${getDuckdbSqlString(params.cursor.lastArticleId)}
        )
      )`
    : null
  const rows = await runDuckdbJsonQuery<{
    articleCreatedAt: unknown
    articleId: string
    articleUpdatedAt: unknown
    llmJudgedPromptIds: unknown
  }>(`
    WITH active_generation AS (
      SELECT project_id AS projectId, active_generation AS generation
      FROM app.project_review_serving_generation
      WHERE project_id = ${getDuckdbSqlString(params.scope.projectId)}
    )
    SELECT
      s.article_id AS articleId,
      s.article_created_at AS articleCreatedAt,
      s.article_updated_at AS articleUpdatedAt,
      TO_JSON(s.llm_judged_prompt_ids) AS llmJudgedPromptIds
    FROM mart.review_article_serving s
    INNER JOIN active_generation active
      ON active.projectId = s.project_id
     AND active.generation = s.generation
    WHERE ${[...whereParts, cursorClause]
      .filter((part): part is string => {
        return part !== null
      })
      .join(' AND ')}
    ORDER BY COALESCE(s.article_updated_at, s.article_created_at, TIMESTAMPTZ '1970-01-01T00:00:00.000Z') DESC, s.article_id DESC
    LIMIT ${params.limit + 1}
  `)

  return {
    hasMore: rows.length > params.limit,
    rows: rows.slice(0, params.limit).map((row) => {
      return {
        articleId: row.articleId,
        articleCreatedAt: getDuckdbDateValue(row.articleCreatedAt),
        articleUpdatedAt: getDuckdbDateValue(row.articleUpdatedAt),
        llmJudgedPromptIds: getDuckdbStringArrayValue(row.llmJudgedPromptIds),
      }
    }),
  }
}

const getReviewedArticleIdsFromServing = async (params: {
  scope: ProjectOlapScope
  hasDuplicateStudyRecords?: boolean
  hasStudyDecisionConflict?: boolean
  from?: string | null
  to?: string | null
  search?: string | null
  prompts?: Record<string, string[]>
  requireAllHumanAnswers?: boolean
  requireAllLlmJudgments?: boolean
}) => {
  const whereParts = getDuckdbServingReviewWhereParts({
    ...params,
    requireAllLlmJudgments: params.requireAllLlmJudgments,
    requireAnyLlmJudgments: !params.requireAllLlmJudgments,
    requireAllHumanAnswers: params.requireAllHumanAnswers,
  })
  const postingSelection = getDuckdbServingPostingSelection(params.scope, params.prompts)
  const withPrefix = `WITH active_generation AS (
        SELECT project_id AS projectId, active_generation AS generation
        FROM app.project_review_serving_generation
        WHERE project_id = ${getDuckdbSqlString(params.scope.projectId)}
      )`
  const withClause = postingSelection ? `${withPrefix}, ${postingSelection.sql}` : withPrefix
  const joinClause = postingSelection ? 'INNER JOIN matched_article_id matched ON matched.articleId = s.article_id' : ''
  const rows = await runDuckdbJsonQuery<{articleId: string}>(`
    ${withClause}
    SELECT s.article_id AS articleId
    FROM mart.review_article_serving s
    INNER JOIN active_generation active
      ON active.projectId = s.project_id
     AND active.generation = s.generation
    ${joinClause}
    WHERE ${whereParts.join(' AND ')}
    ORDER BY COALESCE(s.article_created_at, TIMESTAMPTZ '0001-01-01T00:00:00.000Z') DESC, s.article_id ASC
  `)

  return rows.map((row) => {
    return row.articleId
  })
}

const getHumanReviewedArticleIdsFromServing = async (params: {
  scope: ProjectOlapScope
  hasDuplicateStudyRecords?: boolean
  hasStudyDecisionConflict?: boolean
  from?: string | null
  to?: string | null
  search?: string | null
}) => {
  const whereParts = getDuckdbServingReviewWhereParts({...params, requireAllHumanAnswers: true})
  const rows = await runDuckdbJsonQuery<{articleId: string}>(`
    WITH active_generation AS (
      SELECT project_id AS projectId, active_generation AS generation
      FROM app.project_review_serving_generation
      WHERE project_id = ${getDuckdbSqlString(params.scope.projectId)}
    )
    SELECT s.article_id AS articleId
    FROM mart.review_article_serving s
    INNER JOIN active_generation active
      ON active.projectId = s.project_id
     AND active.generation = s.generation
    WHERE ${whereParts.join(' AND ')}
    ORDER BY COALESCE(s.article_created_at, TIMESTAMPTZ '0001-01-01T00:00:00.000Z') DESC, s.article_id ASC
  `)

  return rows.map((row) => {
    return row.articleId
  })
}

const getHasReviewArticleServingRows = async (scope: ProjectOlapScope) => {
  const scopeRouteQuery =
    scope.routeIds.length > 0
      ? `SELECT article_id AS articleId
         FROM app.article_import_route
         WHERE import_route_id IN (${getDuckdbSqlStringList(scope.routeIds).join(', ')})`
      : null
  const filteredScopeWhereParts = [
    scope.dateFrom ? `a.article_created_at >= ${getDuckdbTimestampLiteral(scope.dateFrom)}` : null,
    scope.dateTo ? `a.article_created_at <= ${getDuckdbTimestampLiteral(scope.dateTo)}` : null,
  ].filter((part): part is string => {
    return part !== null
  })
  const filteredScopeWhereClause =
    filteredScopeWhereParts.length > 0 ? `WHERE ${filteredScopeWhereParts.join(' AND ')}` : ''
  const scopeArticleIdsQuery = [
    scopeRouteQuery,
    `SELECT article_id AS articleId
     FROM app.project_article
     WHERE project_id = ${getDuckdbSqlString(scope.projectId)}`,
  ]
    .filter((query): query is string => {
      return query !== null
    })
    .join('\nUNION\n')
  const rows = await runDuckdbJsonQuery<{projectId: string}>(`
    WITH scope_article_ids AS (
      ${scopeArticleIdsQuery}
    ),
    filtered_scope_article_ids AS (
      SELECT a.id AS articleId
      FROM app.article a
      INNER JOIN scope_article_ids s ON s.articleId = a.id
      ${filteredScopeWhereClause}
      GROUP BY a.id
    ),
    active_generation AS (
      SELECT generation.project_id AS projectId, generation.active_generation AS generation
      FROM app.project_review_serving_generation generation
      LEFT JOIN app.project_mart_refresh_state refresh_state
        ON refresh_state.project_id = generation.project_id
      WHERE generation.project_id = ${getDuckdbSqlString(scope.projectId)}
        AND ${getProjectMartFreshnessClause()}
    ),
    scope_counts AS (
      SELECT COUNT(*) AS scopeRowCount
      FROM filtered_scope_article_ids
    ),
    serving_counts AS (
      SELECT COUNT(*) AS servingRowCount
      FROM mart.review_article_serving s
      INNER JOIN active_generation active
        ON active.projectId = s.project_id
       AND active.generation = s.generation
    )
    SELECT active.projectId
    FROM active_generation active
    CROSS JOIN scope_counts scope_counts
    CROSS JOIN serving_counts serving_counts
    WHERE scope_counts.scopeRowCount = serving_counts.servingRowCount
    LIMIT 1
  `)

  return rows.length > 0
}

const getHasReviewArticleFilterMemberRows = async (projectId: string) => {
  const rows = await runDuckdbJsonQuery<{projectId: string}>(`
    SELECT generation.project_id AS projectId
    FROM app.project_review_serving_generation generation
    LEFT JOIN app.project_mart_refresh_state refresh_state
      ON refresh_state.project_id = generation.project_id
    INNER JOIN mart.review_article_filter_member member
      ON member.project_id = generation.project_id
     AND member.generation = generation.active_generation
    WHERE generation.project_id = ${getDuckdbSqlString(projectId)}
      AND ${getProjectMartFreshnessClause()}
    LIMIT 1
  `)

  return rows.length > 0
}

const getHasReviewArticleJudgmentDetailRows = async (projectId: string) => {
  const rows = await runDuckdbJsonQuery<{projectId: string}>(`
    SELECT generation.project_id AS projectId
    FROM app.project_review_serving_generation generation
    LEFT JOIN app.project_mart_refresh_state refresh_state
      ON refresh_state.project_id = generation.project_id
    INNER JOIN mart.review_article_serving_detail detail
      ON detail.project_id = generation.project_id
     AND detail.generation = generation.active_generation
    WHERE generation.project_id = ${getDuckdbSqlString(projectId)}
      AND ${getProjectMartFreshnessClause()}
    LIMIT 1
  `)

  return rows.length > 0
}

const getJudgmentRowsForReviews = async (scope: ProjectOlapScope, articleIds: string[]) => {
  return (await getHasReviewArticleJudgmentDetailRows(scope.projectId))
    ? getLlmJudgmentRowsFromReviewDetailMart(scope, articleIds)
    : getLlmJudgmentRowsFromMart(scope, articleIds)
}

const getLlmJudgmentRowsFromMart = async (
  scope: ProjectOlapScope,
  articleIds: string[],
): Promise<OlapJudgmentRow[]> => {
  if (articleIds.length === 0 || scope.promptIds.length === 0) {
    return []
  }

  const whereParts = [
    `j.article_id IN (${getDuckdbSqlStringList(articleIds).join(', ')})`,
    `j.prompt_id IN (${getDuckdbSqlStringList(scope.promptIds).join(', ')})`,
    getDuckdbJudgmentProjectWhereClause({judgmentAlias: 'j', projectId: scope.projectId}),
    scope.modelId ? `j.model_id = ${getDuckdbSqlString(scope.modelId)}` : null,
    `j.use_title = ${getDuckdbSqlBoolean(scope.useTitle)}`,
    `j.use_abstract = ${getDuckdbSqlBoolean(scope.useAbstract)}`,
    `j.use_fulltext = ${getDuckdbSqlBoolean(scope.useFulltext)}`,
    `j.use_fulltext_no_images = ${getDuckdbSqlBoolean(scope.useFulltextNoImages)}`,
  ].filter((part): part is string => {
    return part !== null
  })
  const rows = await runDuckdbJsonQuery<{
    id: string
    createdAt: unknown
    articleId: string
    articleTitle: string
    articleCreatedAt: unknown
    articleUpdatedAt: unknown
    articleImportRoute: string | null
    promptId: string
    modelId: string
    answeredOriginal: string | null
    answeredOriginalAsArray: unknown
    explanation: string | null
    quotes: unknown
  }>(`
    SELECT
      j.judgment_id AS id,
      j.created_at AS createdAt,
      j.article_id AS articleId,
      j.article_title AS articleTitle,
      j.article_created_at AS articleCreatedAt,
      j.article_updated_at AS articleUpdatedAt,
      j.article_import_route AS articleImportRoute,
      j.prompt_id AS promptId,
      j.model_id AS modelId,
      j.answered_original AS answeredOriginal,
      TO_JSON(j.answered_original_as_array) AS answeredOriginalAsArray,
      j.explanation AS explanation,
      TO_JSON(j.quotes) AS quotes
    FROM mart.judgment_fact j
    WHERE ${whereParts.join('\n      AND ')}
  `)

  return rows.map((row) => {
    return toOlapJudgmentRow({
      ...row,
      createdAt: getDuckdbDateValue(row.createdAt) ?? new Date(0),
      articleCreatedAt: getDuckdbDateValue(row.articleCreatedAt),
      articleUpdatedAt: getDuckdbDateValue(row.articleUpdatedAt),
      answeredOriginalAsArray: getDuckdbStringArrayValue(row.answeredOriginalAsArray),
      quotes: getDuckdbJsonValue(row.quotes),
    })
  })
}

const getLlmJudgmentRowsFromReviewDetailMart = async (
  scope: ProjectOlapScope,
  articleIds: string[],
): Promise<OlapJudgmentRow[]> => {
  if (articleIds.length === 0 || scope.promptIds.length === 0) {
    return []
  }

  const rows = await runDuckdbJsonQuery<{
    id: string
    createdAt: unknown
    articleId: string
    articleTitle: string
    articleCreatedAt: unknown
    articleUpdatedAt: unknown
    articleImportRoute: string | null
    promptId: string
    modelId: string
    answeredOriginal: string | null
    answeredOriginalAsArray: unknown
  }>(`
    WITH active_generation AS (
      SELECT project_id AS projectId, active_generation AS generation
      FROM app.project_review_serving_generation
      WHERE project_id = ${getDuckdbSqlString(scope.projectId)}
    )
    SELECT
      j.judgment_id AS id,
      j.created_at AS createdAt,
      j.article_id AS articleId,
      article.article_title AS articleTitle,
      j.article_created_at AS articleCreatedAt,
      j.article_updated_at AS articleUpdatedAt,
      article.import_route AS articleImportRoute,
      j.prompt_id AS promptId,
      j.model_id AS modelId,
      j.answered_original AS answeredOriginal,
      TO_JSON(j.answered_original_as_array) AS answeredOriginalAsArray
    FROM mart.review_article_serving_detail j
    INNER JOIN active_generation active
      ON active.projectId = j.project_id
     AND active.generation = j.generation
    INNER JOIN app.article article ON article.id = j.article_id
    WHERE j.project_id = ${getDuckdbSqlString(scope.projectId)}
      AND j.article_id IN (${getDuckdbSqlStringList(articleIds).join(', ')})
      AND j.prompt_id IN (${getDuckdbSqlStringList(scope.promptIds).join(', ')})
    ORDER BY j.article_id ASC, j.prompt_order ASC NULLS LAST, j.created_at DESC
  `)

  return rows.map((row) => {
    return toOlapJudgmentRow({
      ...row,
      createdAt: getDuckdbDateValue(row.createdAt) ?? new Date(0),
      articleCreatedAt: getDuckdbDateValue(row.articleCreatedAt),
      articleUpdatedAt: getDuckdbDateValue(row.articleUpdatedAt),
      answeredOriginalAsArray: getDuckdbStringArrayValue(row.answeredOriginalAsArray),
      explanation: null,
      quotes: null,
    })
  })
}

const getDuckdbReviewedArticlesQuerySections = (params: {
  scope: ProjectOlapScope
  hasDuplicateStudyRecords?: boolean
  hasStudyDecisionConflict?: boolean
  from?: string | null
  to?: string | null
  search?: string | null
  prompts?: Record<string, string[]>
}) => {
  const requestFromDate = parseDateFromInput(params.from, 'T00:00:00.000Z')
  const requestToDate = parseDateFromInput(params.to, 'T23:59:59.999Z')
  const effectiveFromDate = getEffectiveFromDate(params.scope.dateFrom, requestFromDate)
  const effectiveToDate = getEffectiveToDate(params.scope.dateTo, requestToDate)
  const trimmedSearch = params.search?.trim() ?? ''
  const scopeRouteQuery =
    params.scope.routeIds.length > 0
      ? `SELECT article_id AS articleId
         FROM app.article_import_route
         WHERE import_route_id IN (${getDuckdbSqlStringList(params.scope.routeIds).join(', ')})`
      : null
  const filteredScopeWhereParts = [
    effectiveFromDate ? `a.article_created_at >= ${getDuckdbTimestampLiteral(effectiveFromDate)}` : null,
    effectiveToDate ? `a.article_created_at <= ${getDuckdbTimestampLiteral(effectiveToDate)}` : null,
    trimmedSearch
      ? `LOWER(COALESCE(a.article_title, '')) LIKE LOWER(${getDuckdbSqlString(`%${trimmedSearch}%`)})`
      : null,
    ...getDuckdbCovidenceMetadataWhereParts({
      sourceMetadataExpression: 'a.source_metadata',
      hasDuplicateStudyRecords: params.hasDuplicateStudyRecords,
      hasStudyDecisionConflict: params.hasStudyDecisionConflict,
    }),
  ].filter((part): part is string => {
    return part !== null
  })
  const judgmentsWhereParts = [
    `j.prompt_id IN (${getDuckdbSqlStringList(params.scope.promptIds).join(', ')})`,
    getDuckdbJudgmentProjectWhereClause({judgmentAlias: 'j', projectId: params.scope.projectId}),
    params.scope.modelId ? `j.model_id = ${getDuckdbSqlString(params.scope.modelId)}` : null,
    `j.use_title = ${getDuckdbSqlBoolean(params.scope.useTitle)}`,
    `j.use_abstract = ${getDuckdbSqlBoolean(params.scope.useAbstract)}`,
    `j.use_fulltext = ${getDuckdbSqlBoolean(params.scope.useFulltext)}`,
    `j.use_fulltext_no_images = ${getDuckdbSqlBoolean(params.scope.useFulltextNoImages)}`,
    'j.deleted_at IS NULL',
  ].filter((part): part is string => {
    return part !== null
  })
  const havingParts = [
    'COUNT(DISTINCT j.prompt_id) > 0',
    ...getDuckdbReviewedPromptHavingParts(params.scope, params.prompts),
  ]

  return {
    filteredScopeWhereClause:
      filteredScopeWhereParts.length > 0 ? `WHERE ${filteredScopeWhereParts.join(' AND ')}` : '',
    judgmentsWhereClause: judgmentsWhereParts.join(' AND '),
    havingClause: havingParts.join(' AND '),
    scopeArticleIdsQuery: [
      scopeRouteQuery,
      `SELECT article_id AS articleId
       FROM app.project_article
       WHERE project_id = ${getDuckdbSqlString(params.scope.projectId)}`,
    ]
      .filter((query): query is string => {
        return query !== null
      })
      .join('\nUNION\n'),
  }
}

const getDuckdbReviewedPageRows = async (params: {
  scope: ProjectOlapScope
  page: number
  limit: number
  hasDuplicateStudyRecords?: boolean
  hasStudyDecisionConflict?: boolean
  from?: string | null
  to?: string | null
  search?: string | null
  prompts?: Record<string, string[]>
  cursor?: string | null
}) => {
  const offset = params.cursor ? 0 : Math.max(params.page - 1, 0) * params.limit
  const sections = getDuckdbReviewedArticlesQuerySections(params)
  const decodedCursor = decodeReviewPageCursor(params.cursor)
  const cursorClause = decodedCursor ? getDuckdbReviewedPageCursorWhereClause(decodedCursor) : null
  const rows = await runDuckdbJsonQuery<{
    id: string
    articleTitle: string
    articleCreatedAt: unknown
    articleUpdatedAt: unknown
    sourceMetadata: unknown
  }>(`
    WITH scope_article_ids AS (
      ${sections.scopeArticleIdsQuery}
    ),
    filtered_scope_article_ids AS (
      SELECT a.id AS articleId
      FROM app.article a
      INNER JOIN scope_article_ids s ON s.articleId = a.id
      ${sections.filteredScopeWhereClause}
    ),
    reviewed_article_ids AS (
      SELECT j.article_id AS articleId
      FROM app.judgment j
      INNER JOIN filtered_scope_article_ids s ON s.articleId = j.article_id
      WHERE ${sections.judgmentsWhereClause}
      GROUP BY j.article_id
      HAVING ${sections.havingClause}
    )
    SELECT
      a.id AS id,
      a.article_title AS articleTitle,
      a.article_created_at AS articleCreatedAt,
      a.article_updated_at AS articleUpdatedAt,
      a.source_metadata AS sourceMetadata
    FROM reviewed_article_ids r
    INNER JOIN app.article a ON a.id = r.articleId
    ${cursorClause ? `WHERE ${cursorClause}` : ''}
    ORDER BY a.article_created_at DESC NULLS LAST, a.id ASC
    LIMIT ${params.limit + 1}
    OFFSET ${offset}
  `)

  const hasMore = rows.length > params.limit
  const pageRows = rows.slice(0, params.limit)
  const lastRow = pageRows[pageRows.length - 1]

  return {
    nextCursor:
      hasMore && lastRow
        ? encodeReviewPageCursor({
            articleCreatedAt: getDuckdbDateValue(lastRow.articleCreatedAt)?.toISOString() ?? null,
            articleId: lastRow.id,
          })
        : null,
    rows: pageRows.map((row) => {
      return {
        id: row.id,
        articleTitle: row.articleTitle,
        articleCreatedAt: getDuckdbDateValue(row.articleCreatedAt),
        articleUpdatedAt: getDuckdbDateValue(row.articleUpdatedAt),
        sourceMetadata: getDuckdbArticleSourceMetadata(row.sourceMetadata),
      }
    }),
  }
}

const countDuckdbReviewedArticles = async (params: {
  scope: ProjectOlapScope
  hasDuplicateStudyRecords?: boolean
  hasStudyDecisionConflict?: boolean
  from?: string | null
  to?: string | null
  search?: string | null
  prompts?: Record<string, string[]>
}) => {
  const sections = getDuckdbReviewedArticlesQuerySections(params)
  const rows = await runDuckdbJsonQuery<{totalCount: number}>(`
    WITH scope_article_ids AS (
      ${sections.scopeArticleIdsQuery}
    ),
    filtered_scope_article_ids AS (
      SELECT a.id AS articleId
      FROM app.article a
      INNER JOIN scope_article_ids s ON s.articleId = a.id
      ${sections.filteredScopeWhereClause}
    ),
    reviewed_article_ids AS (
      SELECT j.article_id AS articleId
      FROM app.judgment j
      INNER JOIN filtered_scope_article_ids s ON s.articleId = j.article_id
      WHERE ${sections.judgmentsWhereClause}
      GROUP BY j.article_id
      HAVING ${sections.havingClause}
    )
    SELECT COUNT(*) AS totalCount
    FROM reviewed_article_ids
  `)

  return Number(rows[0]?.totalCount ?? 0)
}

const getActivitySortMs = (article: ScopedArticleRow) => {
  return (article.articleUpdatedAt ?? article.articleCreatedAt ?? article.createdAt).getTime()
}

const getActivityDate = (article: Pick<ScopedArticleRow, 'createdAt' | 'articleCreatedAt' | 'articleUpdatedAt'>) => {
  return article.articleUpdatedAt ?? article.articleCreatedAt ?? article.createdAt
}

const getDuckdbActivityTimestampExpression = (rowAlias: string) => {
  return `COALESCE(${rowAlias}.article_updated_at, ${rowAlias}.article_created_at, ${rowAlias}.created_at, TIMESTAMPTZ '1970-01-01T00:00:00.000Z')`
}

const getDuckdbActivityCursorWhereClause = (rowAlias: string, cursor: PaginationCursor) => {
  const timestampExpression = getDuckdbActivityTimestampExpression(rowAlias)

  return `(
    ${timestampExpression} < ${getDuckdbTimestampLiteral(cursor.lastDate)}
    OR (
      ${timestampExpression} = ${getDuckdbTimestampLiteral(cursor.lastDate)}
      AND ${rowAlias}.id < ${getDuckdbSqlString(cursor.lastArticleId)}
    )
  )`
}

const getCreatedSortMs = (article: ScopedArticleRow) => {
  return article.articleCreatedAt?.getTime() ?? null
}

const sortArticlesByCreated = (rows: ScopedArticleRow[]) => {
  return [...rows].sort((left, right) => {
    const leftCreatedMs = getCreatedSortMs(left)
    const rightCreatedMs = getCreatedSortMs(right)
    return leftCreatedMs === null && rightCreatedMs === null
      ? left.id.localeCompare(right.id)
      : leftCreatedMs === null
        ? 1
        : rightCreatedMs === null
          ? -1
          : rightCreatedMs !== leftCreatedMs
            ? rightCreatedMs - leftCreatedMs
            : left.id.localeCompare(right.id)
  })
}

const sortArticlesByActivity = (rows: ScopedArticleRow[]) => {
  return [...rows].sort((left, right) => {
    const diff = getActivitySortMs(right) - getActivitySortMs(left)
    return diff !== 0 ? diff : right.id.localeCompare(left.id)
  })
}

const groupByArticleId = <T extends {articleId: string}>(rows: T[]) => {
  return rows.reduce<Map<string, T[]>>((rowMap, row) => {
    const currentRows = rowMap.get(row.articleId) ?? []
    currentRows.push(row)
    rowMap.set(row.articleId, currentRows)
    return rowMap
  }, new Map<string, T[]>())
}

const getHasAllProjectPrompts = (promptIds: string[], rows: Array<{promptId: string}>) => {
  const promptIdSet = new Set(
    rows.map((row) => {
      return row.promptId
    }),
  )
  return promptIds.every((promptId) => {
    return promptIdSet.has(promptId)
  })
}

const getMatchesPromptFilters = (
  rows: Array<{promptId: string; answeredOriginal: string | null; answeredOriginalAsArray?: string[] | null}>,
  promptFilters: Array<[string, string[]]>,
) => {
  return promptFilters.every(([promptId, answers]) => {
    return rows.some((row) => {
      return row.promptId === promptId && hasMatchingJudgmentAnswer(row, answers)
    })
  })
}

const getHasHumanAnswer = (value: string | null) => {
  return (value?.trim() ?? '') !== ''
}

const getLatestHumanAnswerRows = (rows: HumanAnswerRow[]) => {
  return rows.reduce<Map<string, HumanAnswerRow>>((rowMap, row) => {
    const key = `${row.articleId}:${row.promptId}`
    const existing = rowMap.get(key)
    const rowUpdatedAtMs = row.updatedAt?.getTime() ?? 0
    const existingUpdatedAtMs = existing?.updatedAt?.getTime() ?? 0

    if (!existing || rowUpdatedAtMs >= existingUpdatedAtMs) {
      rowMap.set(key, row)
    }

    return rowMap
  }, new Map<string, HumanAnswerRow>())
}

const getHumanRowsByArticleId = (rows: HumanAnswerRow[]) => {
  return Array.from(getLatestHumanAnswerRows(rows).values()).reduce<Map<string, HumanAnswerRow[]>>((rowMap, row) => {
    const currentRows = rowMap.get(row.articleId) ?? []
    currentRows.push(row)
    rowMap.set(row.articleId, currentRows)
    return rowMap
  }, new Map<string, HumanAnswerRow[]>())
}

const getHumanAnswersByPrompt = (promptIds: string[], rows: HumanAnswerRow[]): HumanAnswersByPrompt | null => {
  const promptMap = promptIds.reduce<HumanAnswersByPrompt>((map, promptId) => {
    return {...map, [promptId]: []}
  }, {})
  const nextMap = rows.reduce<HumanAnswersByPrompt>((map, row) => {
    return getHasHumanAnswer(row.answer)
      ? {...map, [row.promptId]: [...(map[row.promptId] ?? []), row.answer?.trim() ?? '']}
      : map
  }, promptMap)

  return promptIds.every((promptId) => {
    return (nextMap[promptId] ?? []).length > 0
  })
    ? nextMap
    : null
}

const getSummaryCriteria = (scope: ProjectOlapScope) => {
  return scope.promptRows.map((row) => {
    return {promptId: row.id, criteriaDisposition: row.criteriaDisposition}
  })
}

const getLatestRowsByPromptId = <T extends {createdAt: string; promptId: string}>(rows: T[]) => {
  return rows.reduce<Map<string, T>>((rowMap, row) => {
    const existing = rowMap.get(row.promptId)

    if (!existing || row.createdAt >= existing.createdAt) {
      rowMap.set(row.promptId, row)
    }

    return rowMap
  }, new Map<string, T>())
}

const getLlmSummaryAnswer = (scope: ProjectOlapScope, rows: ArticlesReviewsBothJudgmentRow[] | OlapJudgmentRow[]) => {
  if (scope.humanJudgmentMode !== 'summary') {
    return null
  }

  const normalizedAnswers = Array.from(getLatestRowsByPromptId(rows).values()).reduce<
    Record<string, 'yes' | 'no' | 'maybe' | null>
  >((answerMap, row) => {
    return {...answerMap, [row.promptId]: getNormalizedSummaryAnswer(row)}
  }, {})

  return deriveStrictSummaryAnswer(getSummaryCriteria(scope), normalizedAnswers)
}

const getHumanSummaryRowsByArticleId = (rows: HumanSummaryRow[]) => {
  return rows.reduce<Map<string, HumanSummaryRow>>((rowMap, row) => {
    const existing = rowMap.get(row.articleId)
    const rowUpdatedAtMs = row.updatedAt?.getTime() ?? 0
    const existingUpdatedAtMs = existing?.updatedAt?.getTime() ?? 0

    return rowUpdatedAtMs >= existingUpdatedAtMs ? rowMap.set(row.articleId, row) : rowMap
  }, new Map<string, HumanSummaryRow>())
}

const getHumanSummaryAnswer = (row: HumanSummaryRow | undefined) => {
  return normalizeSummaryAnswerValue(row?.answer ?? null)
}

const getJudgmentRowsSorted = (rows: OlapJudgmentRow[], promptOrderMap: Record<string, number>) => {
  return [...rows].sort((left, right) => {
    const leftOrder = promptOrderMap[left.promptId] ?? Number.MAX_SAFE_INTEGER
    const rightOrder = promptOrderMap[right.promptId] ?? Number.MAX_SAFE_INTEGER
    return leftOrder !== rightOrder
      ? leftOrder - rightOrder
      : left.createdAt !== right.createdAt
        ? right.createdAt.localeCompare(left.createdAt)
        : left.id.localeCompare(right.id)
  })
}

const getJudgedPromptIds = (rows: Array<{promptId: string}>, promptOrderMap: Record<string, number>) => {
  return Array.from(
    new Set(
      rows.map((row) => {
        return row.promptId
      }),
    ),
  ).sort((left, right) => {
    const leftOrder = promptOrderMap[left] ?? Number.MAX_SAFE_INTEGER
    const rightOrder = promptOrderMap[right] ?? Number.MAX_SAFE_INTEGER
    return leftOrder - rightOrder
  })
}

const toOlapJudgmentRow = (row: {
  id: string
  createdAt: Date
  articleId: string
  articleTitle: string
  articleCreatedAt: Date | null
  articleUpdatedAt: Date | null
  articleImportRoute: string | null
  promptId: string
  modelId: string
  answeredOriginal: string | null
  answeredOriginalAsArray: string[] | null
  explanation: string | null
  quotes: unknown
}): OlapJudgmentRow => {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    articleId: row.articleId,
    articleTitle: row.articleTitle,
    articleCreatedAt: row.articleCreatedAt ? row.articleCreatedAt.toISOString() : null,
    articleUpdatedAt: row.articleUpdatedAt ? row.articleUpdatedAt.toISOString() : null,
    articleCreatedYear: row.articleCreatedAt ? row.articleCreatedAt.getUTCFullYear() : null,
    articleUpdatedYear: row.articleUpdatedAt ? row.articleUpdatedAt.getUTCFullYear() : null,
    articleImportRoute: row.articleImportRoute,
    articleImportedBy: null,
    promptId: row.promptId,
    modelId: row.modelId,
    answeredOriginal: row.answeredOriginal,
    answeredOriginalAsArray: row.answeredOriginalAsArray ?? [],
    explanation: row.explanation,
    quotes: Array.isArray(row.quotes) ? row.quotes : [],
  }
}

const getProjectOlapScope = async (projectId: string): Promise<ProjectOlapScope | null> => {
  const [promptRows, projectRows, routeRows] = await Promise.all([
    runDuckdbJsonQuery<{
      id: string
      order: number | null
      promptHeading: string | null
      originalText: string
      type: string | null
      criteriaDisposition: 'include' | 'exclude' | null
    }>(`
      SELECT
        p.id AS id,
        pp.prompt_order AS "order",
        p.prompt_heading AS promptHeading,
        p.original_text AS originalText,
        p.type AS type,
        pp.criteria_disposition AS criteriaDisposition
      FROM app.project_prompt pp
      INNER JOIN app.prompt p ON p.id = pp.prompt_id
      WHERE pp.project_id = ${getDuckdbSqlString(projectId)}
        AND pp.enabled = TRUE
      ORDER BY pp.prompt_order ASC NULLS LAST, p.created_at ASC
    `),
    runDuckdbJsonQuery<{
      id: string
      dateFrom: unknown
      dateTo: unknown
      humanJudgmentMode: 'prompt' | 'summary' | null
      modelId: string | null
      useTitle: unknown
      useAbstract: unknown
      useFulltext: unknown
      useFulltextNoImages: unknown
    }>(`
      SELECT
        id,
        date_from AS dateFrom,
        date_to AS dateTo,
        human_judgment_mode AS humanJudgmentMode,
        model_id AS modelId,
        use_title AS useTitle,
        use_abstract AS useAbstract,
        use_fulltext AS useFulltext,
        use_fulltext_no_images AS useFulltextNoImages
      FROM app.project
      WHERE id = ${getDuckdbSqlString(projectId)}
      LIMIT 1
    `),
    runDuckdbJsonQuery<{importRouteId: string}>(`
      SELECT import_route_id AS importRouteId
      FROM app.project_import_route
      WHERE project_id = ${getDuckdbSqlString(projectId)}
    `),
  ])
  const projectRow = projectRows[0]

  return projectRow
    ? {
        projectId,
        humanJudgmentMode: projectRow.humanJudgmentMode ?? 'prompt',
        promptRows,
        promptIds: promptRows.map((row) => {
          return row.id
        }),
        promptOrderMap: getPromptOrderMap(promptRows),
        promptNameById: getPromptNameById(promptRows),
        routeIds: routeRows.map((row) => {
          return row.importRouteId
        }),
        dateFrom: getDuckdbDateValue(projectRow.dateFrom),
        dateTo: getDuckdbDateValue(projectRow.dateTo),
        modelId: projectRow.modelId,
        useTitle: getDuckdbBooleanValue(projectRow.useTitle, true),
        useAbstract: getDuckdbBooleanValue(projectRow.useAbstract, true),
        useFulltext: getDuckdbBooleanValue(projectRow.useFulltext, false),
        useFulltextNoImages: getDuckdbBooleanValue(projectRow.useFulltextNoImages, false),
      }
    : null
}

const getScopedArticles = async (params: {
  scope: ProjectOlapScope
  hasDuplicateStudyRecords?: boolean
  hasStudyDecisionConflict?: boolean
  from?: string | null
  to?: string | null
  search?: string | null
  orderBy: 'created' | 'activity'
}) => {
  const requestFromDate = parseDateFromInput(params.from, 'T00:00:00.000Z')
  const requestToDate = parseDateFromInput(params.to, 'T23:59:59.999Z')
  const effectiveFromDate = getEffectiveFromDate(params.scope.dateFrom, requestFromDate)
  const effectiveToDate = getEffectiveToDate(params.scope.dateTo, requestToDate)
  const trimmedSearch = params.search?.trim() ?? ''
  const whereParts = [
    getDuckdbScopeClause({articleAlias: 'a', routeIds: params.scope.routeIds, projectId: params.scope.projectId}),
  ]

  if (effectiveFromDate) {
    whereParts.push(`a.article_created_at >= ${getDuckdbTimestampLiteral(effectiveFromDate)}`)
  }
  if (effectiveToDate) {
    whereParts.push(`a.article_created_at <= ${getDuckdbTimestampLiteral(effectiveToDate)}`)
  }
  if (trimmedSearch) {
    whereParts.push(`LOWER(COALESCE(a.article_title, '')) LIKE LOWER(${getDuckdbSqlString(`%${trimmedSearch}%`)})`)
  }

  const rows = await runDuckdbJsonQuery<{
    id: string
    createdAt: unknown
    updatedAt: unknown
    articleId: string | null
    articleTitle: string
    articleCreatedAt: unknown
    articleUpdatedAt: unknown
    importRoute: string | null
    url: string | null
    fullTextPDF: string | null
    fullTextFetchedAt: unknown
    fullTextConversionStatus: string | null
    sourceMetadata: unknown
  }>(`
    SELECT
      a.id AS id,
      a.created_at AS createdAt,
      a.updated_at AS updatedAt,
      a.article_id AS articleId,
      a.article_title AS articleTitle,
      a.article_created_at AS articleCreatedAt,
      a.article_updated_at AS articleUpdatedAt,
      a.import_route AS importRoute,
      a.url AS url,
      a.full_text_pdf AS fullTextPDF,
      a.full_text_fetched_at AS fullTextFetchedAt,
      a.full_text_conversion_status AS fullTextConversionStatus,
      a.source_metadata AS sourceMetadata
    FROM app.article a
    WHERE ${whereParts.join(' AND ')}
  `)

  const normalizedRows = rows.map<ScopedArticleRow>((row) => {
    return {
      id: row.id,
      createdAt: getDuckdbDateValue(row.createdAt) ?? new Date(0),
      updatedAt: getDuckdbDateValue(row.updatedAt) ?? new Date(0),
      articleId: row.articleId,
      articleTitle: row.articleTitle,
      articleCreatedAt: getDuckdbDateValue(row.articleCreatedAt),
      articleUpdatedAt: getDuckdbDateValue(row.articleUpdatedAt),
      importRoute: row.importRoute,
      url: row.url,
      fullTextPDF: row.fullTextPDF,
      fullTextFetchedAt: getDuckdbDateValue(row.fullTextFetchedAt),
      fullTextConversionStatus: row.fullTextConversionStatus,
      sourceMetadata: getDuckdbArticleSourceMetadata(row.sourceMetadata),
    }
  })
  const covidenceFilteredRows = normalizedRows.filter((row) => {
    return getMatchesCovidenceSourceMetadataFilters({
      sourceMetadata: row.sourceMetadata,
      hasDuplicateStudyRecords: params.hasDuplicateStudyRecords,
      hasStudyDecisionConflict: params.hasStudyDecisionConflict,
    })
  })

  return params.orderBy === 'activity'
    ? sortArticlesByActivity(covidenceFilteredRows)
    : sortArticlesByCreated(covidenceFilteredRows)
}

const rawUnassessedArticleWindowSize = 1000

const getScopedActivityArticleWindow = async (params: {
  scope: ProjectOlapScope
  cursor: PaginationCursor | null
  limit: number
}) => {
  const normalizedLimit = Math.max(1, Math.trunc(params.limit))
  const whereParts = [
    getDuckdbScopeClause({articleAlias: 'a', routeIds: params.scope.routeIds, projectId: params.scope.projectId}),
  ]
  const cursorClause = params.cursor ? getDuckdbActivityCursorWhereClause('a', params.cursor) : null

  if (cursorClause) {
    whereParts.push(cursorClause)
  }

  const rows = await runDuckdbJsonQuery<{
    id: string
    createdAt: unknown
    articleCreatedAt: unknown
    articleUpdatedAt: unknown
  }>(`
    SELECT
      a.id AS id,
      a.created_at AS createdAt,
      a.article_created_at AS articleCreatedAt,
      a.article_updated_at AS articleUpdatedAt
    FROM app.article a
    WHERE ${whereParts.join(' AND ')}
    ORDER BY ${getDuckdbActivityTimestampExpression('a')} DESC, a.id DESC
    LIMIT ${normalizedLimit + 1}
  `)
  const hasMore = rows.length > normalizedLimit

  return {
    hasMore,
    rows: rows.slice(0, normalizedLimit).map((row) => {
      return {
        id: row.id,
        createdAt: getDuckdbDateValue(row.createdAt) ?? new Date(0),
        articleCreatedAt: getDuckdbDateValue(row.articleCreatedAt),
        articleUpdatedAt: getDuckdbDateValue(row.articleUpdatedAt),
      }
    }),
  }
}

const getLlmJudgmentRows = async (scope: ProjectOlapScope, articleIds: string[]): Promise<OlapJudgmentRow[]> => {
  if (articleIds.length === 0 || scope.promptIds.length === 0) {
    return []
  }

  const whereParts = [
    `j.article_id IN (${getDuckdbSqlStringList(articleIds).join(', ')})`,
    `j.prompt_id IN (${getDuckdbSqlStringList(scope.promptIds).join(', ')})`,
    getDuckdbJudgmentProjectWhereClause({judgmentAlias: 'j', projectId: scope.projectId}),
    scope.modelId ? `j.model_id = ${getDuckdbSqlString(scope.modelId)}` : null,
    `j.use_title = ${getDuckdbSqlBoolean(scope.useTitle)}`,
    `j.use_abstract = ${getDuckdbSqlBoolean(scope.useAbstract)}`,
    `j.use_fulltext = ${getDuckdbSqlBoolean(scope.useFulltext)}`,
    `j.use_fulltext_no_images = ${getDuckdbSqlBoolean(scope.useFulltextNoImages)}`,
    'j.deleted_at IS NULL',
  ].filter((part): part is string => {
    return part !== null
  })
  const rows = await runDuckdbJsonQuery<{
    id: string
    createdAt: unknown
    articleId: string
    articleTitle: string
    articleCreatedAt: unknown
    articleUpdatedAt: unknown
    articleImportRoute: string | null
    promptId: string
    modelId: string
    answeredOriginal: string | null
    answeredOriginalAsArray: unknown
    explanation: string | null
    quotes: unknown
  }>(`
    SELECT
      j.id AS id,
      j.created_at AS createdAt,
      j.article_id AS articleId,
      a.article_title AS articleTitle,
      a.article_created_at AS articleCreatedAt,
      a.article_updated_at AS articleUpdatedAt,
      a.import_route AS articleImportRoute,
      j.prompt_id AS promptId,
      j.model_id AS modelId,
      j.answered_original AS answeredOriginal,
      TO_JSON(j.answered_original_as_array) AS answeredOriginalAsArray,
      j.explanation AS explanation,
      TO_JSON(j.quotes) AS quotes
    FROM app.judgment j
    INNER JOIN app.article a ON a.id = j.article_id
    WHERE ${whereParts.join('\n      AND ')}
  `)

  return rows.map((row) => {
    const answerArray = getDuckdbJsonValue(row.answeredOriginalAsArray)
    return toOlapJudgmentRow({
      ...row,
      createdAt: getDuckdbDateValue(row.createdAt) ?? new Date(0),
      articleCreatedAt: getDuckdbDateValue(row.articleCreatedAt),
      articleUpdatedAt: getDuckdbDateValue(row.articleUpdatedAt),
      answeredOriginalAsArray: Array.isArray(answerArray)
        ? answerArray.filter((value): value is string => {
            return typeof value === 'string'
          })
        : null,
      quotes: getDuckdbJsonValue(row.quotes),
    })
  })
}

const getLlmJudgedPromptRows = async (
  scope: ProjectOlapScope,
  articleIds: string[],
): Promise<Array<{articleId: string; promptId: string}>> => {
  if (articleIds.length === 0 || scope.promptIds.length === 0) {
    return []
  }

  return runDuckdbJsonQuery<{articleId: string; promptId: string}>(`
    SELECT
      j.article_id AS articleId,
      j.prompt_id AS promptId
    FROM app.judgment j
    WHERE j.article_id IN (${getDuckdbSqlStringList(articleIds).join(', ')})
      AND j.prompt_id IN (${getDuckdbSqlStringList(scope.promptIds).join(', ')})
      AND ${getDuckdbJudgmentProjectWhereClause({judgmentAlias: 'j', projectId: scope.projectId})}
      AND j.model_id = ${getDuckdbSqlString(scope.modelId ?? '')}
      AND j.use_title = ${getDuckdbSqlBoolean(scope.useTitle)}
      AND j.use_abstract = ${getDuckdbSqlBoolean(scope.useAbstract)}
      AND j.use_fulltext = ${getDuckdbSqlBoolean(scope.useFulltext)}
      AND j.use_fulltext_no_images = ${getDuckdbSqlBoolean(scope.useFulltextNoImages)}
      AND j.deleted_at IS NULL
  `)
}

const getRawUnassessedCandidateRows = async (params: {
  jobId: string
  cursor: PaginationCursor | null
  limit: number
  scope: ProjectOlapScope
}): Promise<{hasMore: boolean; rows: UnassessedCandidateRow[]}> => {
  const normalizedLimit = Math.max(1, Math.trunc(params.limit))
  const startedAtMs = Date.now()

  rawFallbackQueueLogger.log(`getPrompts:raw-fallback:${params.jobId}:start`, '[getPrompts] raw fallback scan start', {
    candidateLimit: normalizedLimit,
    cursor: getPaginationCursorSummary(params.cursor),
    jobId: params.jobId,
    projectId: params.scope.projectId,
  })

  const collectWindow = async ({
    collectedRows,
    cursor,
    scannedArticleCount,
    totalJudgedPromptRows,
    windowsScanned,
  }: {
    collectedRows: UnassessedCandidateRow[]
    cursor: PaginationCursor | null
    scannedArticleCount: number
    totalJudgedPromptRows: number
    windowsScanned: number
  }): Promise<{hasMore: boolean; rows: UnassessedCandidateRow[]}> => {
    const remainingLimit = normalizedLimit - collectedRows.length
    const articleWindowStartedAtMs = Date.now()
    const articleWindow = await getScopedActivityArticleWindow({
      scope: params.scope,
      cursor,
      limit: Math.min(rawUnassessedArticleWindowSize, remainingLimit),
    })
    const articleWindowMs = Date.now() - articleWindowStartedAtMs
    const judgmentQueryStartedAtMs = Date.now()
    const llmJudgedPromptRows = await getLlmJudgedPromptRows(
      params.scope,
      articleWindow.rows.map((article) => {
        return article.id
      }),
    )
    const judgmentQueryMs = Date.now() - judgmentQueryStartedAtMs
    const llmJudgmentsByArticle = groupByArticleId(llmJudgedPromptRows)
    const nextCollectedRows = [
      ...collectedRows,
      ...articleWindow.rows.flatMap<UnassessedCandidateRow>((article) => {
        const articleJudgments = llmJudgmentsByArticle.get(article.id) ?? []

        return !getHasAllProjectPrompts(params.scope.promptIds, articleJudgments)
          ? [
              {
                articleId: article.id,
                articleCreatedAt: article.articleCreatedAt,
                articleUpdatedAt: article.articleUpdatedAt,
                llmJudgedPromptIds: getJudgedPromptIds(articleJudgments, params.scope.promptOrderMap),
              },
            ]
          : []
      }),
    ]
    const nextScannedArticleCount = scannedArticleCount + articleWindow.rows.length
    const nextTotalJudgedPromptRows = totalJudgedPromptRows + llmJudgedPromptRows.length
    const nextWindowsScanned = windowsScanned + 1
    const lastWindowArticle = articleWindow.rows[articleWindow.rows.length - 1] ?? null
    const nextCursor = lastWindowArticle
      ? {lastArticleId: lastWindowArticle.id, lastDate: getActivityDate(lastWindowArticle)}
      : null

    if (articleWindowMs > 1_000 || judgmentQueryMs > 1_000) {
      rawFallbackQueueLogger.warn(
        `getPrompts:raw-fallback:${params.jobId}:slow-window`,
        '[getPrompts] raw fallback slow window',
        {
          articleWindowMs,
          articlesScannedInWindow: articleWindow.rows.length,
          collectedCandidates: nextCollectedRows.length,
          cursor: getPaginationCursorSummary(cursor),
          hasMore: articleWindow.hasMore,
          jobId: params.jobId,
          judgedPromptRowsInWindow: llmJudgedPromptRows.length,
          judgmentQueryMs,
          projectId: params.scope.projectId,
          windowsScanned: nextWindowsScanned,
        },
      )
    }

    if (nextCollectedRows.length >= normalizedLimit || !articleWindow.hasMore || nextCursor === null) {
      rawFallbackQueueLogger.log(
        `getPrompts:raw-fallback:${params.jobId}:complete`,
        '[getPrompts] raw fallback scan complete',
        {
          candidateLimit: normalizedLimit,
          candidateRows: nextCollectedRows.length,
          durationMs: Date.now() - startedAtMs,
          finalCursor: getPaginationCursorSummary(nextCursor),
          hasMore: articleWindow.hasMore,
          jobId: params.jobId,
          projectId: params.scope.projectId,
          scannedArticles: nextScannedArticleCount,
          totalJudgedPromptRows: nextTotalJudgedPromptRows,
          windowsScanned: nextWindowsScanned,
        },
      )

      return {hasMore: articleWindow.hasMore, rows: nextCollectedRows}
    }

    return collectWindow({
      collectedRows: nextCollectedRows,
      cursor: nextCursor,
      scannedArticleCount: nextScannedArticleCount,
      totalJudgedPromptRows: nextTotalJudgedPromptRows,
      windowsScanned: nextWindowsScanned,
    })
  }

  return collectWindow({
    collectedRows: [],
    cursor: params.cursor,
    scannedArticleCount: 0,
    totalJudgedPromptRows: 0,
    windowsScanned: 0,
  })
}

const getHumanAnswerRows = async (scope: ProjectOlapScope, articleIds: string[]): Promise<HumanAnswerRow[]> => {
  if (scope.humanJudgmentMode === 'summary' || articleIds.length === 0 || scope.promptIds.length === 0) {
    return []
  }

  const rows = await runDuckdbJsonQuery<{
    articleId: string
    promptId: string
    answer: string | null
    updatedAt: unknown
  }>(`
    SELECT
      article_id AS articleId,
      prompt_id AS promptId,
      answer,
      updated_at AS updatedAt
    FROM app.judgment_human
    WHERE project_id = ${getDuckdbSqlString(scope.projectId)}
      AND is_answered = TRUE
      AND article_id IN (${getDuckdbSqlStringList(articleIds).join(', ')})
      AND prompt_id IN (${getDuckdbSqlStringList(scope.promptIds).join(', ')})
  `)

  return rows.map((row) => {
    return {...row, updatedAt: getDuckdbDateValue(row.updatedAt)}
  })
}

const getHumanSummaryRows = async (scope: ProjectOlapScope, articleIds: string[]): Promise<HumanSummaryRow[]> => {
  if (scope.humanJudgmentMode !== 'summary' || articleIds.length === 0) {
    return []
  }

  const rows = await runDuckdbJsonQuery<{articleId: string; answer: string | null; updatedAt: unknown}>(`
    SELECT
      article_id AS articleId,
      answer,
      updated_at AS updatedAt
    FROM app.judgment_human_summary
    WHERE project_id = ${getDuckdbSqlString(scope.projectId)}
      AND article_id IN (${getDuckdbSqlStringList(articleIds).join(', ')})
      AND NULLIF(TRIM(COALESCE(answer, '')), '') IS NOT NULL
  `)

  return rows.map((row) => {
    return {...row, updatedAt: getDuckdbDateValue(row.updatedAt)}
  })
}

const getLlmReviewedArticleRows = async (params: {
  scope: ProjectOlapScope
  hasDuplicateStudyRecords?: boolean
  hasStudyDecisionConflict?: boolean
  from?: string | null
  to?: string | null
  search?: string | null
  prompts?: Record<string, string[]>
  requireAllLlmJudgments?: boolean
}) => {
  const scopedArticles = await getScopedArticles({...params, orderBy: 'created'})
  const llmJudgmentRows = await getLlmJudgmentRows(
    params.scope,
    scopedArticles.map((article) => {
      return article.id
    }),
  )
  const llmJudgmentsByArticle = groupByArticleId(llmJudgmentRows)
  const promptFilters = getPromptFilters(params.prompts)
  const filteredArticles = scopedArticles.filter((article) => {
    const articleJudgments = llmJudgmentsByArticle.get(article.id) ?? []
    const hasRequiredLlmJudgments = params.requireAllLlmJudgments
      ? getHasAllProjectPrompts(params.scope.promptIds, articleJudgments)
      : articleJudgments.length > 0

    return hasRequiredLlmJudgments && getMatchesPromptFilters(articleJudgments, promptFilters)
  })

  return {scopedArticles: filteredArticles, llmJudgmentsByArticle}
}

const getUnassessedArticleRows = async (params: {
  scope: ProjectOlapScope
  hasDuplicateStudyRecords?: boolean
  hasStudyDecisionConflict?: boolean
  from?: string | null
  to?: string | null
  search?: string | null
}) => {
  const scopedArticles = await getScopedArticles({...params, orderBy: 'activity'})
  const llmJudgmentRows = await getLlmJudgmentRows(
    params.scope,
    scopedArticles.map((article) => {
      return article.id
    }),
  )
  const llmJudgmentsByArticle = groupByArticleId(llmJudgmentRows)
  const filteredArticles = scopedArticles.filter((article) => {
    const articleJudgments = llmJudgmentsByArticle.get(article.id) ?? []
    return !getHasAllProjectPrompts(params.scope.promptIds, articleJudgments)
  })

  return {scopedArticles: filteredArticles, llmJudgmentsByArticle}
}

export const queryArticlesReviewsFromDuckdb = async (
  params: ArticlesReviewsParams,
): Promise<ArticlesReviewsResponse> => {
  const scope = await getProjectOlapScope(params.projectId)

  if (!scope || scope.promptIds.length === 0) {
    return {data: [], totalCount: 0, page: params.page, limit: params.limit, totalPages: 0}
  }

  const hasPromptFilters = getHasPromptFilters(params.prompts)
  const canUseServingV3 =
    scope.modelId
    && (await getHasReviewArticleServingRows(scope))
    && (!hasPromptFilters || (await getHasReviewArticleFilterMemberRows(scope.projectId)))

  if (canUseServingV3) {
    const pageResult = await getReviewedPageRowsFromServingMart({...params, scope})
    const llmJudgmentRows = await getJudgmentRowsForReviews(
      scope,
      pageResult.rows.map((article) => {
        return article.id
      }),
    )
    const llmJudgmentsByArticle = groupByArticleId(llmJudgmentRows)
    const data = pageResult.rows.map((article) => {
      const judgmentsForArticle = getJudgmentRowsSorted(
        llmJudgmentsByArticle.get(article.id) ?? [],
        scope.promptOrderMap,
      )
      const judgedPromptIds = getJudgedPromptIds(judgmentsForArticle, scope.promptOrderMap)

      return {
        id: article.id,
        articleTitle: article.articleTitle,
        articleCreatedAt: article.articleCreatedAt,
        articleUpdatedAt: article.articleUpdatedAt,
        articleId: article.articleId,
        url: article.url,
        fullTextPDF: article.fullTextPDF,
        fullTextFetchedAt: article.fullTextFetchedAt,
        fullTextConversionStatus: article.fullTextConversionStatus,
        judgments: judgmentsForArticle,
        judgedPromptIds,
        isFullyJudged: judgedPromptIds.length === scope.promptIds.length,
        journalTitle: article.journalTitle,
        sourceMetadata: article.sourceMetadata,
      }
    })

    return {
      data,
      totalCount: null,
      page: params.page,
      limit: params.limit,
      totalPages: null,
      nextCursor: pageResult.nextCursor,
    }
  }

  const pageResult = await getDuckdbReviewedPageRows({...params, scope})
  const llmJudgmentRows = await getLlmJudgmentRows(
    scope,
    pageResult.rows.map((article) => {
      return article.id
    }),
  )
  const llmJudgmentsByArticle = groupByArticleId(llmJudgmentRows)
  const data = pageResult.rows.map((article) => {
    const judgmentsForArticle = getJudgmentRowsSorted(llmJudgmentsByArticle.get(article.id) ?? [], scope.promptOrderMap)
    const judgedPromptIds = getJudgedPromptIds(judgmentsForArticle, scope.promptOrderMap)

    return {
      id: article.id,
      articleTitle: article.articleTitle,
      articleCreatedAt: article.articleCreatedAt,
      articleUpdatedAt: article.articleUpdatedAt,
      judgments: judgmentsForArticle,
      judgedPromptIds,
      isFullyJudged: judgedPromptIds.length === scope.promptIds.length,
      journalTitle: article.sourceMetadata.journalTitle,
      sourceMetadata: article.sourceMetadata,
    }
  })

  return {
    data,
    totalCount: null,
    page: params.page,
    limit: params.limit,
    totalPages: null,
    nextCursor: pageResult.nextCursor,
  }
}

export const countArticlesReviewsFromDuckdb = async (
  params: ArticlesReviewsCountParams,
): Promise<ArticlesReviewsCountResponse> => {
  const scope = await getProjectOlapScope(params.projectId)

  if (!scope || scope.promptIds.length === 0) {
    return {totalCount: 0, totalPages: 0}
  }

  const hasPromptFilters = getHasPromptFilters(params.prompts)
  const canUseServingV3 =
    scope.modelId
    && (await getHasReviewArticleServingRows(scope))
    && (!hasPromptFilters || (await getHasReviewArticleFilterMemberRows(scope.projectId)))

  if (canUseServingV3) {
    const totalCount = await countReviewedServingRows({...params, scope})
    return {totalCount, totalPages: Math.ceil(totalCount / params.limit)}
  }

  const totalCount = await countDuckdbReviewedArticles({...params, scope})
  return {totalCount, totalPages: Math.ceil(totalCount / params.limit)}
}

export const queryArticlesReviewsBothFromDuckdb = async (
  params: ArticlesReviewsBothParams,
): Promise<ArticlesReviewsBothResponse> => {
  const scope = await getProjectOlapScope(params.projectId)

  if (!scope || scope.promptIds.length === 0) {
    return {data: [], totalCount: 0, page: params.page, limit: params.limit, totalPages: 0}
  }

  if (scope.modelId && (await getHasReviewArticleServingRows(scope))) {
    const {rows: pageArticles, totalCount} = await getBothPageRowsFromServing({...params, scope})
    const totalPages = totalCount > 0 ? Math.ceil(totalCount / params.limit) : 0
    const articleIds = pageArticles.map((article) => {
      return article.id
    })
    const llmJudgmentsByArticle = groupByArticleId(await getJudgmentRowsForReviews(scope, articleIds))
    const humanRowsByArticle = getHumanRowsByArticleId(await getHumanAnswerRows(scope, articleIds))
    const humanSummaryRowsByArticle = getHumanSummaryRowsByArticleId(await getHumanSummaryRows(scope, articleIds))
    const data = pageArticles.map((article) => {
      const llmRows = getJudgmentRowsSorted(llmJudgmentsByArticle.get(article.id) ?? [], scope.promptOrderMap)

      return {
        id: article.id,
        articleTitle: article.articleTitle,
        articleCreatedAt: article.articleCreatedAt,
        articleUpdatedAt: article.articleUpdatedAt,
        judgments: llmRows,
        humanJudgmentMode: scope.humanJudgmentMode,
        humanSummaryAnswer: getHumanSummaryAnswer(humanSummaryRowsByArticle.get(article.id)) ?? undefined,
        llmSummaryAnswer: getLlmSummaryAnswer(scope, llmRows) ?? undefined,
        humanAnswersByPrompt:
          scope.humanJudgmentMode === 'summary'
            ? undefined
            : (getHumanAnswersByPrompt(scope.promptIds, humanRowsByArticle.get(article.id) ?? []) ?? undefined),
        journalTitle: article.sourceMetadata.journalTitle,
        sourceMetadata: article.sourceMetadata,
      }
    })

    return {data, totalCount, page: params.page, limit: params.limit, totalPages}
  }

  const {scopedArticles, llmJudgmentsByArticle} = await getLlmReviewedArticleRows({
    ...params,
    scope,
    requireAllLlmJudgments: true,
  })
  const articleIds = scopedArticles.map((article) => {
    return article.id
  })
  const humanRowsByArticle = getHumanRowsByArticleId(await getHumanAnswerRows(scope, articleIds))
  const humanSummaryRowsByArticle = getHumanSummaryRowsByArticleId(await getHumanSummaryRows(scope, articleIds))
  const filteredArticles = scopedArticles.filter((article) => {
    return scope.humanJudgmentMode === 'summary'
      ? getHumanSummaryAnswer(humanSummaryRowsByArticle.get(article.id)) !== null
      : getHasAllProjectPrompts(
          scope.promptIds,
          (humanRowsByArticle.get(article.id) ?? []).filter((row) => {
            return getHasHumanAnswer(row.answer)
          }),
        )
  })
  const totalCount = filteredArticles.length
  const totalPages = totalCount > 0 ? Math.ceil(totalCount / params.limit) : 0
  const offset = (Math.max(params.page, 1) - 1) * params.limit
  const pageArticles = filteredArticles.slice(offset, offset + params.limit)
  const data = pageArticles.map((article) => {
    const llmRows = getJudgmentRowsSorted(llmJudgmentsByArticle.get(article.id) ?? [], scope.promptOrderMap)
    const humanRows = humanRowsByArticle.get(article.id) ?? []
    return {
      id: article.id,
      articleTitle: article.articleTitle,
      articleCreatedAt: article.articleCreatedAt,
      articleUpdatedAt: article.articleUpdatedAt,
      judgments: llmRows,
      humanJudgmentMode: scope.humanJudgmentMode,
      humanSummaryAnswer: getHumanSummaryAnswer(humanSummaryRowsByArticle.get(article.id)) ?? undefined,
      llmSummaryAnswer: getLlmSummaryAnswer(scope, llmRows) ?? undefined,
      humanAnswersByPrompt:
        scope.humanJudgmentMode === 'summary'
          ? undefined
          : (getHumanAnswersByPrompt(scope.promptIds, humanRows) ?? undefined),
      journalTitle: article.sourceMetadata.journalTitle,
      sourceMetadata: article.sourceMetadata,
    }
  })

  return {data, totalCount, page: params.page, limit: params.limit, totalPages}
}

export const getDatabaseBasedFiltersFromDuckdb = async (
  params: DatabaseFilterParams,
): Promise<DatabaseFilterResult[]> => {
  const scope = await getProjectOlapScope(params.projectId)
  const databasePrompts = getEmptyDatabaseFilters(params.prompts)

  if (!scope || databasePrompts.length === 0) {
    return databasePrompts
  }

  if (!scope.modelId) {
    const scopedArticles = await getScopedArticles({
      scope,
      hasDuplicateStudyRecords: params.hasDuplicateStudyRecords,
      hasStudyDecisionConflict: params.hasStudyDecisionConflict,
      from: params.fromDate ? params.fromDate.toISOString().slice(0, 10) : null,
      to: params.toDate ? params.toDate.toISOString().slice(0, 10) : null,
      search: params.searchTitle,
      orderBy: 'created',
    })
    if (scopedArticles.length === 0) {
      return databasePrompts
    }

    const valuesByPromptId = (
      await getLlmJudgmentRows(
        scope,
        scopedArticles.map((article) => {
          return article.id
        }),
      )
    ).reduce<Map<string, Set<string>>>((rowMap, row) => {
      const currentValues = rowMap.get(row.promptId) ?? new Set<string>()
      const answerValues =
        row.answeredOriginalAsArray.length > 0 ? row.answeredOriginalAsArray : [row.answeredOriginal ?? '']

      answerValues.forEach((answerValue) => {
        const trimmedValue = answerValue.trim()

        if (trimmedValue !== '') {
          currentValues.add(trimmedValue)
        }
      })
      rowMap.set(row.promptId, currentValues)
      return rowMap
    }, new Map<string, Set<string>>())

    return databasePrompts.map((prompt) => {
      const values = Array.from(valuesByPromptId.get(prompt.promptId) ?? []).sort((left, right) => {
        return left.localeCompare(right)
      })
      return {promptId: prompt.promptId, promptName: prompt.promptName, answeredOriginalValues: values}
    })
  }

  const promptIds = databasePrompts.map((prompt) => {
    return prompt.promptId
  })

  if (await getHasReviewArticleFilterMemberRows(params.projectId)) {
    const whereParts = [
      `member.project_id = ${getDuckdbSqlString(params.projectId)}`,
      `member.prompt_id IN (${getDuckdbSqlStringList(promptIds).join(', ')})`,
      params.fromDate ? `serving.article_created_at >= ${getDuckdbTimestampLiteral(params.fromDate)}` : null,
      params.toDate ? `serving.article_created_at <= ${getDuckdbTimestampLiteral(params.toDate)}` : null,
      params.searchTitle.trim()
        ? `LOWER(COALESCE(serving.article_title, '')) LIKE LOWER(${getDuckdbSqlString(`%${params.searchTitle.trim()}%`)})`
        : null,
      ...getDuckdbCovidenceMetadataWhereParts({
        sourceMetadataExpression: 'serving.source_metadata',
        hasDuplicateStudyRecords: params.hasDuplicateStudyRecords,
        hasStudyDecisionConflict: params.hasStudyDecisionConflict,
      }),
    ].filter((part): part is string => {
      return part !== null
    })

    try {
      const rows = await runDuckdbJsonQuery<{promptId: string; answerValue: string}>(`
        WITH active_generation AS (
          SELECT project_id AS projectId, active_generation AS generation
          FROM app.project_review_serving_generation
          WHERE project_id = ${getDuckdbSqlString(params.projectId)}
        )
        SELECT
          member.prompt_id AS promptId,
          dictionary.answer_value AS answerValue
        FROM mart.review_article_filter_member member
        INNER JOIN active_generation active
          ON active.projectId = member.project_id
         AND active.generation = member.generation
        INNER JOIN mart.review_article_serving serving
          ON serving.project_id = member.project_id
         AND serving.generation = member.generation
         AND serving.article_id = member.article_id
        INNER JOIN app.review_answer_dictionary dictionary
          ON dictionary.project_id = member.project_id
         AND dictionary.prompt_id = member.prompt_id
         AND dictionary.answer_id = member.answer_id
        WHERE ${whereParts.join(' AND ')}
        GROUP BY member.prompt_id, dictionary.answer_value
        ORDER BY member.prompt_id ASC, dictionary.answer_value ASC
      `)
      const valuesByPromptId = rows.reduce<Map<string, Set<string>>>((rowMap, row) => {
        const currentValues = rowMap.get(row.promptId) ?? new Set<string>()
        currentValues.add(row.answerValue)
        rowMap.set(row.promptId, currentValues)
        return rowMap
      }, new Map<string, Set<string>>())

      return databasePrompts.map((prompt) => {
        const values = Array.from(valuesByPromptId.get(prompt.promptId) ?? []).sort((left, right) => {
          return left.localeCompare(right)
        })
        return {promptId: prompt.promptId, promptName: prompt.promptName, answeredOriginalValues: values}
      })
    } catch (error) {
      console.error('[duckdbOlap] Failed to build database filters from review article filter members:', error)
      return databasePrompts
    }
  }

  const whereParts = [
    `paf.project_id = ${getDuckdbSqlString(params.projectId)}`,
    `paf.prompt_id IN (${getDuckdbSqlStringList(promptIds).join(', ')})`,
    params.fromDate ? `paf.article_created_at >= ${getDuckdbTimestampLiteral(params.fromDate)}` : null,
    params.toDate ? `paf.article_created_at <= ${getDuckdbTimestampLiteral(params.toDate)}` : null,
    params.searchTitle.trim()
      ? `LOWER(COALESCE(article.article_title, '')) LIKE LOWER(${getDuckdbSqlString(`%${params.searchTitle.trim()}%`)})`
      : null,
    ...getDuckdbCovidenceMetadataWhereParts({
      sourceMetadataExpression: 'article.source_metadata',
      hasDuplicateStudyRecords: params.hasDuplicateStudyRecords,
      hasStudyDecisionConflict: params.hasStudyDecisionConflict,
    }),
  ].filter((part): part is string => {
    return part !== null
  })
  try {
    const rows = await runDuckdbJsonQuery<{promptId: string; answerValue: string}>(`
      SELECT
        paf.prompt_id AS promptId,
        paf.answer_value AS answerValue
      FROM mart.prompt_answer_fact paf
      INNER JOIN app.article article ON article.id = paf.article_id
      WHERE ${whereParts.join(' AND ')}
      GROUP BY paf.prompt_id, paf.answer_value
      ORDER BY paf.prompt_id ASC, paf.answer_value ASC
    `)
    const valuesByPromptId = rows.reduce<Map<string, Set<string>>>((rowMap, row) => {
      const currentValues = rowMap.get(row.promptId) ?? new Set<string>()
      currentValues.add(row.answerValue)
      rowMap.set(row.promptId, currentValues)
      return rowMap
    }, new Map<string, Set<string>>())

    return databasePrompts.map((prompt) => {
      const values = Array.from(valuesByPromptId.get(prompt.promptId) ?? []).sort((left, right) => {
        return left.localeCompare(right)
      })
      return {promptId: prompt.promptId, promptName: prompt.promptName, answeredOriginalValues: values}
    })
  } catch (error) {
    console.error('[duckdbOlap] Failed to build database filters:', error)
    return databasePrompts
  }
}

export const getNumericFiltersFromDuckdb = async (params: DatabaseFilterParams): Promise<NumericFilterResult[]> => {
  const scope = await getProjectOlapScope(params.projectId)
  const numericPrompts = getEmptyNumericFilters(params.prompts)

  if (!scope || numericPrompts.length === 0) {
    return numericPrompts
  }

  if (!scope.modelId) {
    const scopedArticles = await getScopedArticles({
      scope,
      hasDuplicateStudyRecords: params.hasDuplicateStudyRecords,
      hasStudyDecisionConflict: params.hasStudyDecisionConflict,
      from: params.fromDate ? params.fromDate.toISOString().slice(0, 10) : null,
      to: params.toDate ? params.toDate.toISOString().slice(0, 10) : null,
      search: params.searchTitle,
      orderBy: 'created',
    })
    if (scopedArticles.length === 0) {
      return numericPrompts
    }

    const valuesByPromptId = (
      await getLlmJudgmentRows(
        scope,
        scopedArticles.map((article) => {
          return article.id
        }),
      )
    ).reduce<Map<string, Set<number>>>((rowMap, row) => {
      const currentValues = rowMap.get(row.promptId) ?? new Set<number>()
      const answerValues =
        row.answeredOriginalAsArray.length > 0 ? row.answeredOriginalAsArray : [row.answeredOriginal ?? '']

      answerValues.forEach((answerValue) => {
        const parsedValue = getStrictIntegerValue(answerValue)

        if (parsedValue !== null) {
          currentValues.add(parsedValue)
        }
      })
      rowMap.set(row.promptId, currentValues)
      return rowMap
    }, new Map<string, Set<number>>())

    return numericPrompts.map((prompt) => {
      return buildNumericFilterResultFromValues(
        prompt.promptId,
        prompt.promptName,
        Array.from(valuesByPromptId.get(prompt.promptId) ?? []),
        prompt.specialValues ?? [],
      )
    })
  }

  const promptIds = numericPrompts.map((prompt) => {
    return prompt.promptId
  })

  if (await getHasReviewArticleFilterMemberRows(params.projectId)) {
    const whereParts = [
      `member.project_id = ${getDuckdbSqlString(params.projectId)}`,
      `member.prompt_id IN (${getDuckdbSqlStringList(promptIds).join(', ')})`,
      params.fromDate ? `serving.article_created_at >= ${getDuckdbTimestampLiteral(params.fromDate)}` : null,
      params.toDate ? `serving.article_created_at <= ${getDuckdbTimestampLiteral(params.toDate)}` : null,
      params.searchTitle.trim()
        ? `LOWER(COALESCE(serving.article_title, '')) LIKE LOWER(${getDuckdbSqlString(`%${params.searchTitle.trim()}%`)})`
        : null,
      ...getDuckdbCovidenceMetadataWhereParts({
        sourceMetadataExpression: 'serving.source_metadata',
        hasDuplicateStudyRecords: params.hasDuplicateStudyRecords,
        hasStudyDecisionConflict: params.hasStudyDecisionConflict,
      }),
    ].filter((part): part is string => {
      return part !== null
    })
    try {
      const rows = await runDuckdbJsonQuery<{promptId: string; answerValue: string}>(`
        WITH active_generation AS (
          SELECT project_id AS projectId, active_generation AS generation
          FROM app.project_review_serving_generation
          WHERE project_id = ${getDuckdbSqlString(params.projectId)}
        )
        SELECT
          member.prompt_id AS promptId,
          dictionary.answer_value AS answerValue
        FROM mart.review_article_filter_member member
        INNER JOIN active_generation active
          ON active.projectId = member.project_id
         AND active.generation = member.generation
        INNER JOIN mart.review_article_serving serving
          ON serving.project_id = member.project_id
         AND serving.generation = member.generation
         AND serving.article_id = member.article_id
        INNER JOIN app.review_answer_dictionary dictionary
          ON dictionary.project_id = member.project_id
         AND dictionary.prompt_id = member.prompt_id
         AND dictionary.answer_id = member.answer_id
        WHERE ${whereParts.join(' AND ')}
      `)
      const valuesByPromptId = rows.reduce<Map<string, Set<number>>>((rowMap, row) => {
        const parsedValue = getStrictIntegerValue(row.answerValue)
        const currentValues = rowMap.get(row.promptId) ?? new Set<number>()

        if (parsedValue !== null) {
          currentValues.add(parsedValue)
        }

        rowMap.set(row.promptId, currentValues)
        return rowMap
      }, new Map<string, Set<number>>())

      return numericPrompts.map((prompt) => {
        return buildNumericFilterResultFromValues(
          prompt.promptId,
          prompt.promptName,
          Array.from(valuesByPromptId.get(prompt.promptId) ?? []),
          prompt.specialValues ?? [],
        )
      })
    } catch (error) {
      console.error('[duckdbOlap] Failed to build numeric filters from review article filter members:', error)
      return numericPrompts
    }
  }

  const whereParts = [
    `paf.project_id = ${getDuckdbSqlString(params.projectId)}`,
    `paf.prompt_id IN (${getDuckdbSqlStringList(promptIds).join(', ')})`,
    params.fromDate ? `paf.article_created_at >= ${getDuckdbTimestampLiteral(params.fromDate)}` : null,
    params.toDate ? `paf.article_created_at <= ${getDuckdbTimestampLiteral(params.toDate)}` : null,
    params.searchTitle.trim()
      ? `LOWER(COALESCE(article.article_title, '')) LIKE LOWER(${getDuckdbSqlString(`%${params.searchTitle.trim()}%`)})`
      : null,
    ...getDuckdbCovidenceMetadataWhereParts({
      sourceMetadataExpression: 'article.source_metadata',
      hasDuplicateStudyRecords: params.hasDuplicateStudyRecords,
      hasStudyDecisionConflict: params.hasStudyDecisionConflict,
    }),
  ].filter((part): part is string => {
    return part !== null
  })
  try {
    const rows = await runDuckdbJsonQuery<{promptId: string; answerValue: string}>(`
      SELECT
        paf.prompt_id AS promptId,
        paf.answer_value AS answerValue
      FROM mart.prompt_answer_fact paf
      INNER JOIN app.article article ON article.id = paf.article_id
      WHERE ${whereParts.join(' AND ')}
    `)
    const valuesByPromptId = rows.reduce<Map<string, Set<number>>>((rowMap, row) => {
      const parsedValue = getStrictIntegerValue(row.answerValue)
      const currentValues = rowMap.get(row.promptId) ?? new Set<number>()

      if (parsedValue !== null) {
        currentValues.add(parsedValue)
      }

      rowMap.set(row.promptId, currentValues)
      return rowMap
    }, new Map<string, Set<number>>())

    return numericPrompts.map((prompt) => {
      return buildNumericFilterResultFromValues(
        prompt.promptId,
        prompt.promptName,
        Array.from(valuesByPromptId.get(prompt.promptId) ?? []),
        prompt.specialValues ?? [],
      )
    })
  } catch (error) {
    console.error('[duckdbOlap] Failed to build numeric filters:', error)
    return numericPrompts
  }
}

export const getUnassessedCountFromDuckdb = async (params: UnassessedCountParams): Promise<number> => {
  const scope = await getProjectOlapScope(params.projectId)

  if (!scope || scope.promptIds.length === 0 || !scope.modelId) {
    return 0
  }

  if (!params.preferRawFallback && (await getHasReviewArticleServingRows(scope))) {
    return countUnassessedRowsFromServing({
      scope,
      hasDuplicateStudyRecords: params.hasDuplicateStudyRecords,
      hasStudyDecisionConflict: params.hasStudyDecisionConflict,
      from: params.projectDateFrom ? params.projectDateFrom.toISOString().slice(0, 10) : null,
      to: params.projectDateTo ? params.projectDateTo.toISOString().slice(0, 10) : null,
    })
  }

  const {scopedArticles} = await getUnassessedArticleRows({
    scope,
    hasDuplicateStudyRecords: params.hasDuplicateStudyRecords,
    hasStudyDecisionConflict: params.hasStudyDecisionConflict,
    from: params.projectDateFrom ? params.projectDateFrom.toISOString().slice(0, 10) : null,
    to: params.projectDateTo ? params.projectDateTo.toISOString().slice(0, 10) : null,
  })

  return scopedArticles.length
}

export const getUnassessedArticlesFromDuckdb = async (
  params: UnassessedArticlesParams,
): Promise<{articles: UnassessedArticleRow[]; totalCount: number}> => {
  const scope = await getProjectOlapScope(params.projectId)

  if (!scope || scope.promptIds.length === 0 || !scope.modelId) {
    return {articles: [], totalCount: 0}
  }

  if (!params.preferRawFallback && (await getHasReviewArticleServingRows(scope))) {
    const servingResult = await getUnassessedRowsFromServing({
      scope,
      limit: params.limit,
      offset: params.offset,
      hasDuplicateStudyRecords: params.hasDuplicateStudyRecords,
      hasStudyDecisionConflict: params.hasStudyDecisionConflict,
      from: params.projectDateFrom ? params.projectDateFrom.toISOString().slice(0, 10) : null,
      to: params.projectDateTo ? params.projectDateTo.toISOString().slice(0, 10) : null,
      search: params.search,
    })

    return {
      articles: servingResult.rows.map((article) => {
        return {
          id: article.id,
          articleId: article.articleId,
          articleTitle: article.articleTitle,
          articleCreatedAt: article.articleCreatedAt,
          articleUpdatedAt: article.articleUpdatedAt,
        }
      }),
      totalCount: servingResult.totalCount,
    }
  }

  const rawResult = await getUnassessedArticleRows({
    scope,
    hasDuplicateStudyRecords: params.hasDuplicateStudyRecords,
    hasStudyDecisionConflict: params.hasStudyDecisionConflict,
    from: params.projectDateFrom ? params.projectDateFrom.toISOString().slice(0, 10) : null,
    to: params.projectDateTo ? params.projectDateTo.toISOString().slice(0, 10) : null,
    search: params.search,
  })
  const rows = rawResult.scopedArticles.slice(params.offset, params.offset + params.limit).map((article) => {
    return {
      id: article.id,
      articleId: article.articleId,
      articleTitle: article.articleTitle,
      articleCreatedAt: article.articleCreatedAt,
      articleUpdatedAt: article.articleUpdatedAt,
      llmJudgedPromptIds: getJudgedPromptIds(
        rawResult?.llmJudgmentsByArticle.get(article.id) ?? [],
        scope.promptOrderMap,
      ),
    }
  })
  const totalCount = rawResult.scopedArticles.length

  return {
    articles: rows.map((article) => {
      return {
        id: article.id,
        articleId: article.articleId,
        articleTitle: article.articleTitle,
        articleCreatedAt: article.articleCreatedAt,
        articleUpdatedAt: article.articleUpdatedAt,
      }
    }),
    totalCount,
  }
}

const getCandidateArticlesLimit = (numberOfPromptsToGet: number) => {
  const requested = Math.max(1, Math.trunc(numberOfPromptsToGet))
  const scaled = requested * 5
  return Math.min(20_000, Math.max(2_000, scaled))
}

export const getUnassessedPairsFromDuckdb = async (params: UnassessedPairsParams): Promise<UnassessedPairsResult> => {
  const scope = await getProjectOlapScope(params.projectId)

  if (!scope || scope.promptIds.length === 0 || !scope.modelId) {
    return {promptEntries: [], nextCursor: null}
  }

  const candidateLimit = getCandidateArticlesLimit(params.numberOfPromptsToGet)
  const hasServingRows = await getHasReviewArticleServingRows(scope)
  const useServingRows = hasServingRows && !params.preferRawFallback
  const candidateResult = await (useServingRows
    ? getUnassessedCandidateRowsFromServing({scope, cursor: params.cursor, limit: candidateLimit})
    : getRawUnassessedCandidateRows({jobId: params.jobId, scope, cursor: params.cursor, limit: candidateLimit}))
  const candidateArticles = candidateResult.rows
  const promptEntries = candidateArticles.flatMap<PromptQueueEntry>((article) => {
    const presentPromptIds = new Set(article.llmJudgedPromptIds)
    return scope.promptIds
      .filter((promptId) => {
        return !presentPromptIds.has(promptId)
      })
      .map((promptId) => {
        return {articleId: article.articleId, promptId}
      })
  })
  const limitedPromptEntries = promptEntries.slice(0, params.numberOfPromptsToGet)
  const lastPromptArticleId = limitedPromptEntries[limitedPromptEntries.length - 1]?.articleId ?? null
  const nextCursorArticle = lastPromptArticleId
    ? (candidateArticles.find((article) => {
        return article.articleId === lastPromptArticleId
      }) ?? null)
    : candidateResult.hasMore
      ? (candidateArticles[candidateArticles.length - 1] ?? null)
      : null

  if (!useServingRows) {
    rawFallbackQueueLogger.log(
      `getPrompts:raw-fallback:${params.jobId}:prompt-result`,
      '[getPrompts] raw fallback prompt result',
      {
        candidateArticles: candidateArticles.length,
        candidateLimit,
        cursor: getPaginationCursorSummary(params.cursor),
        hasMore: candidateResult.hasMore,
        jobId: params.jobId,
        nextCursor: getPaginationCursorSummary(
          nextCursorArticle
            ? {
                lastArticleId: nextCursorArticle.articleId,
                lastDate:
                  nextCursorArticle.articleUpdatedAt
                  ?? nextCursorArticle.articleCreatedAt
                  ?? new Date('1970-01-01T00:00:00.000Z'),
              }
            : null,
        ),
        projectId: params.projectId,
        promptEntriesBeforeLimit: promptEntries.length,
        promptEntriesReturned: limitedPromptEntries.length,
        requestedPromptEntries: params.numberOfPromptsToGet,
      },
    )
  }

  return {
    promptEntries: limitedPromptEntries,
    nextCursor: nextCursorArticle
      ? {
          lastDate:
            nextCursorArticle.articleUpdatedAt
            ?? nextCursorArticle.articleCreatedAt
            ?? new Date('1970-01-01T00:00:00.000Z'),
          lastArticleId: nextCursorArticle.articleId,
        }
      : null,
  }
}

const getHumanReviewedArticleIdsFromDuckdbRaw = async (params: {
  scope: ProjectOlapScope
  hasDuplicateStudyRecords?: boolean
  hasStudyDecisionConflict?: boolean
  from?: string | null
  to?: string | null
  search?: string | null
}) => {
  const scopedArticles = await getScopedArticles({...params, orderBy: 'created'})

  if (params.scope.humanJudgmentMode === 'summary') {
    const humanSummaryRowsByArticle = getHumanSummaryRowsByArticleId(
      await getHumanSummaryRows(
        params.scope,
        scopedArticles.map((article) => {
          return article.id
        }),
      ),
    )

    return scopedArticles
      .filter((article) => {
        return getHumanSummaryAnswer(humanSummaryRowsByArticle.get(article.id)) !== null
      })
      .map((article) => {
        return article.id
      })
  }

  const humanRowsByArticle = getHumanRowsByArticleId(
    await getHumanAnswerRows(
      params.scope,
      scopedArticles.map((article) => {
        return article.id
      }),
    ),
  )

  return scopedArticles
    .filter((article) => {
      const humanRows = humanRowsByArticle.get(article.id) ?? []
      return getHasAllProjectPrompts(
        params.scope.promptIds,
        humanRows.filter((row) => {
          return getHasHumanAnswer(row.answer)
        }),
      )
    })
    .map((article) => {
      return article.id
    })
}

export const selectArticleIdsByFilterDuckdb = async (...args: SelectArticleIdsArgs): Promise<string[]> => {
  const [
    sourceProjectId,
    listType,
    promptsFilter,
    from,
    to,
    search,
    hasDuplicateStudyRecords,
    hasStudyDecisionConflict,
  ] = args
  const scope = await getProjectOlapScope(sourceProjectId)

  if (!scope || scope.promptIds.length === 0) {
    return []
  }

  if (listType === 'human') {
    return scope.modelId && (await getHasReviewArticleServingRows(scope))
      ? getHumanReviewedArticleIdsFromServing({
          scope,
          from,
          to,
          search,
          hasDuplicateStudyRecords,
          hasStudyDecisionConflict,
        })
      : getHumanReviewedArticleIdsFromDuckdbRaw({
          scope,
          from,
          to,
          search,
          hasDuplicateStudyRecords,
          hasStudyDecisionConflict,
        })
  }

  if (scope.modelId) {
    if (await getHasReviewArticleServingRows(scope)) {
      if (listType === 'llm') {
        return getReviewedArticleIdsFromServing({
          scope,
          from,
          to,
          search,
          prompts: promptsFilter,
          hasDuplicateStudyRecords,
          hasStudyDecisionConflict,
        })
      }

      if (listType === 'unassessed') {
        const {rows} = await getUnassessedRowsFromServing({
          scope,
          from,
          to,
          search,
          hasDuplicateStudyRecords,
          hasStudyDecisionConflict,
        })
        return rows.map((article) => {
          return article.id
        })
      }

      return getReviewedArticleIdsFromServing({
        scope,
        from,
        to,
        search,
        prompts: promptsFilter,
        hasDuplicateStudyRecords,
        hasStudyDecisionConflict,
        requireAllHumanAnswers: true,
        requireAllLlmJudgments: true,
      })
    }

    if (listType === 'llm') {
      const {scopedArticles} = await getLlmReviewedArticleRows({
        scope,
        from,
        to,
        search,
        prompts: promptsFilter,
        hasDuplicateStudyRecords,
        hasStudyDecisionConflict,
      })
      return scopedArticles.map((article) => {
        return article.id
      })
    }

    if (listType === 'unassessed') {
      const {scopedArticles} = await getUnassessedArticleRows({
        scope,
        from,
        to,
        search,
        hasDuplicateStudyRecords,
        hasStudyDecisionConflict,
      })
      return scopedArticles.map((article) => {
        return article.id
      })
    }

    const {scopedArticles} = await getLlmReviewedArticleRows({
      scope,
      from,
      to,
      search,
      prompts: promptsFilter,
      hasDuplicateStudyRecords,
      hasStudyDecisionConflict,
      requireAllLlmJudgments: true,
    })
    const humanArticleIds = new Set(
      await getHumanReviewedArticleIdsFromDuckdbRaw({
        scope,
        from,
        to,
        search,
        hasDuplicateStudyRecords,
        hasStudyDecisionConflict,
      }),
    )

    return scopedArticles
      .filter((article) => {
        return humanArticleIds.has(article.id)
      })
      .map((article) => {
        return article.id
      })
  }

  if (listType === 'llm') {
    const {scopedArticles} = await getLlmReviewedArticleRows({
      scope,
      from,
      to,
      search,
      prompts: promptsFilter,
      hasDuplicateStudyRecords,
      hasStudyDecisionConflict,
    })
    return scopedArticles.map((article) => {
      return article.id
    })
  }

  if (listType === 'unassessed') {
    const {scopedArticles} = await getUnassessedArticleRows({
      scope,
      from,
      to,
      search,
      hasDuplicateStudyRecords,
      hasStudyDecisionConflict,
    })
    return scopedArticles.map((article) => {
      return article.id
    })
  }

  const {scopedArticles} = await getLlmReviewedArticleRows({
    scope,
    from,
    to,
    search,
    prompts: promptsFilter,
    hasDuplicateStudyRecords,
    hasStudyDecisionConflict,
    requireAllLlmJudgments: true,
  })
  const humanArticleIds = new Set(
    await getHumanReviewedArticleIdsFromDuckdbRaw({
      scope,
      from,
      to,
      search,
      hasDuplicateStudyRecords,
      hasStudyDecisionConflict,
    }),
  )

  return scopedArticles
    .filter((article) => {
      return humanArticleIds.has(article.id)
    })
    .map((article) => {
      return article.id
    })
}
