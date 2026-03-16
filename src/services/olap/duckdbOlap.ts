import {
  buildNumericFilterResult,
  buildNumericFilterResultFromValues,
  type NumericFilterResult,
} from '../../server/routes/projectsRoutes/articlesReviewsFiltersNumeric.ts'
import {isNumericType} from '../../server/routes/projectsRoutes/articlesReviewsFiltersUtils.ts'
import {hasMatchingJudgmentAnswer} from '../../server/utils/judgmentAnswers.ts'
import {getJournalTitleFromOriginalData} from '../../utils/getJournalTitleFromOriginalData.ts'
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
  promptRows: Array<{
    id: string
    order: number | null
    promptHeading: string | null
    originalText: string
    type: string | null
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
  originalData: unknown
}

type HumanAnswerRow = {articleId: string; promptId: string; answer: string | null; updatedAt: Date | null}

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

const getDuckdbJsonValue = (value: unknown) => {
  if (typeof value !== 'string') {
    return value
  }

  const trimmedValue = value.trim()
  if (!trimmedValue.startsWith('{') && !trimmedValue.startsWith('[')) {
    return value
  }

  try {
    return JSON.parse(trimmedValue) as unknown
  } catch {
    return value
  }
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

const getDuckdbPromptFilterExistsParts = (
  scope: ProjectOlapScope,
  prompts: Record<string, string[]> | undefined,
  rollupAlias: string,
) => {
  const promptTypeById = getDuckdbPromptTypeById(scope)
  const promptFilters = getPromptFilters(prompts)

  return promptFilters.reduce<string[]>((whereParts, [promptId, answeredValues]) => {
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
      const numericExpression = `TRY_CAST(paf.answer_value AS BIGINT)`
      const rangeCondition =
        parsedFilters.binRanges.length === 0
          ? null
          : `(${parsedFilters.binRanges
              .map((range) => {
                return `(${numericExpression} >= ${range.min} AND ${numericExpression} <= ${range.max})`
              })
              .join(' OR ')})`
      const specialCondition =
        parsedFilters.specialValues.length === 0
          ? null
          : `TRIM(COALESCE(paf.answer_value, '')) IN (${getDuckdbSqlStringList(parsedFilters.specialValues).join(', ')})`
      const answerCondition = [rangeCondition, specialCondition].filter((condition): condition is string => {
        return condition !== null
      })

      return answerCondition.length === 0
        ? whereParts
        : [
            ...whereParts,
            `EXISTS (
              SELECT 1
              FROM mart.prompt_answer_fact paf
              WHERE paf.project_id = ${rollupAlias}.project_id
                AND paf.article_id = ${rollupAlias}.article_id
                AND paf.prompt_id = ${getDuckdbSqlString(promptId)}
                AND (${answerCondition.join(' OR ')})
            )`,
          ]
    }

    return [
      ...whereParts,
      `EXISTS (
        SELECT 1
        FROM mart.prompt_answer_fact paf
        WHERE paf.project_id = ${rollupAlias}.project_id
          AND paf.article_id = ${rollupAlias}.article_id
          AND paf.prompt_id = ${getDuckdbSqlString(promptId)}
          AND paf.answer_value IN (${getDuckdbSqlStringList(answeredValues).join(', ')})
      )`,
    ]
  }, [])
}

const getDuckdbRollupBaseWhereParts = (params: {
  scope: ProjectOlapScope
  from?: string | null
  to?: string | null
  search?: string | null
  rollupAlias: string
}) => {
  const requestFromDate = parseDateFromInput(params.from, 'T00:00:00.000Z')
  const requestToDate = parseDateFromInput(params.to, 'T23:59:59.999Z')
  const effectiveFromDate = getEffectiveFromDate(params.scope.dateFrom, requestFromDate)
  const effectiveToDate = getEffectiveToDate(params.scope.dateTo, requestToDate)
  const trimmedSearch = params.search?.trim() ?? ''

  return [
    `${params.rollupAlias}.project_id = ${getDuckdbSqlString(params.scope.projectId)}`,
    effectiveFromDate
      ? `${params.rollupAlias}.article_created_at >= ${getDuckdbTimestampLiteral(effectiveFromDate)}`
      : null,
    effectiveToDate
      ? `${params.rollupAlias}.article_created_at <= ${getDuckdbTimestampLiteral(effectiveToDate)}`
      : null,
    trimmedSearch
      ? `LOWER(COALESCE(${params.rollupAlias}.article_title, '')) LIKE LOWER(${getDuckdbSqlString(`%${trimmedSearch}%`)})`
      : null,
  ].filter((part): part is string => {
    return part !== null
  })
}

const getDuckdbRollupReviewedWhereParts = (params: {
  scope: ProjectOlapScope
  from?: string | null
  to?: string | null
  search?: string | null
  prompts?: Record<string, string[]>
  requireAllHumanAnswers?: boolean
  requireAllLlmJudgments?: boolean
  requireIncompleteLlm?: boolean
}) => {
  const rollupAlias = 'r'
  const completenessParts = [
    params.requireAllLlmJudgments ? `${rollupAlias}.has_all_llm_judgments = TRUE` : null,
    params.requireAllHumanAnswers ? `${rollupAlias}.has_all_human_answers = TRUE` : null,
    params.requireIncompleteLlm ? `${rollupAlias}.has_all_llm_judgments = FALSE` : null,
  ].filter((part): part is string => {
    return part !== null
  })

  return [
    ...getDuckdbRollupBaseWhereParts({...params, rollupAlias}),
    ...completenessParts,
    ...getDuckdbPromptFilterExistsParts(params.scope, params.prompts, rollupAlias),
  ]
}

const getDuckdbRollupCreatedOrderClause = () => {
  return 'r.article_created_at DESC NULLS LAST, r.article_id ASC'
}

const getDuckdbReviewPageOrderClause = () => {
  return `COALESCE(p.article_created_at, TIMESTAMPTZ '0001-01-01T00:00:00.000Z') DESC, p.article_id ASC`
}

const getDuckdbReviewPageCursorWhereClause = (cursor: ReviewPageCursor) => {
  const createdAtLiteral = cursor.articleCreatedAt
    ? getDuckdbTimestampLiteral(new Date(cursor.articleCreatedAt))
    : `TIMESTAMPTZ '0001-01-01T00:00:00.000Z'`

  return `(
    COALESCE(p.article_created_at, TIMESTAMPTZ '0001-01-01T00:00:00.000Z') < ${createdAtLiteral}
    OR (
      COALESCE(p.article_created_at, TIMESTAMPTZ '0001-01-01T00:00:00.000Z') = ${createdAtLiteral}
      AND p.article_id > ${getDuckdbSqlString(cursor.articleId)}
    )
  )`
}

const getDuckdbReviewPageWhereParts = (params: {
  scope: ProjectOlapScope
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
    `p.project_id = ${getDuckdbSqlString(params.scope.projectId)}`,
    'p.has_all_llm_judgments = TRUE',
    effectiveFromDate ? `p.article_created_at >= ${getDuckdbTimestampLiteral(effectiveFromDate)}` : null,
    effectiveToDate ? `p.article_created_at <= ${getDuckdbTimestampLiteral(effectiveToDate)}` : null,
    trimmedSearch
      ? `LOWER(COALESCE(p.article_title, '')) LIKE LOWER(${getDuckdbSqlString(`%${trimmedSearch}%`)})`
      : null,
    decodedCursor ? getDuckdbReviewPageCursorWhereClause(decodedCursor) : null,
  ].filter((part): part is string => {
    return part !== null
  })
}

const getDuckdbReviewPagePromptFilterExistsParts = (
  scope: ProjectOlapScope,
  prompts: Record<string, string[]> | undefined,
) => {
  const promptTypeById = getDuckdbPromptTypeById(scope)
  const promptFilters = getPromptFilters(prompts)

  return promptFilters.reduce<string[]>((whereParts, [promptId, answeredValues]) => {
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
      const numericCondition =
        parsedFilters.binRanges.length === 0
          ? null
          : `(${parsedFilters.binRanges
              .map((range) => {
                return `(f.numeric_answer_value >= ${range.min} AND f.numeric_answer_value <= ${range.max})`
              })
              .join(' OR ')})`
      const specialCondition =
        parsedFilters.specialValues.length === 0
          ? null
          : `f.answer_value IN (${getDuckdbSqlStringList(parsedFilters.specialValues).join(', ')})`
      const answerCondition = [numericCondition, specialCondition].filter((part): part is string => {
        return part !== null
      })

      return answerCondition.length === 0
        ? whereParts
        : [
            ...whereParts,
            `EXISTS (
              SELECT 1
              FROM mart.review_article_filter_row f
              WHERE f.project_id = p.project_id
                AND f.article_id = p.article_id
                AND f.prompt_id = ${getDuckdbSqlString(promptId)}
                AND (${answerCondition.join(' OR ')})
            )`,
          ]
    }

    return [
      ...whereParts,
      `EXISTS (
        SELECT 1
        FROM mart.review_article_filter_row f
        WHERE f.project_id = p.project_id
          AND f.article_id = p.article_id
          AND f.prompt_id = ${getDuckdbSqlString(promptId)}
          AND f.answer_value IN (${getDuckdbSqlStringList(answeredValues).join(', ')})
      )`,
    ]
  }, [])
}

const getDuckdbReviewPageReviewedWhereParts = (params: {
  scope: ProjectOlapScope
  from?: string | null
  to?: string | null
  search?: string | null
  cursor?: string | null
  prompts?: Record<string, string[]>
}) => {
  return [
    ...getDuckdbReviewPageWhereParts(params),
    ...getDuckdbReviewPagePromptFilterExistsParts(params.scope, params.prompts),
  ]
}

const getReviewedPageRowsFromPageMart = async (params: {
  scope: ProjectOlapScope
  page: number
  limit: number
  from?: string | null
  to?: string | null
  search?: string | null
  cursor?: string | null
  prompts?: Record<string, string[]>
}) => {
  const whereParts = getDuckdbReviewPageReviewedWhereParts(params)
  const offset = params.cursor ? 0 : Math.max(params.page - 1, 0) * params.limit
  const rows = await runDuckdbJsonQuery<{
    articleCreatedAt: unknown
    articleId: string
    articleTitle: string
    articleUpdatedAt: unknown
    journalTitle: string | null
  }>(`
    SELECT
      p.article_id AS articleId,
      p.article_title AS articleTitle,
      p.article_created_at AS articleCreatedAt,
      p.article_updated_at AS articleUpdatedAt,
      p.journal_title AS journalTitle
    FROM mart.review_article_page p
    WHERE ${whereParts.join(' AND ')}
    ORDER BY ${getDuckdbReviewPageOrderClause()}
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
      return {
        articleCreatedAt: getDuckdbDateValue(row.articleCreatedAt),
        articleId: row.articleId,
        articleTitle: row.articleTitle,
        articleUpdatedAt: getDuckdbDateValue(row.articleUpdatedAt),
        id: row.articleId,
        journalTitle: row.journalTitle,
      }
    }),
  }
}

const getHasReviewArticlePageRows = async (projectId: string) => {
  const rows = await runDuckdbJsonQuery<{projectId: string}>(`
    SELECT project_id AS projectId
    FROM mart.review_article_page
    WHERE project_id = ${getDuckdbSqlString(projectId)}
    LIMIT 1
  `)

  return rows.length > 0
}

const getHasReviewArticleFilterRows = async (projectId: string) => {
  const rows = await runDuckdbJsonQuery<{projectId: string}>(`
    SELECT project_id AS projectId
    FROM mart.review_article_filter_row
    WHERE project_id = ${getDuckdbSqlString(projectId)}
    LIMIT 1
  `)

  return rows.length > 0
}

const countReviewedPageRowsFromPageMart = async (params: {
  scope: ProjectOlapScope
  from?: string | null
  to?: string | null
  search?: string | null
  prompts?: Record<string, string[]>
}) => {
  const whereParts = getDuckdbReviewPageReviewedWhereParts({...params, cursor: null})
  const rows = await runDuckdbJsonQuery<{totalCount: number}>(`
    SELECT COUNT(*) AS totalCount
    FROM mart.review_article_page p
    WHERE ${whereParts.join(' AND ')}
  `)

  return Number(rows[0]?.totalCount ?? 0)
}

const getDuckdbRollupActivityOrderClause = () => {
  return `COALESCE(r.article_updated_at, r.article_created_at, TIMESTAMPTZ '1970-01-01T00:00:00.000Z') DESC, r.article_id DESC`
}

const getDuckdbReviewedPageRowsFromRollup = async (params: {
  scope: ProjectOlapScope
  page: number
  limit: number
  from?: string | null
  to?: string | null
  search?: string | null
  prompts?: Record<string, string[]>
  requireAllHumanAnswers?: boolean
  requireAllLlmJudgments?: boolean
}) => {
  const offset = Math.max(params.page - 1, 0) * params.limit
  const whereParts = getDuckdbRollupReviewedWhereParts({...params, requireAllLlmJudgments: true})
  const rows = await runDuckdbJsonQuery<{
    id: string
    articleTitle: string
    articleCreatedAt: unknown
    articleUpdatedAt: unknown
    originalData: unknown
  }>(`
    SELECT
      r.article_id AS id,
      r.article_title AS articleTitle,
      r.article_created_at AS articleCreatedAt,
      r.article_updated_at AS articleUpdatedAt,
      a.original_data AS originalData
    FROM mart.review_article_rollup r
    INNER JOIN app.article a ON a.id = r.article_id
    WHERE ${whereParts.join(' AND ')}
    ORDER BY ${getDuckdbRollupCreatedOrderClause()}
    LIMIT ${params.limit}
    OFFSET ${offset}
  `)

  return rows.map((row) => {
    return {
      id: row.id,
      articleTitle: row.articleTitle,
      articleCreatedAt: getDuckdbDateValue(row.articleCreatedAt),
      articleUpdatedAt: getDuckdbDateValue(row.articleUpdatedAt),
      originalData: getDuckdbJsonValue(row.originalData),
    }
  })
}

const countDuckdbReviewedArticlesFromRollup = async (params: {
  scope: ProjectOlapScope
  from?: string | null
  to?: string | null
  search?: string | null
  prompts?: Record<string, string[]>
}) => {
  const whereParts = getDuckdbRollupReviewedWhereParts({...params, requireAllLlmJudgments: true})
  const rows = await runDuckdbJsonQuery<{totalCount: number}>(`
    SELECT COUNT(*) AS totalCount
    FROM mart.review_article_rollup r
    WHERE ${whereParts.join(' AND ')}
  `)

  return Number(rows[0]?.totalCount ?? 0)
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

const getBothPageRowsFromRollup = async (params: {
  scope: ProjectOlapScope
  page: number
  limit: number
  from?: string | null
  to?: string | null
  search?: string | null
  prompts?: Record<string, string[]>
}) => {
  const offset = Math.max(params.page - 1, 0) * params.limit
  const whereParts = getDuckdbRollupReviewedWhereParts({
    ...params,
    requireAllHumanAnswers: true,
    requireAllLlmJudgments: true,
  })
  const countRows = await runDuckdbJsonQuery<{totalCount: number}>(`
    SELECT COUNT(*) AS totalCount
    FROM mart.review_article_rollup r
    WHERE ${whereParts.join(' AND ')}
  `)
  const totalCount = Number(countRows[0]?.totalCount ?? 0)
  const rows = await runDuckdbJsonQuery<{
    id: string
    articleTitle: string
    articleCreatedAt: unknown
    articleUpdatedAt: unknown
    originalData: unknown
  }>(`
    SELECT
      r.article_id AS id,
      r.article_title AS articleTitle,
      r.article_created_at AS articleCreatedAt,
      r.article_updated_at AS articleUpdatedAt,
      a.original_data AS originalData
    FROM mart.review_article_rollup r
    INNER JOIN app.article a ON a.id = r.article_id
    WHERE ${whereParts.join(' AND ')}
    ORDER BY ${getDuckdbRollupCreatedOrderClause()}
    LIMIT ${params.limit}
    OFFSET ${offset}
  `)

  return {
    rows: rows.map((row) => {
      return {
        id: row.id,
        articleTitle: row.articleTitle,
        articleCreatedAt: getDuckdbDateValue(row.articleCreatedAt),
        articleUpdatedAt: getDuckdbDateValue(row.articleUpdatedAt),
        originalData: getDuckdbJsonValue(row.originalData),
      }
    }),
    totalCount,
  }
}

const getReviewedArticleIdsFromRollup = async (params: {
  scope: ProjectOlapScope
  from?: string | null
  to?: string | null
  search?: string | null
  prompts?: Record<string, string[]>
  requireAllHumanAnswers?: boolean
}) => {
  const whereParts = getDuckdbRollupReviewedWhereParts({...params, requireAllLlmJudgments: true})
  const rows = await runDuckdbJsonQuery<{articleId: string}>(`
    SELECT r.article_id AS articleId
    FROM mart.review_article_rollup r
    WHERE ${whereParts.join(' AND ')}
    ORDER BY ${getDuckdbRollupCreatedOrderClause()}
  `)

  return rows.map((row) => {
    return row.articleId
  })
}

const getHumanReviewedArticleIdsFromRollup = async (params: {
  scope: ProjectOlapScope
  from?: string | null
  to?: string | null
  search?: string | null
}) => {
  const whereParts = getDuckdbRollupReviewedWhereParts({...params, requireAllHumanAnswers: true})
  const rows = await runDuckdbJsonQuery<{articleId: string}>(`
    SELECT r.article_id AS articleId
    FROM mart.review_article_rollup r
    WHERE ${whereParts.join(' AND ')}
    ORDER BY ${getDuckdbRollupCreatedOrderClause()}
  `)

  return rows.map((row) => {
    return row.articleId
  })
}

const getUnassessedRowsFromRollup = async (params: {
  scope: ProjectOlapScope
  limit?: number
  offset?: number
  from?: string | null
  to?: string | null
  search?: string | null
}) => {
  const whereParts = getDuckdbRollupReviewedWhereParts({...params, requireIncompleteLlm: true})
  const limitClause = params.limit == null ? '' : `LIMIT ${params.limit}`
  const offsetClause = params.offset == null ? '' : `OFFSET ${params.offset}`
  const countRows = await runDuckdbJsonQuery<{totalCount: number}>(`
    SELECT COUNT(*) AS totalCount
    FROM mart.review_article_rollup r
    WHERE ${whereParts.join(' AND ')}
  `)
  const rows = await runDuckdbJsonQuery<{
    articleCreatedAt: unknown
    articleId: string | null
    articleTitle: string
    articleUpdatedAt: unknown
    id: string
    llmJudgedPromptIds: unknown
  }>(`
    SELECT
      r.article_id AS id,
      a.article_id AS articleId,
      r.article_title AS articleTitle,
      r.article_created_at AS articleCreatedAt,
      r.article_updated_at AS articleUpdatedAt,
      TO_JSON(r.llm_judged_prompt_ids) AS llmJudgedPromptIds
    FROM mart.review_article_rollup r
    INNER JOIN app.article a ON a.id = r.article_id
    WHERE ${whereParts.join(' AND ')}
    ORDER BY ${getDuckdbRollupActivityOrderClause()}
    ${limitClause}
    ${offsetClause}
  `)

  return {
    rows: rows.map((row) => {
      return {
        id: row.id,
        articleId: row.articleId,
        articleTitle: row.articleTitle,
        articleCreatedAt: getDuckdbDateValue(row.articleCreatedAt),
        articleUpdatedAt: getDuckdbDateValue(row.articleUpdatedAt),
        llmJudgedPromptIds: getDuckdbStringArrayValue(row.llmJudgedPromptIds),
      }
    }),
    totalCount: Number(countRows[0]?.totalCount ?? 0),
  }
}

const getUnassessedCandidateRowsFromRollup = async (params: {
  scope: ProjectOlapScope
  cursor: PaginationCursor | null
  limit: number
}) => {
  const whereParts = getDuckdbRollupReviewedWhereParts({...params, requireIncompleteLlm: true})
  const cursorClause = params.cursor ? getUnassessedCursorWhereClause(params.cursor) : null
  const rows = await runDuckdbJsonQuery<{
    articleCreatedAt: unknown
    articleId: string
    articleUpdatedAt: unknown
    llmJudgedPromptIds: unknown
  }>(`
    SELECT
      r.article_id AS articleId,
      r.article_created_at AS articleCreatedAt,
      r.article_updated_at AS articleUpdatedAt,
      TO_JSON(r.llm_judged_prompt_ids) AS llmJudgedPromptIds
    FROM mart.review_article_rollup r
    WHERE ${[...whereParts, cursorClause]
      .filter((part): part is string => {
        return part !== null
      })
      .join(' AND ')}
    ORDER BY ${getDuckdbRollupActivityOrderClause()}
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

const getUnassessedCursorWhereClause = (cursor: Exclude<PaginationCursor, null>) => {
  return `(
    COALESCE(r.article_updated_at, r.article_created_at, TIMESTAMPTZ '1970-01-01T00:00:00.000Z') < ${getDuckdbTimestampLiteral(cursor.lastDate)}
    OR (
      COALESCE(r.article_updated_at, r.article_created_at, TIMESTAMPTZ '1970-01-01T00:00:00.000Z') = ${getDuckdbTimestampLiteral(cursor.lastDate)}
      AND r.article_id < ${getDuckdbSqlString(cursor.lastArticleId)}
    )
  )`
}

const getDuckdbReviewedArticlesQuerySections = (params: {
  scope: ProjectOlapScope
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
  ].filter((part): part is string => {
    return part !== null
  })
  const judgmentsWhereParts = [
    `j.prompt_id IN (${getDuckdbSqlStringList(params.scope.promptIds).join(', ')})`,
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
    `COUNT(DISTINCT j.prompt_id) = ${params.scope.promptIds.length}`,
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

const getDuckdbReviewedArticleRows = async (params: {
  scope: ProjectOlapScope
  page: number
  limit: number
  from?: string | null
  to?: string | null
  search?: string | null
  prompts?: Record<string, string[]>
}) => {
  const offset = Math.max(params.page - 1, 0) * params.limit
  const sections = getDuckdbReviewedArticlesQuerySections(params)
  const rows = await runDuckdbJsonQuery<{
    id: string
    articleTitle: string
    articleCreatedAt: unknown
    articleUpdatedAt: unknown
    originalData: unknown
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
      a.original_data AS originalData
    FROM reviewed_article_ids r
    INNER JOIN app.article a ON a.id = r.articleId
    ORDER BY a.article_created_at DESC NULLS LAST, a.id ASC
    LIMIT ${params.limit}
    OFFSET ${offset}
  `)

  return rows.map((row) => {
    return {
      id: row.id,
      articleTitle: row.articleTitle,
      articleCreatedAt: getDuckdbDateValue(row.articleCreatedAt),
      articleUpdatedAt: getDuckdbDateValue(row.articleUpdatedAt),
      originalData: getDuckdbJsonValue(row.originalData),
    }
  })
}

const countDuckdbReviewedArticles = async (params: {
  scope: ProjectOlapScope
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
    }>(`
      SELECT
        p.id AS id,
        pp.prompt_order AS "order",
        p.prompt_heading AS promptHeading,
        p.original_text AS originalText,
        p.type AS type
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
    originalData: unknown
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
      a.original_data AS originalData
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
      originalData: getDuckdbJsonValue(row.originalData),
    }
  })

  return params.orderBy === 'activity' ? sortArticlesByActivity(normalizedRows) : sortArticlesByCreated(normalizedRows)
}

const getLlmJudgmentRows = async (scope: ProjectOlapScope, articleIds: string[]): Promise<OlapJudgmentRow[]> => {
  if (articleIds.length === 0 || scope.promptIds.length === 0) {
    return []
  }

  const whereParts = [
    `j.article_id IN (${getDuckdbSqlStringList(articleIds).join(', ')})`,
    `j.prompt_id IN (${getDuckdbSqlStringList(scope.promptIds).join(', ')})`,
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

const getHumanAnswerRows = async (scope: ProjectOlapScope, articleIds: string[]): Promise<HumanAnswerRow[]> => {
  if (articleIds.length === 0 || scope.promptIds.length === 0) {
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

const getLlmReviewedArticleRows = async (params: {
  scope: ProjectOlapScope
  from?: string | null
  to?: string | null
  search?: string | null
  prompts?: Record<string, string[]>
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
    return (
      getHasAllProjectPrompts(params.scope.promptIds, articleJudgments)
      && getMatchesPromptFilters(articleJudgments, promptFilters)
    )
  })

  return {scopedArticles: filteredArticles, llmJudgmentsByArticle}
}

const getUnassessedArticleRows = async (params: {
  scope: ProjectOlapScope
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
  const canUsePageMart =
    scope.modelId
    && (await getHasReviewArticlePageRows(scope.projectId))
    && (!hasPromptFilters || (await getHasReviewArticleFilterRows(scope.projectId)))

  if (canUsePageMart) {
    const pageResult = await getReviewedPageRowsFromPageMart({...params, scope})
    const llmJudgmentRows = await getLlmJudgmentRowsFromMart(
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
      return {
        id: article.id,
        articleTitle: article.articleTitle,
        articleCreatedAt: article.articleCreatedAt,
        articleUpdatedAt: article.articleUpdatedAt,
        judgments: judgmentsForArticle,
        judgedPromptIds: getJudgedPromptIds(judgmentsForArticle, scope.promptOrderMap),
        isFullyJudged: true,
        journalTitle: article.journalTitle,
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

  if (scope.modelId) {
    const pageArticles = await getDuckdbReviewedPageRowsFromRollup({...params, scope})
    const llmJudgmentRows = await getLlmJudgmentRowsFromMart(
      scope,
      pageArticles.map((article) => {
        return article.id
      }),
    )
    const llmJudgmentsByArticle = groupByArticleId(llmJudgmentRows)
    const data = pageArticles.map((article) => {
      const judgmentsForArticle = getJudgmentRowsSorted(
        llmJudgmentsByArticle.get(article.id) ?? [],
        scope.promptOrderMap,
      )
      return {
        id: article.id,
        articleTitle: article.articleTitle,
        articleCreatedAt: article.articleCreatedAt,
        articleUpdatedAt: article.articleUpdatedAt,
        judgments: judgmentsForArticle,
        judgedPromptIds: getJudgedPromptIds(judgmentsForArticle, scope.promptOrderMap),
        isFullyJudged: true,
        journalTitle: getJournalTitleFromOriginalData(article.originalData),
      }
    })

    return {data, totalCount: null, page: params.page, limit: params.limit, totalPages: null, nextCursor: null}
  }

  const pageArticles = await getDuckdbReviewedArticleRows({...params, scope})
  const llmJudgmentRows = await getLlmJudgmentRows(
    scope,
    pageArticles.map((article) => {
      return article.id
    }),
  )
  const llmJudgmentsByArticle = groupByArticleId(llmJudgmentRows)
  const data = pageArticles.map((article) => {
    const judgmentsForArticle = getJudgmentRowsSorted(llmJudgmentsByArticle.get(article.id) ?? [], scope.promptOrderMap)
    return {
      id: article.id,
      articleTitle: article.articleTitle,
      articleCreatedAt: article.articleCreatedAt,
      articleUpdatedAt: article.articleUpdatedAt,
      judgments: judgmentsForArticle,
      judgedPromptIds: getJudgedPromptIds(judgmentsForArticle, scope.promptOrderMap),
      isFullyJudged: true,
      journalTitle: getJournalTitleFromOriginalData(article.originalData),
    }
  })

  return {data, totalCount: null, page: params.page, limit: params.limit, totalPages: null, nextCursor: null}
}

export const countArticlesReviewsFromDuckdb = async (
  params: ArticlesReviewsCountParams,
): Promise<ArticlesReviewsCountResponse> => {
  const scope = await getProjectOlapScope(params.projectId)

  if (!scope || scope.promptIds.length === 0) {
    return {totalCount: 0, totalPages: 0}
  }

  const hasPromptFilters = getHasPromptFilters(params.prompts)
  const canUsePageMart =
    scope.modelId
    && (await getHasReviewArticlePageRows(scope.projectId))
    && (!hasPromptFilters || (await getHasReviewArticleFilterRows(scope.projectId)))

  if (canUsePageMart) {
    const totalCount = await countReviewedPageRowsFromPageMart({...params, scope})
    return {totalCount, totalPages: Math.ceil(totalCount / params.limit)}
  }

  if (scope.modelId) {
    const totalCount = await countDuckdbReviewedArticlesFromRollup({...params, scope})
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

  if (scope.modelId) {
    const {rows: pageArticles, totalCount} = await getBothPageRowsFromRollup({...params, scope})
    const totalPages = totalCount > 0 ? Math.ceil(totalCount / params.limit) : 0
    const llmJudgmentsByArticle = groupByArticleId(
      await getLlmJudgmentRowsFromMart(
        scope,
        pageArticles.map((article) => {
          return article.id
        }),
      ),
    )
    const humanRowsByArticle = getHumanRowsByArticleId(
      await getHumanAnswerRows(
        scope,
        pageArticles.map((article) => {
          return article.id
        }),
      ),
    )
    const data = pageArticles.map((article) => {
      return {
        id: article.id,
        articleTitle: article.articleTitle,
        articleCreatedAt: article.articleCreatedAt,
        articleUpdatedAt: article.articleUpdatedAt,
        judgments: getJudgmentRowsSorted(llmJudgmentsByArticle.get(article.id) ?? [], scope.promptOrderMap),
        humanAnswersByPrompt:
          getHumanAnswersByPrompt(scope.promptIds, humanRowsByArticle.get(article.id) ?? []) ?? undefined,
        journalTitle: getJournalTitleFromOriginalData(article.originalData),
      }
    })

    return {data, totalCount, page: params.page, limit: params.limit, totalPages}
  }

  const {scopedArticles, llmJudgmentsByArticle} = await getLlmReviewedArticleRows({...params, scope})
  const humanRowsByArticle = getHumanRowsByArticleId(
    await getHumanAnswerRows(
      scope,
      scopedArticles.map((article) => {
        return article.id
      }),
    ),
  )
  const promptFilters = getPromptFilters(params.prompts)
  const filteredArticles = scopedArticles.filter((article) => {
    const llmRows = llmJudgmentsByArticle.get(article.id) ?? []
    const humanRows = humanRowsByArticle.get(article.id) ?? []
    return (
      getHasAllProjectPrompts(scope.promptIds, llmRows)
      && getMatchesPromptFilters(llmRows, promptFilters)
      && getHasAllProjectPrompts(
        scope.promptIds,
        humanRows.filter((row) => {
          return getHasHumanAnswer(row.answer)
        }),
      )
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
      humanAnswersByPrompt: getHumanAnswersByPrompt(scope.promptIds, humanRows) ?? undefined,
      journalTitle: getJournalTitleFromOriginalData(article.originalData),
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
  const whereParts = [
    `project_id = ${getDuckdbSqlString(params.projectId)}`,
    `prompt_id IN (${getDuckdbSqlStringList(promptIds).join(', ')})`,
    params.fromDate ? `article_created_at >= ${getDuckdbTimestampLiteral(params.fromDate)}` : null,
    params.toDate ? `article_created_at <= ${getDuckdbTimestampLiteral(params.toDate)}` : null,
    params.searchTitle.trim()
      ? `LOWER(COALESCE(article_title, '')) LIKE LOWER(${getDuckdbSqlString(`%${params.searchTitle.trim()}%`)})`
      : null,
  ].filter((part): part is string => {
    return part !== null
  })
  try {
    const rows = await runDuckdbJsonQuery<{promptId: string; answerValue: string}>(`
      SELECT
        prompt_id AS promptId,
        answer_value AS answerValue
      FROM mart.prompt_answer_fact
      WHERE ${whereParts.join(' AND ')}
      GROUP BY prompt_id, answer_value
      ORDER BY prompt_id ASC, answer_value ASC
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
  const whereParts = [
    `project_id = ${getDuckdbSqlString(params.projectId)}`,
    `prompt_id IN (${getDuckdbSqlStringList(promptIds).join(', ')})`,
    params.fromDate ? `article_created_at >= ${getDuckdbTimestampLiteral(params.fromDate)}` : null,
    params.toDate ? `article_created_at <= ${getDuckdbTimestampLiteral(params.toDate)}` : null,
    params.searchTitle.trim()
      ? `LOWER(COALESCE(article_title, '')) LIKE LOWER(${getDuckdbSqlString(`%${params.searchTitle.trim()}%`)})`
      : null,
  ].filter((part): part is string => {
    return part !== null
  })
  try {
    const rows = await runDuckdbJsonQuery<{promptId: string; answerValue: string}>(`
      SELECT
        prompt_id AS promptId,
        answer_value AS answerValue
      FROM mart.prompt_answer_fact
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

  const {totalCount} = await getUnassessedRowsFromRollup({
    scope,
    from: params.projectDateFrom ? params.projectDateFrom.toISOString().slice(0, 10) : null,
    to: params.projectDateTo ? params.projectDateTo.toISOString().slice(0, 10) : null,
  })
  return totalCount
}

export const getUnassessedArticlesFromDuckdb = async (
  params: UnassessedArticlesParams,
): Promise<{articles: UnassessedArticleRow[]; totalCount: number}> => {
  const scope = await getProjectOlapScope(params.projectId)

  if (!scope || scope.promptIds.length === 0 || !scope.modelId) {
    return {articles: [], totalCount: 0}
  }

  const {rows, totalCount} = await getUnassessedRowsFromRollup({
    scope,
    limit: params.limit,
    offset: params.offset,
    from: params.projectDateFrom ? params.projectDateFrom.toISOString().slice(0, 10) : null,
    to: params.projectDateTo ? params.projectDateTo.toISOString().slice(0, 10) : null,
    search: params.search,
  })
  const articlesData: UnassessedArticleRow[] = rows.map((article) => {
    return {
      id: article.id,
      articleId: article.articleId,
      articleTitle: article.articleTitle,
      articleCreatedAt: article.articleCreatedAt,
      articleUpdatedAt: article.articleUpdatedAt,
    }
  })

  return {articles: articlesData, totalCount}
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

  const candidateResult = await getUnassessedCandidateRowsFromRollup({
    scope,
    cursor: params.cursor,
    limit: getCandidateArticlesLimit(params.numberOfPromptsToGet),
  })
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

const getHumanReviewedArticleIdsFromDuckdb = async (params: {
  scope: ProjectOlapScope
  from?: string | null
  to?: string | null
  search?: string | null
}) => {
  const scopedArticles = await getScopedArticles({...params, orderBy: 'created'})
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
  const [sourceProjectId, listType, promptsFilter, from, to, search] = args
  const scope = await getProjectOlapScope(sourceProjectId)

  if (!scope || scope.promptIds.length === 0) {
    return []
  }

  if (listType === 'human') {
    return getHumanReviewedArticleIdsFromRollup({scope, from, to, search})
  }

  if (scope.modelId) {
    if (listType === 'llm') {
      return getReviewedArticleIdsFromRollup({scope, from, to, search, prompts: promptsFilter})
    }

    if (listType === 'unassessed') {
      const {rows} = await getUnassessedRowsFromRollup({scope, from, to, search})
      return rows.map((article) => {
        return article.id
      })
    }

    return getReviewedArticleIdsFromRollup({
      scope,
      from,
      to,
      search,
      prompts: promptsFilter,
      requireAllHumanAnswers: true,
    })
  }

  if (listType === 'llm') {
    const {scopedArticles} = await getLlmReviewedArticleRows({scope, from, to, search, prompts: promptsFilter})
    return scopedArticles.map((article) => {
      return article.id
    })
  }

  if (listType === 'unassessed') {
    const {scopedArticles} = await getUnassessedArticleRows({scope, from, to, search})
    return scopedArticles.map((article) => {
      return article.id
    })
  }

  const {scopedArticles} = await getLlmReviewedArticleRows({scope, from, to, search, prompts: promptsFilter})
  const humanArticleIds = new Set(await getHumanReviewedArticleIdsFromDuckdb({scope, from, to, search}))

  return scopedArticles
    .filter((article) => {
      return humanArticleIds.has(article.id)
    })
    .map((article) => {
      return article.id
    })
}
