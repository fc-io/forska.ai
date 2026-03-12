import {and, asc, eq, gte, inArray, isNull, lte} from 'drizzle-orm'

import {
  articles,
  judgments,
  judgmentsHuman,
  projectPrompts,
  projectRouteLink,
  projects,
  prompts,
} from '../../db/schema.ts'
import {
  buildNumericFilterResult,
  buildNumericFilterResultFromValues,
  type NumericFilterResult,
} from '../../server/routes/projectsRoutes/articlesReviewsFiltersNumeric.ts'
import {getDatabase} from '../../server/utils/getDatabase.ts'
import {getJudgmentAnswerValues, hasMatchingJudgmentAnswer} from '../../server/utils/judgmentAnswers.ts'
import {getArticleInScopeCondition, getCaseInsensitiveContains} from '../../server/utils/sqlitePredicates.ts'
import {getJournalTitleFromOriginalData} from '../../utils/getJournalTitleFromOriginalData.ts'
import type {
  ArticlesReviewsBothParams,
  ArticlesReviewsBothResponse,
  HumanAnswersByPrompt,
} from '../clickhouse/articlesReviewsBothClickHouse.ts'
import type {
  ArticlesReviewsCountParams,
  ArticlesReviewsCountResponse,
  ArticlesReviewsParams,
  ArticlesReviewsResponse,
  ClickHouseJudgmentRow,
} from '../clickhouse/articlesReviewsClickHouse.ts'
import type {ClickHouseFilterParams, ClickHouseFilterResult} from '../clickhouse/articlesReviewsFiltersClickHouse.ts'
import type {selectArticleIdsByFilterClickHouse} from '../clickhouse/selectArticleIdsClickHouse.ts'
import type {
  getUnassessedArticlesFromClickHouse,
  getUnassessedCountFromClickHouse,
  getUnassessedPairsFromClickHouse,
} from '../clickhouse/unassessedArticlesClickHouse.ts'
import {getDuckdbSqlBoolean, getDuckdbSqlString, getDuckdbSqlStringList, runDuckdbJsonQuery} from './duckdbRunner.ts'
import {getOlapDb} from './olapDb.ts'

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

type PaginationCursor = Parameters<typeof getUnassessedPairsFromClickHouse>[0]['cursor']
type PromptQueueEntry = Awaited<ReturnType<typeof getUnassessedPairsFromClickHouse>>['promptEntries'][number]
type UnassessedArticleRow = Awaited<ReturnType<typeof getUnassessedArticlesFromClickHouse>>['articles'][number]

const getPromptFilters = (promptsFilter?: Record<string, string[]>) => {
  return Object.entries(promptsFilter ?? {}).filter(([, answers]) => {
    return Array.isArray(answers) && answers.length > 0
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

const getDuckdbScopeClause = (params: {articleAlias: string; routeIds: string[]; projectId: string}) => {
  const routeClause =
    params.routeIds.length > 0
      ? `EXISTS (
          SELECT 1 FROM app.article_route_link arl
          WHERE arl.article_id = ${params.articleAlias}.id
            AND arl.import_route_id IN (${getDuckdbSqlStringList(params.routeIds).join(', ')})
        )`
      : null
  const projectClause = `EXISTS (
    SELECT 1 FROM app.project_articles pa
    WHERE pa.article_id = ${params.articleAlias}.id
      AND pa.project_id = ${getDuckdbSqlString(params.projectId)}
  )`
  return routeClause ? `(${routeClause} OR ${projectClause})` : projectClause
}

const getActivitySortMs = (article: ScopedArticleRow) => {
  return (article.articleUpdatedAt ?? article.articleCreatedAt ?? article.createdAt).getTime()
}

const getCreatedSortMs = (article: ScopedArticleRow) => {
  return (article.articleCreatedAt ?? article.createdAt).getTime()
}

const getActivitySortDate = (article: ScopedArticleRow) => {
  return article.articleUpdatedAt ?? article.articleCreatedAt ?? article.createdAt
}

const sortArticlesByCreated = (rows: ScopedArticleRow[]) => {
  return [...rows].sort((left, right) => {
    const diff = getCreatedSortMs(right) - getCreatedSortMs(left)
    return diff !== 0 ? diff : left.id.localeCompare(right.id)
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

const getHasMatchingHumanFilters = (rows: HumanAnswerRow[], promptFilters: Array<[string, string[]]>) => {
  return promptFilters.every(([promptId, answers]) => {
    const allowedAnswers = new Set(answers)
    return rows.some((row) => {
      return row.promptId === promptId && row.answer !== null && allowedAnswers.has(row.answer)
    })
  })
}

const getJudgmentRowsSorted = (rows: ClickHouseJudgmentRow[], promptOrderMap: Record<string, number>) => {
  return [...rows].sort((left, right) => {
    const leftOrder = promptOrderMap[left.promptId] ?? Number.MAX_SAFE_INTEGER
    const rightOrder = promptOrderMap[right.promptId] ?? Number.MAX_SAFE_INTEGER
    return leftOrder - rightOrder
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

const toClickHouseJudgmentRow = (row: {
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
}): ClickHouseJudgmentRow => {
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
  if (getOlapDb() === 'duckdb') {
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
          pp."order" AS "order",
          p.prompt_heading AS promptHeading,
          p.original_text AS originalText,
          p.type AS type
        FROM app.project_prompts pp
        INNER JOIN app.prompts p ON p.id = pp.prompt_id
        WHERE pp.project_id = ${getDuckdbSqlString(projectId)}
          AND pp.enabled = TRUE
        ORDER BY pp."order" ASC NULLS LAST, p.created_at ASC
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
        FROM app.projects
        WHERE id = ${getDuckdbSqlString(projectId)}
        LIMIT 1
      `),
      runDuckdbJsonQuery<{importRouteId: string}>(`
        SELECT import_route_id AS importRouteId
        FROM app.project_route_link
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

  const db = getDatabase()
  const [promptRows, projectRows, routeRows] = await Promise.all([
    db
      .select({
        id: prompts.id,
        order: projectPrompts.order,
        promptHeading: prompts.promptHeading,
        originalText: prompts.originalText,
        type: prompts.type,
      })
      .from(projectPrompts)
      .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
      .where(and(eq(projectPrompts.projectId, projectId), eq(projectPrompts.enabled, true)))
      .orderBy(asc(projectPrompts.order), asc(prompts.createdAt)),
    db
      .select({
        id: projects.id,
        dateFrom: projects.dateFrom,
        dateTo: projects.dateTo,
        modelId: projects.modelId,
        useTitle: projects.useTitle,
        useAbstract: projects.useAbstract,
        useFulltext: projects.useFulltext,
        useFulltextNoImages: projects.useFulltextNoImages,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1),
    db
      .select({importRouteId: projectRouteLink.importRouteId})
      .from(projectRouteLink)
      .where(eq(projectRouteLink.projectId, projectId)),
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
        dateFrom: projectRow.dateFrom,
        dateTo: projectRow.dateTo,
        modelId: projectRow.modelId,
        useTitle: projectRow.useTitle ?? true,
        useAbstract: projectRow.useAbstract ?? true,
        useFulltext: projectRow.useFulltext ?? false,
        useFulltextNoImages: projectRow.useFulltextNoImages ?? false,
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
  if (getOlapDb() === 'duckdb') {
    const requestFromDate = parseDateFromInput(params.from, 'T00:00:00.000Z')
    const requestToDate = parseDateFromInput(params.to, 'T23:59:59.999Z')
    const effectiveFromDate = getEffectiveFromDate(params.scope.dateFrom, requestFromDate)
    const effectiveToDate = getEffectiveToDate(params.scope.dateTo, requestToDate)
    const trimmedSearch = params.search?.trim() ?? ''
    const whereParts = [
      getDuckdbScopeClause({articleAlias: 'a', routeIds: params.scope.routeIds, projectId: params.scope.projectId}),
    ]

    if (effectiveFromDate) {
      whereParts.push(`a.article_created_at >= ${effectiveFromDate.getTime()}`)
    }
    if (effectiveToDate) {
      whereParts.push(`a.article_created_at <= ${effectiveToDate.getTime()}`)
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
      FROM app.articles a
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

    return params.orderBy === 'activity'
      ? sortArticlesByActivity(normalizedRows)
      : sortArticlesByCreated(normalizedRows)
  }

  const db = getDatabase()
  const requestFromDate = parseDateFromInput(params.from, 'T00:00:00.000Z')
  const requestToDate = parseDateFromInput(params.to, 'T23:59:59.999Z')
  const effectiveFromDate = getEffectiveFromDate(params.scope.dateFrom, requestFromDate)
  const effectiveToDate = getEffectiveToDate(params.scope.dateTo, requestToDate)
  const trimmedSearch = params.search?.trim() ?? ''
  const whereParts = [
    getArticleInScopeCondition(articles.id, params.scope.routeIds, params.scope.projectId),
    effectiveFromDate ? gte(articles.articleCreatedAt, effectiveFromDate) : null,
    effectiveToDate ? lte(articles.articleCreatedAt, effectiveToDate) : null,
    trimmedSearch ? getCaseInsensitiveContains(articles.articleTitle, trimmedSearch) : null,
  ].filter((part): part is NonNullable<typeof part> => {
    return part !== null
  })
  const query = db
    .select({
      id: articles.id,
      createdAt: articles.createdAt,
      updatedAt: articles.updatedAt,
      articleId: articles.articleId,
      articleTitle: articles.articleTitle,
      articleCreatedAt: articles.articleCreatedAt,
      articleUpdatedAt: articles.articleUpdatedAt,
      importRoute: articles.importRoute,
      url: articles.url,
      fullTextPDF: articles.fullTextPDF,
      fullTextFetchedAt: articles.fullTextFetchedAt,
      fullTextConversionStatus: articles.fullTextConversionStatus,
      originalData: articles.originalData,
    })
    .from(articles)
  const rows = await (whereParts.length > 0 ? query.where(and(...whereParts)) : query)

  return params.orderBy === 'activity' ? sortArticlesByActivity(rows) : sortArticlesByCreated(rows)
}

const getLlmJudgmentRows = async (scope: ProjectOlapScope, articleIds: string[]): Promise<ClickHouseJudgmentRow[]> => {
  if (articleIds.length === 0 || scope.promptIds.length === 0 || !scope.modelId) {
    return []
  }

  if (getOlapDb() === 'duckdb') {
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
        j.answered_original_as_array AS answeredOriginalAsArray,
        j.explanation AS explanation,
        j.quotes AS quotes
      FROM app.judgments j
      INNER JOIN app.articles a ON a.id = j.article_id
      WHERE j.article_id IN (${getDuckdbSqlStringList(articleIds).join(', ')})
        AND j.prompt_id IN (${getDuckdbSqlStringList(scope.promptIds).join(', ')})
        AND j.model_id = ${getDuckdbSqlString(scope.modelId)}
        AND j.use_title = ${getDuckdbSqlBoolean(scope.useTitle)}
        AND j.use_abstract = ${getDuckdbSqlBoolean(scope.useAbstract)}
        AND j.use_fulltext = ${getDuckdbSqlBoolean(scope.useFulltext)}
        AND j.use_fulltext_no_images = ${getDuckdbSqlBoolean(scope.useFulltextNoImages)}
        AND j.deleted_at IS NULL
    `)

    return rows.map((row) => {
      const answerArray = getDuckdbJsonValue(row.answeredOriginalAsArray)
      return toClickHouseJudgmentRow({
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

  const db = getDatabase()
  const rows = await db
    .select({
      id: judgments.id,
      createdAt: judgments.createdAt,
      articleId: judgments.articleId,
      articleTitle: articles.articleTitle,
      articleCreatedAt: articles.articleCreatedAt,
      articleUpdatedAt: articles.articleUpdatedAt,
      articleImportRoute: articles.importRoute,
      promptId: judgments.promptId,
      modelId: judgments.modelId,
      answeredOriginal: judgments.answeredOriginal,
      answeredOriginalAsArray: judgments.answeredOriginalAsArray,
      explanation: judgments.explanation,
      quotes: judgments.quotes,
    })
    .from(judgments)
    .innerJoin(articles, eq(articles.id, judgments.articleId))
    .where(
      and(
        inArray(judgments.articleId, articleIds),
        inArray(judgments.promptId, scope.promptIds),
        eq(judgments.modelId, scope.modelId),
        eq(judgments.useTitle, scope.useTitle),
        eq(judgments.useAbstract, scope.useAbstract),
        eq(judgments.useFulltext, scope.useFulltext),
        eq(judgments.useFulltextNoImages, scope.useFulltextNoImages),
        isNull(judgments.deletedAt),
      ),
    )

  return rows.map((row) => {
    return toClickHouseJudgmentRow(row)
  })
}

const getHumanAnswerRows = async (scope: ProjectOlapScope, articleIds: string[]): Promise<HumanAnswerRow[]> => {
  if (articleIds.length === 0 || scope.promptIds.length === 0) {
    return []
  }

  if (getOlapDb() === 'duckdb') {
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
      FROM app.judgments_human
      WHERE project_id = ${getDuckdbSqlString(scope.projectId)}
        AND is_answered = TRUE
        AND article_id IN (${getDuckdbSqlStringList(articleIds).join(', ')})
        AND prompt_id IN (${getDuckdbSqlStringList(scope.promptIds).join(', ')})
    `)

    return rows.map((row) => {
      return {...row, updatedAt: getDuckdbDateValue(row.updatedAt)}
    })
  }

  const db = getDatabase()
  return db
    .select({
      articleId: judgmentsHuman.articleId,
      promptId: judgmentsHuman.promptId,
      answer: judgmentsHuman.answer,
      updatedAt: judgmentsHuman.updatedAt,
    })
    .from(judgmentsHuman)
    .where(
      and(
        eq(judgmentsHuman.projectId, scope.projectId),
        eq(judgmentsHuman.isAnswered, true),
        inArray(judgmentsHuman.articleId, articleIds),
        inArray(judgmentsHuman.promptId, scope.promptIds),
      ),
    )
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

export const queryArticlesReviewsFromSqlite = async (
  params: ArticlesReviewsParams,
): Promise<ArticlesReviewsResponse> => {
  const scope = await getProjectOlapScope(params.projectId)

  if (!scope || scope.promptIds.length === 0) {
    return {data: [], totalCount: 0, page: params.page, limit: params.limit, totalPages: 0}
  }

  const {scopedArticles, llmJudgmentsByArticle} = await getLlmReviewedArticleRows({...params, scope})
  const totalCount = scopedArticles.length
  const totalPages = totalCount > 0 ? Math.ceil(totalCount / params.limit) : 0
  const safePage = totalPages > 0 ? Math.min(Math.max(params.page, 1), totalPages) : 1
  const offset = (safePage - 1) * params.limit
  const pageArticles = scopedArticles.slice(offset, offset + params.limit)
  const data = pageArticles.map((article) => {
    const judgmentsForArticle = getJudgmentRowsSorted(llmJudgmentsByArticle.get(article.id) ?? [], scope.promptOrderMap)
    return {
      id: article.id,
      articleTitle: article.articleTitle,
      articleCreatedAt: article.articleCreatedAt,
      articleUpdatedAt: article.articleUpdatedAt,
      judgments: judgmentsForArticle,
      judgedPromptIds: getJudgedPromptIds(judgmentsForArticle, scope.promptOrderMap),
      isFullyJudged: getHasAllProjectPrompts(scope.promptIds, judgmentsForArticle),
      journalTitle: getJournalTitleFromOriginalData(article.originalData),
    }
  })

  return {data, totalCount, page: safePage, limit: params.limit, totalPages}
}

export const countArticlesReviewsFromSqlite = async (
  params: ArticlesReviewsCountParams,
): Promise<ArticlesReviewsCountResponse> => {
  const scope = await getProjectOlapScope(params.projectId)

  if (!scope || scope.promptIds.length === 0) {
    return {totalCount: 0, totalPages: 0}
  }

  const {scopedArticles} = await getLlmReviewedArticleRows({...params, scope})
  const totalCount = scopedArticles.length
  return {totalCount, totalPages: Math.ceil(totalCount / params.limit)}
}

export const queryArticlesReviewsBothFromSqlite = async (
  params: ArticlesReviewsBothParams,
): Promise<ArticlesReviewsBothResponse> => {
  const scope = await getProjectOlapScope(params.projectId)

  if (!scope || scope.promptIds.length === 0) {
    return {data: [], totalCount: 0, page: params.page, limit: params.limit, totalPages: 0}
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
  const safePage = totalPages > 0 ? Math.min(Math.max(params.page, 1), totalPages) : 1
  const offset = (safePage - 1) * params.limit
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

  return {data, totalCount, page: safePage, limit: params.limit, totalPages}
}

export const getDatabaseBasedFiltersFromSqlite = async (
  params: ClickHouseFilterParams,
): Promise<ClickHouseFilterResult[]> => {
  const scope = await getProjectOlapScope(params.projectId)
  const databasePrompts = params.prompts.filter((prompt) => {
    return prompt.strategy === 'database'
  })

  if (!scope || databasePrompts.length === 0 || !scope.modelId) {
    return databasePrompts.map((prompt) => {
      return {promptId: prompt.promptId, promptName: prompt.promptName, answeredOriginalValues: []}
    })
  }

  const scopedArticles = await getScopedArticles({
    scope,
    from: params.fromDate ? params.fromDate.toISOString().slice(0, 10) : null,
    to: params.toDate ? params.toDate.toISOString().slice(0, 10) : null,
    search: params.searchTitle,
    orderBy: 'created',
  })
  const promptIds = databasePrompts.map((prompt) => {
    return prompt.promptId
  })

  if (scopedArticles.length === 0) {
    return databasePrompts.map((prompt) => {
      return {promptId: prompt.promptId, promptName: prompt.promptName, answeredOriginalValues: []}
    })
  }

  const db = getDatabase()
  const judgmentRows = await db
    .select({
      promptId: judgments.promptId,
      answeredOriginal: judgments.answeredOriginal,
      answeredOriginalAsArray: judgments.answeredOriginalAsArray,
    })
    .from(judgments)
    .where(
      and(
        inArray(
          judgments.articleId,
          scopedArticles.map((article) => {
            return article.id
          }),
        ),
        inArray(judgments.promptId, promptIds),
        eq(judgments.modelId, scope.modelId),
        eq(judgments.useTitle, scope.useTitle),
        eq(judgments.useAbstract, scope.useAbstract),
        eq(judgments.useFulltext, scope.useFulltext),
        eq(judgments.useFulltextNoImages, scope.useFulltextNoImages),
        isNull(judgments.deletedAt),
      ),
    )
  const valuesByPromptId = judgmentRows.reduce<Map<string, Set<string>>>((rowMap, row) => {
    const currentValues = rowMap.get(row.promptId) ?? new Set<string>()
    getJudgmentAnswerValues(row).forEach((value) => {
      currentValues.add(value)
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

export const getNumericFiltersFromSqlite = async (params: ClickHouseFilterParams): Promise<NumericFilterResult[]> => {
  const scope = await getProjectOlapScope(params.projectId)
  const numericPrompts = params.prompts.filter((prompt) => {
    return prompt.strategy === 'numeric'
  })

  if (!scope || numericPrompts.length === 0 || !scope.modelId) {
    return numericPrompts.map((prompt) => {
      return buildNumericFilterResult(prompt.promptId, prompt.promptName, null, null, prompt.specialValues ?? [])
    })
  }

  const scopedArticles = await getScopedArticles({
    scope,
    from: params.fromDate ? params.fromDate.toISOString().slice(0, 10) : null,
    to: params.toDate ? params.toDate.toISOString().slice(0, 10) : null,
    search: params.searchTitle,
    orderBy: 'created',
  })
  const promptIds = numericPrompts.map((prompt) => {
    return prompt.promptId
  })

  if (scopedArticles.length === 0) {
    return numericPrompts.map((prompt) => {
      return buildNumericFilterResult(prompt.promptId, prompt.promptName, null, null, prompt.specialValues ?? [])
    })
  }

  const db = getDatabase()
  const judgmentRows = await db
    .select({promptId: judgments.promptId, answeredOriginal: judgments.answeredOriginal})
    .from(judgments)
    .where(
      and(
        inArray(
          judgments.articleId,
          scopedArticles.map((article) => {
            return article.id
          }),
        ),
        inArray(judgments.promptId, promptIds),
        eq(judgments.modelId, scope.modelId),
        eq(judgments.useTitle, scope.useTitle),
        eq(judgments.useAbstract, scope.useAbstract),
        eq(judgments.useFulltext, scope.useFulltext),
        eq(judgments.useFulltextNoImages, scope.useFulltextNoImages),
        isNull(judgments.deletedAt),
      ),
    )
  const valuesByPromptId = judgmentRows.reduce<Map<string, Set<number>>>((rowMap, row) => {
    const trimmedValue = row.answeredOriginal?.trim() ?? ''
    const parsedValue = Number.parseInt(trimmedValue, 10)
    const currentValues = rowMap.get(row.promptId) ?? new Set<number>()

    if (trimmedValue !== '' && Number.isFinite(parsedValue)) {
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
}

export const getUnassessedCountFromSqlite = async (
  params: Parameters<typeof getUnassessedCountFromClickHouse>[0],
): ReturnType<typeof getUnassessedCountFromClickHouse> => {
  const scope = await getProjectOlapScope(params.projectId)

  if (!scope || scope.promptIds.length === 0) {
    return 0
  }

  const {scopedArticles} = await getUnassessedArticleRows({scope})
  return scopedArticles.length
}

export const getUnassessedArticlesFromSqlite = async (
  params: Parameters<typeof getUnassessedArticlesFromClickHouse>[0],
): ReturnType<typeof getUnassessedArticlesFromClickHouse> => {
  const scope = await getProjectOlapScope(params.projectId)

  if (!scope || scope.promptIds.length === 0) {
    return {articles: [], totalCount: 0}
  }

  const {scopedArticles} = await getUnassessedArticleRows({
    scope,
    from: params.projectDateFrom ? params.projectDateFrom.toISOString().slice(0, 10) : null,
    to: params.projectDateTo ? params.projectDateTo.toISOString().slice(0, 10) : null,
    search: params.search,
  })
  const pageArticles = scopedArticles.slice(params.offset, params.offset + params.limit)
  const articlesData: UnassessedArticleRow[] = pageArticles.map((article) => {
    return {
      id: article.id,
      articleId: article.articleId,
      articleTitle: article.articleTitle,
      articleCreatedAt: article.articleCreatedAt,
      articleUpdatedAt: article.articleUpdatedAt,
    }
  })

  return {articles: articlesData, totalCount: scopedArticles.length}
}

const getCandidateArticlesLimit = (numberOfPromptsToGet: number) => {
  const requested = Math.max(1, Math.trunc(numberOfPromptsToGet))
  const scaled = requested * 5
  return Math.min(20_000, Math.max(2_000, scaled))
}

const getArticlesAfterCursor = (articlesToFilter: ScopedArticleRow[], cursor: Exclude<PaginationCursor, null>) => {
  return articlesToFilter.filter((article) => {
    const articleSortDate = getActivitySortDate(article)
    return (
      articleSortDate.getTime() < cursor.lastDate.getTime()
      || (articleSortDate.getTime() === cursor.lastDate.getTime() && article.id < cursor.lastArticleId)
    )
  })
}

export const getUnassessedPairsFromSqlite = async (
  params: Parameters<typeof getUnassessedPairsFromClickHouse>[0],
): ReturnType<typeof getUnassessedPairsFromClickHouse> => {
  const scope = await getProjectOlapScope(params.projectId)

  if (!scope || scope.promptIds.length === 0) {
    return {promptEntries: [], nextCursor: null}
  }

  const {scopedArticles, llmJudgmentsByArticle} = await getUnassessedArticleRows({scope})
  const cursorFilteredArticles = params.cursor ? getArticlesAfterCursor(scopedArticles, params.cursor) : scopedArticles
  const candidateArticles = cursorFilteredArticles.slice(0, getCandidateArticlesLimit(params.numberOfPromptsToGet))
  const promptEntries = candidateArticles.flatMap<PromptQueueEntry>((article) => {
    const presentPromptIds = new Set(
      (llmJudgmentsByArticle.get(article.id) ?? []).map((row) => {
        return row.promptId
      }),
    )
    return scope.promptIds
      .filter((promptId) => {
        return !presentPromptIds.has(promptId)
      })
      .map((promptId) => {
        return {articleId: article.id, promptId}
      })
  })
  const limitedPromptEntries = promptEntries.slice(0, params.numberOfPromptsToGet)
  const hasMoreArticles = cursorFilteredArticles.length > candidateArticles.length
  const lastPromptArticleId = limitedPromptEntries[limitedPromptEntries.length - 1]?.articleId ?? null
  const nextCursorArticle = lastPromptArticleId
    ? (candidateArticles.find((article) => {
        return article.id === lastPromptArticleId
      }) ?? null)
    : hasMoreArticles
      ? (candidateArticles[candidateArticles.length - 1] ?? null)
      : null

  return {
    promptEntries: limitedPromptEntries,
    nextCursor: nextCursorArticle
      ? {lastDate: getActivitySortDate(nextCursorArticle), lastArticleId: nextCursorArticle.id}
      : null,
  }
}

const getHumanReviewedArticleIdsFromSqlite = async (params: {
  scope: ProjectOlapScope
  from?: string | null
  to?: string | null
  search?: string | null
  prompts?: Record<string, string[]>
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
  const promptFilters = getPromptFilters(params.prompts)

  return scopedArticles
    .filter((article) => {
      const humanRows = humanRowsByArticle.get(article.id) ?? []
      return (
        getHasAllProjectPrompts(
          params.scope.promptIds,
          humanRows.filter((row) => {
            return getHasHumanAnswer(row.answer)
          }),
        ) && getHasMatchingHumanFilters(humanRows, promptFilters)
      )
    })
    .map((article) => {
      return article.id
    })
}

export const selectArticleIdsByFilterSqlite = async (
  ...args: Parameters<typeof selectArticleIdsByFilterClickHouse>
): ReturnType<typeof selectArticleIdsByFilterClickHouse> => {
  const [sourceProjectId, listType, promptsFilter, from, to, search] = args
  const scope = await getProjectOlapScope(sourceProjectId)

  if (!scope || scope.promptIds.length === 0) {
    return []
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

  if (listType === 'human') {
    return getHumanReviewedArticleIdsFromSqlite({scope, from, to, search, prompts: promptsFilter})
  }

  const {scopedArticles} = await getLlmReviewedArticleRows({scope, from, to, search, prompts: promptsFilter})
  const humanArticleIds = new Set(
    await getHumanReviewedArticleIdsFromSqlite({scope, from, to, search, prompts: promptsFilter}),
  )

  return scopedArticles
    .filter((article) => {
      return humanArticleIds.has(article.id)
    })
    .map((article) => {
      return article.id
    })
}
