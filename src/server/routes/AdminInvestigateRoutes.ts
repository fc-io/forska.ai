/**
 * Admin routes for investigating unexpected answer values
 */
import {and, eq, inArray, isNotNull, or, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {
  articles,
  importRoute,
  judgments,
  projectArticles,
  projectPrompts,
  projectRouteLink,
  projects,
  prompts,
} from '../../db/schema.ts'
import {requireUserAuth} from '../utils/authGuard.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'

const parseArktypeOptions = (typeStr: string | null): string[] => {
  if (!typeStr) return []
  const matches = typeStr.match(/['"]([^'"]+)['"]/g)
  return (
    matches?.map((m) => {
      return m.slice(1, -1)
    }) ?? []
  )
}

const isArrayType = (typeStr: string | null): boolean => {
  if (!typeStr) return false
  return typeStr.includes('[]')
}

const isOpenEndedType = (typeStr: string | null): boolean => {
  if (!typeStr) return true
  const hasQuotedLiterals = /['"]/.test(typeStr)
  return !hasQuotedLiterals
}

const deleteUnexpectedJudgments = async (
  projectId: string | null,
  promptId: string,
  unexpectedValue: string | null,
) => {
  const db = getDatabase()

  const [prompt] = await db
    .select({id: prompts.id, type: prompts.type})
    .from(prompts)
    .where(eq(prompts.id, promptId))
    .limit(1)

  if (!prompt || isOpenEndedType(prompt.type)) {
    return {deleted: 0}
  }

  const expectedOptions = parseArktypeOptions(prompt.type)
  if (expectedOptions.length === 0) {
    return {deleted: 0}
  }

  let projectScope: ProjectScope | null = null
  if (projectId) {
    projectScope = await fetchProjectScope(projectId)
    if (!projectScope) {
      return {deleted: 0}
    }
  }

  const isArray = isArrayType(prompt.type)
  const now = new Date()

  // Build WHERE conditions - with or without project scope
  const baseConditions = [eq(judgments.promptId, promptId), sql`${judgments.deletedAt} IS NULL`]

  if (projectScope) {
    baseConditions.push(eq(judgments.modelId, projectScope.modelId))
    baseConditions.push(eq(judgments.useTitle, projectScope.useTitle))
    baseConditions.push(eq(judgments.useAbstract, projectScope.useAbstract))
    baseConditions.push(eq(judgments.useFulltext, projectScope.useFulltext))
    baseConditions.push(eq(judgments.useFulltextNoImages, projectScope.useFulltextNoImages))

    const articleScopeConditions = []
    if (projectScope.importRoutes.length > 0) {
      articleScopeConditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${articles}
          WHERE ${articles.id} = ${judgments.articleId}
          AND ${articles.importRoute} IN (${sql.join(
            projectScope.importRoutes.map((r) => {
              return sql`${r}`
            }),
            sql`, `,
          )})
        )`,
      )
    }
    if (projectScope.curatedArticleIds.length > 0) {
      articleScopeConditions.push(inArray(judgments.articleId, projectScope.curatedArticleIds))
    }
    if (articleScopeConditions.length > 0) {
      baseConditions.push(or(...articleScopeConditions))
    }

    if (projectScope.dateFrom) {
      baseConditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${articles}
          WHERE ${articles.id} = ${judgments.articleId}
          AND ${articles.articleCreatedAt} >= ${projectScope.dateFrom}
        )`,
      )
    }
    if (projectScope.dateTo) {
      baseConditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${articles}
          WHERE ${articles.id} = ${judgments.articleId}
          AND ${articles.articleCreatedAt} <= ${projectScope.dateTo}
        )`,
      )
    }
  }

  if (isArray) {
    const arrayAnswersQuery = await db
      .select({
        id: judgments.id,
        answeredOriginalAsArray: judgments.answeredOriginalAsArray,
        articleId: judgments.articleId,
        modelId: judgments.modelId,
        createdAt: judgments.createdAt,
        useTitle: judgments.useTitle,
        useAbstract: judgments.useAbstract,
        useFulltext: judgments.useFulltext,
        useFulltextNoImages: judgments.useFulltextNoImages,
      })
      .from(judgments)
      .where(and(...baseConditions))

    const toDelete = arrayAnswersQuery.filter((j) => {
      const arrayAnswer = j.answeredOriginalAsArray
      const currentValue = arrayAnswer === null ? null : JSON.stringify(arrayAnswer)
      return currentValue === unexpectedValue
    })

    if (toDelete.length === 0) {
      return {deleted: 0}
    }

    const idsToDelete = toDelete.map((j) => {
      return j.id
    })
    await db.update(judgments).set({deletedAt: now, updatedAt: now}).where(inArray(judgments.id, idsToDelete))

    const articles_map = new Map<string, typeof articles.$inferSelect>()
    const articleIds = [
      ...new Set(
        toDelete.map((j) => {
          return j.articleId
        }),
      ),
    ]
    const articleRows = await db.select().from(articles).where(inArray(articles.id, articleIds))
    for (const article of articleRows) {
      articles_map.set(article.id, article)
    }

    const {writeJudgmentAnalyticsToParquet, getJudgmentsParquetDualWriteConfig} = await import(
      '../../services/parquet/judgmentsParquetDualWrite.ts'
    )
    const parquetConfig = getJudgmentsParquetDualWriteConfig()

    for (const judgment of toDelete) {
      const article = articles_map.get(judgment.articleId)
      if (!article) continue

      const denormalizedRecord = {
        id: judgment.id,
        createdAt: judgment.createdAt,
        deletedAt: now,
        articleId: article.id,
        articleTitle: article.articleTitle,
        articleCreatedAt: article.articleCreatedAt,
        articleUpdatedAt: article.articleUpdatedAt,
        articleCreatedYear: article.articleCreatedAt ? article.articleCreatedAt.getUTCFullYear() : null,
        articleUpdatedYear: article.articleUpdatedAt ? article.articleUpdatedAt.getUTCFullYear() : null,
        articleImportRoute: article.importRoute,
        articleImportedBy: article.importedBy,
        promptId,
        modelId: judgment.modelId,
        useTitle: judgment.useTitle,
        useAbstract: judgment.useAbstract,
        useFulltext: judgment.useFulltext,
        useFulltextNoImages: judgment.useFulltextNoImages,
        answeredOriginal: null,
        answeredOriginalAsArray: judgment.answeredOriginalAsArray,
        explanation: null,
        quotes: null,
      }

      await writeJudgmentAnalyticsToParquet(denormalizedRecord)
    }

    if (!parquetConfig.enabled) {
      const {getClickhouseClient} = await import('../../services/clickhouse/clickhouseClient.ts')
      const chClient = getClickhouseClient()
      const clickhouseRecords = toDelete.map((judgment) => {
        const article = articles_map.get(judgment.articleId)
        return {
          id: judgment.id,
          createdAt: formatDateForClickHouse(judgment.createdAt),
          deletedAt: formatDateForClickHouse(now),
          articleId: judgment.articleId,
          articleTitle: article?.articleTitle ?? null,
          articleCreatedAt: formatDateForClickHouse(article?.articleCreatedAt ?? null),
          articleUpdatedAt: formatDateForClickHouse(article?.articleUpdatedAt ?? null),
          articleCreatedYear: article?.articleCreatedAt ? article.articleCreatedAt.getUTCFullYear() : null,
          articleUpdatedYear: article?.articleUpdatedAt ? article.articleUpdatedAt.getUTCFullYear() : null,
          articleImportRoute: article?.importRoute ?? null,
          articleImportedBy: article?.importedBy ?? null,
          promptId,
          modelId: judgment.modelId,
          useTitle: judgment.useTitle,
          useAbstract: judgment.useAbstract,
          useFulltext: judgment.useFulltext,
          useFulltextNoImages: judgment.useFulltextNoImages,
          answeredOriginal: null,
          answeredOriginalAsArray: judgment.answeredOriginalAsArray ?? [],
          explanation: null,
          quotes: null,
        }
      })

      await chClient.insert({table: 'forska.judgments', values: clickhouseRecords, format: 'JSONEachRow'})
      console.log(`[Admin] Inserted ${clickhouseRecords.length} tombstone records to ClickHouse`)
    }

    return {deleted: toDelete.length}
  }

  const stringAnswersQuery = await db
    .select({
      id: judgments.id,
      answeredOriginal: judgments.answeredOriginal,
      articleId: judgments.articleId,
      modelId: judgments.modelId,
      createdAt: judgments.createdAt,
      useTitle: judgments.useTitle,
      useAbstract: judgments.useAbstract,
      useFulltext: judgments.useFulltext,
      useFulltextNoImages: judgments.useFulltextNoImages,
    })
    .from(judgments)
    .where(and(...baseConditions))

  const toDelete = stringAnswersQuery.filter((j) => {
    return j.answeredOriginal === unexpectedValue
  })

  if (toDelete.length === 0) {
    return {deleted: 0}
  }

  const idsToDelete = toDelete.map((j) => {
    return j.id
  })
  await db.update(judgments).set({deletedAt: now, updatedAt: now}).where(inArray(judgments.id, idsToDelete))

  const articles_map = new Map<string, typeof articles.$inferSelect>()
  const articleIds = [
    ...new Set(
      toDelete.map((j) => {
        return j.articleId
      }),
    ),
  ]
  const articleRows = await db.select().from(articles).where(inArray(articles.id, articleIds))
  for (const article of articleRows) {
    articles_map.set(article.id, article)
  }

  const {writeJudgmentAnalyticsToParquet, getJudgmentsParquetDualWriteConfig} = await import(
    '../../services/parquet/judgmentsParquetDualWrite.ts'
  )
  const parquetConfig = getJudgmentsParquetDualWriteConfig()

  for (const judgment of toDelete) {
    const article = articles_map.get(judgment.articleId)
    if (!article) continue

    const denormalizedRecord = {
      id: judgment.id,
      createdAt: judgment.createdAt,
      deletedAt: now,
      articleId: article.id,
      articleTitle: article.articleTitle,
      articleCreatedAt: article.articleCreatedAt,
      articleUpdatedAt: article.articleUpdatedAt,
      articleCreatedYear: article.articleCreatedAt ? article.articleCreatedAt.getUTCFullYear() : null,
      articleUpdatedYear: article.articleUpdatedAt ? article.articleUpdatedAt.getUTCFullYear() : null,
      articleImportRoute: article.importRoute,
      articleImportedBy: article.importedBy,
      promptId,
      modelId: judgment.modelId,
      useTitle: judgment.useTitle,
      useAbstract: judgment.useAbstract,
      useFulltext: judgment.useFulltext,
      useFulltextNoImages: judgment.useFulltextNoImages,
      answeredOriginal: judgment.answeredOriginal,
      answeredOriginalAsArray: null,
      explanation: null,
      quotes: null,
    }

    await writeJudgmentAnalyticsToParquet(denormalizedRecord)
  }

  if (!parquetConfig.enabled) {
    const {getClickhouseClient} = await import('../../services/clickhouse/clickhouseClient.ts')
    const chClient = getClickhouseClient()
    const clickhouseRecords = toDelete.map((judgment) => {
      const article = articles_map.get(judgment.articleId)
      return {
        id: judgment.id,
        createdAt: formatDateForClickHouse(judgment.createdAt),
        deletedAt: formatDateForClickHouse(now),
        articleId: judgment.articleId,
        articleTitle: article?.articleTitle ?? null,
        articleCreatedAt: formatDateForClickHouse(article?.articleCreatedAt ?? null),
        articleUpdatedAt: formatDateForClickHouse(article?.articleUpdatedAt ?? null),
        articleCreatedYear: article?.articleCreatedAt ? article.articleCreatedAt.getUTCFullYear() : null,
        articleUpdatedYear: article?.articleUpdatedAt ? article.articleUpdatedAt.getUTCFullYear() : null,
        articleImportRoute: article?.importRoute ?? null,
        articleImportedBy: article?.importedBy ?? null,
        promptId,
        modelId: judgment.modelId,
        useTitle: judgment.useTitle,
        useAbstract: judgment.useAbstract,
        useFulltext: judgment.useFulltext,
        useFulltextNoImages: judgment.useFulltextNoImages,
        answeredOriginal: judgment.answeredOriginal,
        answeredOriginalAsArray: [],
        explanation: null,
        quotes: null,
      }
    })

    await chClient.insert({table: 'forska.judgments', values: clickhouseRecords, format: 'JSONEachRow'})
    console.log(`[Admin] Inserted ${clickhouseRecords.length} tombstone records to ClickHouse`)
  }

  return {deleted: toDelete.length}
}

const formatDateForClickHouse = (date: Date | null): string | null => {
  if (!date) return null
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hours = String(date.getUTCHours()).padStart(2, '0')
  const minutes = String(date.getUTCMinutes()).padStart(2, '0')
  const seconds = String(date.getUTCSeconds()).padStart(2, '0')
  const millis = String(date.getUTCMilliseconds()).padStart(3, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${millis}`
}

type ProjectScope = {
  modelId: string
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  dateFrom: Date | null
  dateTo: Date | null
  importRoutes: string[]
  curatedArticleIds: string[]
}

const fetchProjectScope = async (projectId: string): Promise<ProjectScope | null> => {
  const db = getDatabase()

  const [project] = await db
    .select({
      modelId: projects.modelId,
      useTitle: projects.useTitle,
      useAbstract: projects.useAbstract,
      useFulltext: projects.useFulltext,
      useFulltextNoImages: projects.useFulltextNoImages,
      dateFrom: projects.dateFrom,
      dateTo: projects.dateTo,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)

  if (!project) return null

  const projectImportRoutes = await db
    .select({route: importRoute.route})
    .from(projectRouteLink)
    .innerJoin(importRoute, eq(importRoute.id, projectRouteLink.importRouteId))
    .where(eq(projectRouteLink.projectId, projectId))

  const curatedArticles = await db
    .select({articleId: projectArticles.articleId})
    .from(projectArticles)
    .where(eq(projectArticles.projectId, projectId))

  return {
    modelId: project.modelId,
    useTitle: project.useTitle,
    useAbstract: project.useAbstract,
    useFulltext: project.useFulltext,
    useFulltextNoImages: project.useFulltextNoImages,
    dateFrom: project.dateFrom,
    dateTo: project.dateTo,
    importRoutes: projectImportRoutes.map((r) => {
      return r.route
    }),
    curatedArticleIds: curatedArticles.map((a) => {
      return a.articleId
    }),
  }
}

const syncDeletedJudgmentsToClickhouse = async () => {
  const db = getDatabase()
  const {getClickhouseClient} = await import('../../services/clickhouse/clickhouseClient.ts')
  const chClient = getClickhouseClient()

  const deletedJudgments = await db
    .select({
      id: judgments.id,
      createdAt: judgments.createdAt,
      deletedAt: judgments.deletedAt,
      articleId: judgments.articleId,
      promptId: judgments.promptId,
      modelId: judgments.modelId,
      useTitle: judgments.useTitle,
      useAbstract: judgments.useAbstract,
      useFulltext: judgments.useFulltext,
      useFulltextNoImages: judgments.useFulltextNoImages,
      answeredOriginal: judgments.answeredOriginal,
      answeredOriginalAsArray: judgments.answeredOriginalAsArray,
    })
    .from(judgments)
    .where(isNotNull(judgments.deletedAt))

  if (deletedJudgments.length === 0) {
    return {synced: 0, message: 'No deleted judgments to sync'}
  }

  const articleIds = [
    ...new Set(
      deletedJudgments.map((j) => {
        return j.articleId
      }),
    ),
  ]
  const articleRows = await db.select().from(articles).where(inArray(articles.id, articleIds))
  const articlesMap = new Map(
    articleRows.map((a) => {
      return [a.id, a]
    }),
  )

  const clickhouseRecords = deletedJudgments.map((judgment) => {
    const article = articlesMap.get(judgment.articleId)
    return {
      id: judgment.id,
      createdAt: formatDateForClickHouse(judgment.createdAt),
      deletedAt: formatDateForClickHouse(judgment.deletedAt),
      articleId: judgment.articleId,
      articleTitle: article?.articleTitle ?? null,
      articleCreatedAt: formatDateForClickHouse(article?.articleCreatedAt ?? null),
      articleUpdatedAt: formatDateForClickHouse(article?.articleUpdatedAt ?? null),
      articleCreatedYear: article?.articleCreatedAt ? article.articleCreatedAt.getUTCFullYear() : null,
      articleUpdatedYear: article?.articleUpdatedAt ? article.articleUpdatedAt.getUTCFullYear() : null,
      articleImportRoute: article?.importRoute ?? null,
      articleImportedBy: article?.importedBy ?? null,
      promptId: judgment.promptId,
      modelId: judgment.modelId,
      useTitle: judgment.useTitle,
      useAbstract: judgment.useAbstract,
      useFulltext: judgment.useFulltext,
      useFulltextNoImages: judgment.useFulltextNoImages,
      answeredOriginal: judgment.answeredOriginal,
      answeredOriginalAsArray: judgment.answeredOriginalAsArray ?? [],
      explanation: null,
      quotes: null,
    }
  })

  await chClient.insert({table: 'forska.judgments', values: clickhouseRecords, format: 'JSONEachRow'})

  return {
    synced: clickhouseRecords.length,
    message: `Synced ${clickhouseRecords.length} deleted judgments to ClickHouse`,
  }
}

const getClickhouseSyncStatus = async () => {
  const db = getDatabase()
  const {getClickhouseClient, pingClickhouse} = await import('../../services/clickhouse/clickhouseClient.ts')

  const [reachable, pgLatestResult] = await Promise.all([
    pingClickhouse(),
    db
      .select({createdAt: judgments.createdAt})
      .from(judgments)
      .orderBy(sql`${judgments.createdAt} DESC`)
      .limit(1),
  ])

  const pgMaxCreatedAt = pgLatestResult[0]?.createdAt ? new Date(pgLatestResult[0].createdAt) : null

  if (!reachable) {
    return {
      reachable: false,
      postgres: {maxCreatedAt: pgMaxCreatedAt?.toISOString() ?? null},
      clickhouse: {maxCreatedAt: null},
      lagMs: null,
      lagSeconds: null,
      status: 'unreachable' as const,
      message: 'ClickHouse is not reachable',
    }
  }

  const chClient = getClickhouseClient()

  const queryWithTimeout = async <T>(queryFn: () => Promise<T>, timeoutMs: number = 10000): Promise<T> => {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('ClickHouse query timeout')), timeoutMs)
    })
    return Promise.race([queryFn(), timeoutPromise])
  }

  try {
    const chResult = await queryWithTimeout(async () => {
      const result = await chClient.query({
        query: `SELECT max(createdAt) AS maxCreatedAt FROM judgments WHERE deletedAt IS NULL`,
        format: 'JSONEachRow',
      })
      return result.json<{maxCreatedAt: string | null}>()
    })

    const [chRow] = chResult
    // ClickHouse returns timestamps without timezone - treat as UTC
    const chMaxCreatedAt = chRow?.maxCreatedAt ? new Date(chRow.maxCreatedAt + 'Z') : null

    const lagMs = pgMaxCreatedAt && chMaxCreatedAt ? pgMaxCreatedAt.getTime() - chMaxCreatedAt.getTime() : null
    const lagSeconds = lagMs !== null ? Math.round(lagMs / 1000) : null

    let status: 'synced' | 'behind' | 'critical'
    let message: string

    if (lagSeconds === null || lagSeconds <= 60) {
      status = 'synced'
      message = 'ClickHouse is in sync with PostgreSQL'
    } else if (lagSeconds < 3600) {
      status = 'behind'
      message = `ClickHouse is behind by ${Math.round(lagSeconds / 60)} minutes`
    } else {
      status = 'critical'
      message = `ClickHouse is behind by ${Math.round(lagSeconds / 3600)} hours`
    }

    return {
      reachable: true,
      postgres: {maxCreatedAt: pgMaxCreatedAt?.toISOString() ?? null},
      clickhouse: {maxCreatedAt: chMaxCreatedAt?.toISOString() ?? null},
      lagMs,
      lagSeconds,
      status,
      message,
    }
  } catch (error) {
    console.error('[ClickHouse] Query failed:', error)
    return {
      reachable: false,
      postgres: {maxCreatedAt: pgMaxCreatedAt?.toISOString() ?? null},
      clickhouse: {maxCreatedAt: null},
      lagMs: null,
      lagSeconds: null,
      status: 'unreachable' as const,
      message: error instanceof Error ? `ClickHouse error: ${error.message}` : 'ClickHouse query failed',
    }
  }
}

type BackfillProgress = {
  status: 'idle' | 'running' | 'completed' | 'error'
  totalToSync: number
  synced: number
  currentBatch: number
  totalBatches: number
  startedAt: Date | null
  completedAt: Date | null
  error: string | null
  estimatedSecondsRemaining: number | null
}

const backfillProgress: BackfillProgress = {
  status: 'idle',
  totalToSync: 0,
  synced: 0,
  currentBatch: 0,
  totalBatches: 0,
  startedAt: null,
  completedAt: null,
  error: null,
  estimatedSecondsRemaining: null,
}

const getBackfillProgress = () => {
  return {...backfillProgress}
}

type AutoSyncAllProgress = {
  status: 'idle' | 'running' | 'completed' | 'error'
  totalPrompts: number
  processedPrompts: number
  currentPromptId: string | null
  currentPromptHeading: string | null
  totalDeleted: number
  deletedByPrompt: Array<{promptId: string; promptHeading: string; deleted: number}>
  startedAt: Date | null
  completedAt: Date | null
  error: string | null
}

const autoSyncAllProgress: AutoSyncAllProgress = {
  status: 'idle',
  totalPrompts: 0,
  processedPrompts: 0,
  currentPromptId: null,
  currentPromptHeading: null,
  totalDeleted: 0,
  deletedByPrompt: [],
  startedAt: null,
  completedAt: null,
  error: null,
}

const getAutoSyncAllProgress = () => {
  return {...autoSyncAllProgress, deletedByPrompt: [...autoSyncAllProgress.deletedByPrompt]}
}

const runAutoSyncAllAsync = async (projectId: string | null) => {
  if (autoSyncAllProgress.status === 'running') {
    return {started: false, message: 'Auto-sync already in progress'}
  }

  autoSyncAllProgress.status = 'running'
  autoSyncAllProgress.totalPrompts = 0
  autoSyncAllProgress.processedPrompts = 0
  autoSyncAllProgress.currentPromptId = null
  autoSyncAllProgress.currentPromptHeading = null
  autoSyncAllProgress.totalDeleted = 0
  autoSyncAllProgress.deletedByPrompt = []
  autoSyncAllProgress.startedAt = new Date()
  autoSyncAllProgress.completedAt = null
  autoSyncAllProgress.error = null

  const runSync = async () => {
    const db = getDatabase()

    try {
      console.log(
        `[AutoSyncAll] Starting auto-sync all unexpected answers${projectId ? ` for project ${projectId}` : ''}...`,
      )

      let promptsToProcess: Array<{id: string; promptHeading: string | null; type: string | null}>

      if (projectId) {
        promptsToProcess = await db
          .select({id: prompts.id, promptHeading: prompts.promptHeading, type: prompts.type})
          .from(prompts)
          .innerJoin(projectPrompts, eq(projectPrompts.promptId, prompts.id))
          .where(
            and(eq(projectPrompts.projectId, projectId), isNotNull(prompts.type), eq(projectPrompts.enabled, true)),
          )
      } else {
        promptsToProcess = await db
          .select({id: prompts.id, promptHeading: prompts.promptHeading, type: prompts.type})
          .from(prompts)
          .where(isNotNull(prompts.type))
      }

      const filteredPrompts = promptsToProcess.filter((p) => !isOpenEndedType(p.type))

      autoSyncAllProgress.totalPrompts = filteredPrompts.length
      console.log(`[AutoSyncAll] Found ${filteredPrompts.length} prompts with defined types to process`)

      for (const prompt of filteredPrompts) {
        autoSyncAllProgress.currentPromptId = prompt.id
        autoSyncAllProgress.currentPromptHeading = prompt.promptHeading ?? 'Untitled'

        const expectedOptions = parseArktypeOptions(prompt.type)
        if (expectedOptions.length === 0) {
          autoSyncAllProgress.processedPrompts += 1
          continue
        }

        const isArray = isArrayType(prompt.type)

        const baseConditions = [eq(judgments.promptId, prompt.id), sql`${judgments.deletedAt} IS NULL`]

        let projectScope: ProjectScope | null = null
        if (projectId) {
          projectScope = await fetchProjectScope(projectId)
          if (projectScope) {
            baseConditions.push(eq(judgments.modelId, projectScope.modelId))
            baseConditions.push(eq(judgments.useTitle, projectScope.useTitle))
            baseConditions.push(eq(judgments.useAbstract, projectScope.useAbstract))
            baseConditions.push(eq(judgments.useFulltext, projectScope.useFulltext))
            baseConditions.push(eq(judgments.useFulltextNoImages, projectScope.useFulltextNoImages))

            const articleScopeConditions = []
            if (projectScope.importRoutes.length > 0) {
              articleScopeConditions.push(
                sql`EXISTS (
                  SELECT 1 FROM ${articles}
                  WHERE ${articles.id} = ${judgments.articleId}
                  AND ${articles.importRoute} IN (${sql.join(
                    projectScope.importRoutes.map((r) => sql`${r}`),
                    sql`, `,
                  )})
                )`,
              )
            }
            if (projectScope.curatedArticleIds.length > 0) {
              articleScopeConditions.push(inArray(judgments.articleId, projectScope.curatedArticleIds))
            }
            if (articleScopeConditions.length > 0) {
              baseConditions.push(or(...articleScopeConditions)!)
            }

            if (projectScope.dateFrom) {
              baseConditions.push(
                sql`EXISTS (
                  SELECT 1 FROM ${articles}
                  WHERE ${articles.id} = ${judgments.articleId}
                  AND ${articles.articleCreatedAt} >= ${projectScope.dateFrom}
                )`,
              )
            }
            if (projectScope.dateTo) {
              baseConditions.push(
                sql`EXISTS (
                  SELECT 1 FROM ${articles}
                  WHERE ${articles.id} = ${judgments.articleId}
                  AND ${articles.articleCreatedAt} <= ${projectScope.dateTo}
                )`,
              )
            }
          }
        }

        let unexpectedValues: Array<string | null> = []

        if (isArray) {
          const arrayAnswersQuery = await db
            .select({answeredOriginalAsArray: judgments.answeredOriginalAsArray})
            .from(judgments)
            .where(and(...baseConditions))
            .groupBy(judgments.answeredOriginalAsArray)

          unexpectedValues = arrayAnswersQuery
            .filter((a) => {
              const arrayAnswer = a.answeredOriginalAsArray
              if (arrayAnswer === null) return true
              if (!Array.isArray(arrayAnswer)) return true
              if (arrayAnswer.length === 0) return true
              return arrayAnswer.some((elem) => !expectedOptions.includes(elem))
            })
            .map((a) => (a.answeredOriginalAsArray === null ? null : JSON.stringify(a.answeredOriginalAsArray)))
        } else {
          const stringAnswersQuery = await db
            .select({answeredOriginal: judgments.answeredOriginal})
            .from(judgments)
            .where(and(...baseConditions))
            .groupBy(judgments.answeredOriginal)

          unexpectedValues = stringAnswersQuery
            .filter((a) => {
              const answer = a.answeredOriginal
              if (answer === null) return true
              if (answer === '') return true
              return !expectedOptions.includes(answer)
            })
            .map((a) => a.answeredOriginal)
        }

        let promptDeleted = 0
        for (const unexpectedValue of unexpectedValues) {
          const result = await deleteUnexpectedJudgments(projectId, prompt.id, unexpectedValue)
          promptDeleted += result.deleted
        }

        if (promptDeleted > 0) {
          autoSyncAllProgress.totalDeleted += promptDeleted
          autoSyncAllProgress.deletedByPrompt.push({
            promptId: prompt.id,
            promptHeading: prompt.promptHeading ?? 'Untitled',
            deleted: promptDeleted,
          })
          console.log(
            `[AutoSyncAll] Deleted ${promptDeleted} unexpected judgments for prompt "${prompt.promptHeading ?? prompt.id}"`,
          )
        }

        autoSyncAllProgress.processedPrompts += 1
      }

      autoSyncAllProgress.status = 'completed'
      autoSyncAllProgress.completedAt = new Date()
      autoSyncAllProgress.currentPromptId = null
      autoSyncAllProgress.currentPromptHeading = null
      console.log(
        `[AutoSyncAll] Completed! Processed ${autoSyncAllProgress.processedPrompts} prompts, deleted ${autoSyncAllProgress.totalDeleted} unexpected judgments`,
      )
    } catch (error) {
      autoSyncAllProgress.status = 'error'
      autoSyncAllProgress.error = error instanceof Error ? error.message : 'Unknown error'
      autoSyncAllProgress.completedAt = new Date()
      console.error('[AutoSyncAll] Error:', error)
    }
  }

  void runSync()

  return {started: true, message: 'Auto-sync all started'}
}

const runBackfillAsync = async (batchSize: number = 1000) => {
  if (backfillProgress.status === 'running') {
    return {started: false, message: 'Backfill already in progress'}
  }

  backfillProgress.status = 'running'
  backfillProgress.synced = 0
  backfillProgress.currentBatch = 0
  backfillProgress.totalBatches = 0
  backfillProgress.startedAt = new Date()
  backfillProgress.completedAt = null
  backfillProgress.error = null
  backfillProgress.estimatedSecondsRemaining = null

  const runBackfill = async () => {
    const db = getDatabase()
    const {getClickhouseClient} = await import('../../services/clickhouse/clickhouseClient.ts')
    const chClient = getClickhouseClient()

    try {
      console.log('[Backfill] Starting backfill from ClickHouse max timestamp...')

      const chMaxResult = await chClient.query({
        query: `SELECT max(createdAt) AS maxCreatedAt FROM judgments`,
        format: 'JSONEachRow',
      })
      const [chMaxRow] = await chMaxResult.json<{maxCreatedAt: string | null}>()
      // ClickHouse returns timestamps without timezone - treat as UTC
      const chMaxCreatedAt = chMaxRow?.maxCreatedAt ? new Date(chMaxRow.maxCreatedAt + 'Z') : new Date(0)

      console.log(`[Backfill] ClickHouse max createdAt: ${chMaxCreatedAt.toISOString()}`)

      let lastCreatedAt = chMaxCreatedAt
      let totalSynced = 0

      while (true) {
        const pgJudgments = await db
          .select({
            id: judgments.id,
            createdAt: judgments.createdAt,
            deletedAt: judgments.deletedAt,
            articleId: judgments.articleId,
            promptId: judgments.promptId,
            modelId: judgments.modelId,
            useTitle: judgments.useTitle,
            useAbstract: judgments.useAbstract,
            useFulltext: judgments.useFulltext,
            useFulltextNoImages: judgments.useFulltextNoImages,
            answeredOriginal: judgments.answeredOriginal,
            answeredOriginalAsArray: judgments.answeredOriginalAsArray,
          })
          .from(judgments)
          .where(sql`${judgments.createdAt} > ${lastCreatedAt}`)
          .orderBy(judgments.createdAt)
          .limit(batchSize)

        if (pgJudgments.length === 0) break

        const articleIds = [...new Set(pgJudgments.map((j) => j.articleId))]
        const articleRows = await db.select().from(articles).where(inArray(articles.id, articleIds))
        const articlesMap = new Map(articleRows.map((a) => [a.id, a]))

        const clickhouseRecords = pgJudgments.map((judgment) => {
          const article = articlesMap.get(judgment.articleId)
          return {
            id: judgment.id,
            createdAt: formatDateForClickHouse(judgment.createdAt),
            deletedAt: formatDateForClickHouse(judgment.deletedAt),
            articleId: judgment.articleId,
            articleTitle: article?.articleTitle ?? null,
            articleCreatedAt: formatDateForClickHouse(article?.articleCreatedAt ?? null),
            articleUpdatedAt: formatDateForClickHouse(article?.articleUpdatedAt ?? null),
            articleCreatedYear: article?.articleCreatedAt ? article.articleCreatedAt.getUTCFullYear() : null,
            articleUpdatedYear: article?.articleUpdatedAt ? article.articleUpdatedAt.getUTCFullYear() : null,
            articleImportRoute: article?.importRoute ?? null,
            articleImportedBy: article?.importedBy ?? null,
            promptId: judgment.promptId,
            modelId: judgment.modelId,
            useTitle: judgment.useTitle,
            useAbstract: judgment.useAbstract,
            useFulltext: judgment.useFulltext,
            useFulltextNoImages: judgment.useFulltextNoImages,
            answeredOriginal: judgment.answeredOriginal,
            answeredOriginalAsArray: judgment.answeredOriginalAsArray ?? [],
            explanation: null,
            quotes: null,
          }
        })

        await chClient.insert({table: 'forska.judgments', values: clickhouseRecords, format: 'JSONEachRow'})

        totalSynced += pgJudgments.length
        backfillProgress.synced = totalSynced
        backfillProgress.currentBatch += 1

        lastCreatedAt = pgJudgments[pgJudgments.length - 1]!.createdAt

        const elapsedMs = Date.now() - (backfillProgress.startedAt?.getTime() ?? Date.now())
        const rate = totalSynced / (elapsedMs / 1000)
        const remaining = backfillProgress.totalToSync - totalSynced
        backfillProgress.estimatedSecondsRemaining = rate > 0 ? Math.round(remaining / rate) : null

        console.log(
          `[Backfill] Synced ${totalSynced.toLocaleString()} / ${backfillProgress.totalToSync.toLocaleString()} (${backfillProgress.estimatedSecondsRemaining}s remaining)`,
        )

        if (pgJudgments.length < batchSize) break
      }

      backfillProgress.status = 'completed'
      backfillProgress.completedAt = new Date()
      backfillProgress.totalToSync = totalSynced
      console.log(`[Backfill] Completed! Synced ${totalSynced.toLocaleString()} judgments`)
    } catch (error) {
      backfillProgress.status = 'error'
      backfillProgress.error = error instanceof Error ? error.message : 'Unknown error'
      backfillProgress.completedAt = new Date()
      console.error('[Backfill] Error:', error)
    }
  }

  void runBackfill()

  return {started: true, message: 'Backfill started'}
}

export const adminInvestigateRoutes = new Elysia()
  .use(withErrorHandler())
  .use(requireUserAuth())
  .get('/api/admin/clickhouse-sync-status', async () => {
    return getClickhouseSyncStatus()
  })
  .post(
    '/api/admin/backfill-judgments-to-clickhouse',
    async ({body}) => {
      const batchSize = body?.batchSize ?? 1000
      return runBackfillAsync(batchSize)
    },
    {body: t.Optional(t.Object({batchSize: t.Optional(t.Number())}))},
  )
  .get('/api/admin/backfill-progress', async () => {
    return getBackfillProgress()
  })
  .get('/api/admin/list-prompts-with-types', async () => {
    const db = getDatabase()
    const promptsList = await db
      .select({
        id: prompts.id,
        promptHeading: prompts.promptHeading,
        type: prompts.type,
        originalText: prompts.originalText,
        createdAt: prompts.createdAt,
        ownerId: prompts.ownerId,
        archived: prompts.archived,
      })
      .from(prompts)
      .where(isNotNull(prompts.type))
      .orderBy(prompts.promptHeading)

    const filtered = promptsList.filter((p) => {
      return !isOpenEndedType(p.type)
    })

    return {
      prompts: filtered.map((p) => {
        return {
          id: p.id,
          promptHeading: p.promptHeading || 'Untitled',
          type: p.type,
          originalText: p.originalText,
          createdAt: p.createdAt,
          ownerId: p.ownerId,
          archived: p.archived,
        }
      }),
    }
  })
  .post('/api/admin/sync-deleted-judgments-to-clickhouse', async () => {
    return syncDeletedJudgmentsToClickhouse()
  })
  .post(
    '/api/admin/delete-unexpected-answers',
    async ({body}) => {
      const {projectId, promptId, unexpectedValue} = body
      return deleteUnexpectedJudgments(projectId, promptId, unexpectedValue)
    },
    {
      body: t.Object({
        projectId: t.Union([t.String(), t.Null()]),
        promptId: t.String(),
        unexpectedValue: t.Union([t.String(), t.Null()]),
      }),
    },
  )
  .post(
    '/api/admin/auto-sync-all-unexpected-answers',
    async ({body}) => {
      const projectId = body?.projectId ?? null
      return runAutoSyncAllAsync(projectId)
    },
    {body: t.Optional(t.Object({projectId: t.Optional(t.Union([t.String(), t.Null()]))}))},
  )
  .get('/api/admin/auto-sync-all-progress', async () => {
    return getAutoSyncAllProgress()
  })
  .get(
    '/api/admin/investigate-unexpected-answers',
    async ({query}) => {
      const db = getDatabase()
      const projectId = query.projectId
      const promptId = query.promptId

      console.log(
        `[Admin] Fetching prompts${projectId ? ` for project ${projectId}` : ''}${promptId ? ` for prompt ${promptId}` : ''}...`,
      )

      // If projectId provided, get project info
      let projectName = 'All Projects'
      if (projectId) {
        const [project] = await db
          .select({name: projects.name})
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1)
        if (!project) {
          throw new Error('Project not found')
        }
        projectName = project.name
      }

      // Fetch prompts - filter by project and/or promptId if specified
      let promptsQuery
      if (promptId) {
        // Single prompt mode
        promptsQuery = db
          .select({id: prompts.id, promptHeading: prompts.promptHeading, type: prompts.type})
          .from(prompts)
          .where(and(eq(prompts.id, promptId), isNotNull(prompts.type)))
      } else if (projectId) {
        // Project mode - all prompts in project
        promptsQuery = db
          .select({id: prompts.id, promptHeading: prompts.promptHeading, type: prompts.type})
          .from(prompts)
          .innerJoin(projectPrompts, eq(projectPrompts.promptId, prompts.id))
          .where(
            and(eq(projectPrompts.projectId, projectId), isNotNull(prompts.type), eq(projectPrompts.enabled, true)),
          )
      } else {
        // All prompts mode
        promptsQuery = db
          .select({id: prompts.id, promptHeading: prompts.promptHeading, type: prompts.type})
          .from(prompts)
          .where(isNotNull(prompts.type))
      }

      const allPrompts = await promptsQuery

      console.log(`[Admin] Found ${allPrompts.length} prompts with defined types`)

      const results: Array<{
        promptId: string
        promptHeading: string
        expectedOptions: string[]
        unexpectedAnswers: Array<{value: string | null; count: number}>
        totalJudgments: number
        percentUnexpected: number
      }> = []

      // Fetch project scope if projectId is provided
      let projectScope: ProjectScope | null = null
      if (projectId) {
        projectScope = await fetchProjectScope(projectId)
        if (!projectScope) {
          throw new Error('Project not found or has no configuration')
        }
      }

      for (const prompt of allPrompts) {
        if (isOpenEndedType(prompt.type)) continue
        const expectedOptions = parseArktypeOptions(prompt.type)
        if (expectedOptions.length === 0) continue

        // Get all distinct answers for this prompt
        const isArray = isArrayType(prompt.type)

        // Build WHERE conditions based on project scope
        const baseConditions = [eq(judgments.promptId, prompt.id), sql`${judgments.deletedAt} IS NULL`]

        if (projectScope) {
          baseConditions.push(eq(judgments.modelId, projectScope.modelId))
          baseConditions.push(eq(judgments.useTitle, projectScope.useTitle))
          baseConditions.push(eq(judgments.useAbstract, projectScope.useAbstract))
          baseConditions.push(eq(judgments.useFulltext, projectScope.useFulltext))
          baseConditions.push(eq(judgments.useFulltextNoImages, projectScope.useFulltextNoImages))

          const articleScopeConditions = []
          if (projectScope.importRoutes.length > 0) {
            articleScopeConditions.push(
              sql`EXISTS (
                SELECT 1 FROM ${articles}
                WHERE ${articles.id} = ${judgments.articleId}
                AND ${articles.importRoute} IN (${sql.join(
                  projectScope.importRoutes.map((r) => {
                    return sql`${r}`
                  }),
                  sql`, `,
                )})
              )`,
            )
          }
          if (projectScope.curatedArticleIds.length > 0) {
            articleScopeConditions.push(inArray(judgments.articleId, projectScope.curatedArticleIds))
          }
          if (articleScopeConditions.length > 0) {
            baseConditions.push(or(...articleScopeConditions))
          }

          if (projectScope.dateFrom) {
            baseConditions.push(
              sql`EXISTS (
                SELECT 1 FROM ${articles}
                WHERE ${articles.id} = ${judgments.articleId}
                AND ${articles.articleCreatedAt} >= ${projectScope.dateFrom}
              )`,
            )
          }
          if (projectScope.dateTo) {
            baseConditions.push(
              sql`EXISTS (
                SELECT 1 FROM ${articles}
                WHERE ${articles.id} = ${judgments.articleId}
                AND ${articles.articleCreatedAt} <= ${projectScope.dateTo}
              )`,
            )
          }
        }

        let totalJudgments: number
        let unexpectedAnswers: Array<{value: string | null; count: number}>

        if (isArray) {
          const arrayAnswersQuery = await db
            .select({answeredOriginalAsArray: judgments.answeredOriginalAsArray, count: sql<number>`COUNT(*)::int`})
            .from(judgments)
            .where(and(...baseConditions))
            .groupBy(judgments.answeredOriginalAsArray)

          totalJudgments = arrayAnswersQuery.reduce((sum, a) => {
            return sum + a.count
          }, 0)

          unexpectedAnswers = arrayAnswersQuery
            .filter((a) => {
              const arrayAnswer = a.answeredOriginalAsArray
              if (arrayAnswer === null) return true
              if (!Array.isArray(arrayAnswer)) return true
              if (arrayAnswer.length === 0) return true
              return arrayAnswer.some((elem) => {
                return !expectedOptions.includes(elem)
              })
            })
            .map((a) => {
              const arrayValue = a.answeredOriginalAsArray
              return {value: arrayValue === null ? null : JSON.stringify(arrayValue), count: a.count}
            })
            .sort((a, b) => {
              return b.count - a.count
            })
        } else {
          const stringAnswersQuery = await db
            .select({answeredOriginal: judgments.answeredOriginal, count: sql<number>`COUNT(*)::int`})
            .from(judgments)
            .where(and(...baseConditions))
            .groupBy(judgments.answeredOriginal)

          totalJudgments = stringAnswersQuery.reduce((sum, a) => {
            return sum + a.count
          }, 0)

          unexpectedAnswers = stringAnswersQuery
            .filter((a) => {
              const answer = a.answeredOriginal
              if (answer === null) return true
              if (answer === '') return true
              return !expectedOptions.includes(answer)
            })
            .map((a) => {
              return {value: a.answeredOriginal, count: a.count}
            })
            .sort((a, b) => {
              return b.count - a.count
            })
        }

        if (unexpectedAnswers.length > 0) {
          const unexpectedCount = unexpectedAnswers.reduce((sum, ua) => {
            return sum + ua.count
          }, 0)
          const percentUnexpected = (unexpectedCount / totalJudgments) * 100

          results.push({
            promptId: prompt.id,
            promptHeading: prompt.promptHeading || 'Untitled',
            expectedOptions,
            unexpectedAnswers,
            totalJudgments,
            percentUnexpected,
          })
        }
      }

      console.log(`[Admin] Found ${results.length} prompts with unexpected answers`)

      // If promptId specified, return single-prompt format
      if (promptId) {
        const promptHeading = allPrompts[0]?.promptHeading || 'Untitled'
        const result = results.length > 0 ? results[0] : null
        return {projectName, promptHeading, result}
      }

      // Otherwise return multi-prompt format
      return {
        summary: {totalPromptsWithTypes: allPrompts.length, promptsWithUnexpectedAnswers: results.length},
        results: results.sort((a, b) => {
          return b.percentUnexpected - a.percentUnexpected
        }), // Sort by % unexpected descending
        projectName,
      }
    },
    {query: t.Object({projectId: t.Optional(t.String()), promptId: t.Optional(t.String())})},
  )
  .get(
    '/api/admin/diagnose-unassessed',
    async ({query}) => {
      const projectId = query.projectId
      const db = getDatabase()
      const {getClickhouseClient} = await import('../../services/clickhouse/clickhouseClient.ts')
      const chClient = getClickhouseClient()

      const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)

      if (!project) {
        return {error: 'Project not found'}
      }

      const enabledPromptRows = await db
        .select({promptId: projectPrompts.promptId})
        .from(projectPrompts)
        .where(and(eq(projectPrompts.projectId, projectId), eq(projectPrompts.enabled, true)))

      const enabledPromptIds = enabledPromptRows.map((r) => r.promptId)

      const projectImportRoutes = await db
        .select({route: importRoute.route})
        .from(projectRouteLink)
        .innerJoin(importRoute, eq(importRoute.id, projectRouteLink.importRouteId))
        .where(eq(projectRouteLink.projectId, projectId))

      const curatedArticleRows = await db
        .select({articleId: projectArticles.articleId})
        .from(projectArticles)
        .where(eq(projectArticles.projectId, projectId))

      const routes = projectImportRoutes.map((r) => r.route)
      const curatedIds = curatedArticleRows.map((r) => r.articleId)

      // Count articles in scope from PostgreSQL
      let pgArticleCount = 0
      if (curatedIds.length > 0) {
        const result = await db
          .select({count: sql<number>`COUNT(DISTINCT ${articles.id})::int`})
          .from(articles)
          .where(inArray(articles.id, curatedIds))
        pgArticleCount = result[0]?.count ?? 0
      } else if (routes.length > 0) {
        const result = await db
          .select({count: sql<number>`COUNT(*)::int`})
          .from(articles)
          .where(inArray(articles.importRoute, routes))
        pgArticleCount = result[0]?.count ?? 0
      }

      // Build article scope condition for PostgreSQL
      const articleIds = curatedIds.length > 0 ? curatedIds : []
      const hasArticleScope = articleIds.length > 0 || routes.length > 0

      // Count judgments in PostgreSQL matching project settings AND scoped to project articles
      let pgJudgmentCount = 0
      let pgScopedJudgmentCount = 0

      if (hasArticleScope) {
        // Scoped count (only articles in this project)
        const scopeConditions = []
        if (articleIds.length > 0) {
          scopeConditions.push(inArray(judgments.articleId, articleIds))
        }
        if (routes.length > 0) {
          scopeConditions.push(
            sql`${judgments.articleId} IN (SELECT id FROM articles WHERE import_route IN (${sql.join(
              routes.map((r) => sql`${r}`),
              sql`, `,
            )}))`,
          )
        }

        const pgScopedResult = await db
          .select({count: sql<number>`COUNT(*)::int`})
          .from(judgments)
          .where(
            and(
              or(...scopeConditions),
              inArray(judgments.promptId, enabledPromptIds),
              eq(judgments.modelId, project.modelId),
              eq(judgments.useTitle, project.useTitle),
              eq(judgments.useAbstract, project.useAbstract),
              eq(judgments.useFulltext, project.useFulltext),
              eq(judgments.useFulltextNoImages, project.useFulltextNoImages),
              sql`${judgments.deletedAt} IS NULL`,
            ),
          )
        pgScopedJudgmentCount = pgScopedResult[0]?.count ?? 0
      }

      // Total count (all judgments matching settings, for comparison)
      const pgTotalResult = await db
        .select({count: sql<number>`COUNT(*)::int`})
        .from(judgments)
        .where(
          and(
            inArray(judgments.promptId, enabledPromptIds),
            eq(judgments.modelId, project.modelId),
            eq(judgments.useTitle, project.useTitle),
            eq(judgments.useAbstract, project.useAbstract),
            eq(judgments.useFulltext, project.useFulltext),
            eq(judgments.useFulltextNoImages, project.useFulltextNoImages),
            sql`${judgments.deletedAt} IS NULL`,
          ),
        )
      pgJudgmentCount = pgTotalResult[0]?.count ?? 0

      // Count judgments in ClickHouse matching project settings AND scoped
      const promptIdsQuoted = enabledPromptIds.map((id) => `'${id}'`).join(', ')

      let chScopeFilter = ''
      if (articleIds.length > 0) {
        const idsQuoted = articleIds.map((id) => `'${id}'`).join(', ')
        chScopeFilter = `AND articleId IN (${idsQuoted})`
      } else if (routes.length > 0) {
        const routesQuoted = routes.map((r) => `'${r}'`).join(', ')
        chScopeFilter = `AND articleImportRoute IN (${routesQuoted})`
      }

      const chQuery = `
        SELECT count() AS count
        FROM judgments
        WHERE promptId IN (${promptIdsQuoted})
          AND modelId = '${project.modelId}'
          AND useTitle = ${project.useTitle}
          AND useAbstract = ${project.useAbstract}
          AND useFulltext = ${project.useFulltext}
          AND useFulltextNoImages = ${project.useFulltextNoImages}
          AND deletedAt IS NULL
          ${chScopeFilter}
      `
      const chResult = await chClient.query({query: chQuery, format: 'JSONEachRow'})
      const [chRow] = await chResult.json<{count: number}>()
      const chJudgmentCount = chRow?.count ?? 0

      // Count articles in ClickHouse (full count, not limited)
      let chArticleCount = 0
      if (articleIds.length > 0) {
        const idsQuoted = articleIds.map((id) => `'${id}'`).join(', ')
        const chArticleQuery = `SELECT count() AS count FROM forska.articles WHERE id IN (${idsQuoted})`
        const result = await chClient.query({query: chArticleQuery, format: 'JSONEachRow'})
        const [row] = await result.json<{count: number}>()
        chArticleCount = row?.count ?? 0
      } else if (routes.length > 0) {
        const routesQuoted = routes.map((r) => `'${r}'`).join(', ')
        const chArticleQuery = `SELECT count() AS count FROM forska.articles WHERE import_route IN (${routesQuoted})`
        const result = await chClient.query({query: chArticleQuery, format: 'JSONEachRow'})
        const [row] = await result.json<{count: number}>()
        chArticleCount = row?.count ?? 0
      }

      const expectedJudgments = pgArticleCount * enabledPromptIds.length
      const missingInPostgres = expectedJudgments - pgScopedJudgmentCount

      return {
        project: {
          id: project.id,
          name: project.name,
          modelId: project.modelId,
          useTitle: project.useTitle,
          useAbstract: project.useAbstract,
          useFulltext: project.useFulltext,
          useFulltextNoImages: project.useFulltextNoImages,
        },
        scope: {
          enabledPromptCount: enabledPromptIds.length,
          enabledPromptIds,
          importRoutes: routes,
          curatedArticleCount: curatedIds.length,
        },
        postgres: {
          articlesInScope: pgArticleCount,
          judgmentsInScope: pgScopedJudgmentCount,
          judgmentsTotalMatchingSettings: pgJudgmentCount,
        },
        clickhouse: {articlesInScope: chArticleCount, judgmentsInScope: chJudgmentCount},
        analysis: {
          expectedJudgments,
          missingInPostgres,
          missingInClickhouse: pgScopedJudgmentCount - chJudgmentCount,
          articlesFullyCovered: Math.floor(pgScopedJudgmentCount / enabledPromptIds.length),
          articlesPartialOrNone: pgArticleCount - Math.floor(pgScopedJudgmentCount / enabledPromptIds.length),
        },
      }
    },
    {query: t.Object({projectId: t.String()})},
  )
  .get('/api/admin/parquet-dual-write-status', async () => {
    const {getJudgmentsParquetDualWriteConfig} = await import('../../services/parquet/judgmentsParquetDualWrite.ts')
    const {getDefaultWriterPendingCount} = await import('../../services/parquet/parquetWriter.ts')

    const config = getJudgmentsParquetDualWriteConfig()
    const pendingCount = getDefaultWriterPendingCount()

    return {
      enabled: config.enabled,
      s3Configured: config.s3Configured,
      batchSize: config.batchSize,
      flushIntervalMs: config.flushIntervalMs,
      pendingRecords: pendingCount,
      envVars: {
        S3_ENDPOINT: process.env.S3_ENDPOINT ? 'set' : 'not set',
        S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ? 'set' : 'not set',
        S3_SECRET_KEY: process.env.S3_SECRET_KEY ? 'set' : 'not set',
        S3_BUCKET: process.env.S3_BUCKET ? 'set' : 'not set',
        PARQUET_JUDGMENTS_DUAL_WRITE:
          process.env.PARQUET_JUDGMENTS_DUAL_WRITE ?? 'not set (defaults to true if S3 configured)',
      },
    }
  })
  .post(
    '/api/admin/backfill-project-judgments',
    async ({body}) => {
      const {projectId} = body
      const db = getDatabase()
      const {getClickhouseClient} = await import('../../services/clickhouse/clickhouseClient.ts')
      const chClient = getClickhouseClient()

      const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
      if (!project) {
        return {error: 'Project not found', synced: 0}
      }

      const enabledPromptRows = await db
        .select({promptId: projectPrompts.promptId})
        .from(projectPrompts)
        .where(and(eq(projectPrompts.projectId, projectId), eq(projectPrompts.enabled, true)))
      const enabledPromptIds = enabledPromptRows.map((r) => r.promptId)

      const curatedArticleRows = await db
        .select({articleId: projectArticles.articleId})
        .from(projectArticles)
        .where(eq(projectArticles.projectId, projectId))
      const curatedIds = curatedArticleRows.map((r) => r.articleId)

      const projectImportRoutes = await db
        .select({route: importRoute.route})
        .from(projectRouteLink)
        .innerJoin(importRoute, eq(importRoute.id, projectRouteLink.importRouteId))
        .where(eq(projectRouteLink.projectId, projectId))
      const routes = projectImportRoutes.map((r) => r.route)

      // Build scope conditions
      const scopeConditions = []
      if (curatedIds.length > 0) {
        scopeConditions.push(inArray(judgments.articleId, curatedIds))
      }
      if (routes.length > 0) {
        scopeConditions.push(
          sql`${judgments.articleId} IN (SELECT id FROM articles WHERE import_route IN (${sql.join(
            routes.map((r) => sql`${r}`),
            sql`, `,
          )}))`,
        )
      }

      if (scopeConditions.length === 0) {
        return {error: 'No scope defined for project', synced: 0}
      }

      // Get all judgment IDs from PostgreSQL for this project
      const pgJudgmentIds = await db
        .select({id: judgments.id})
        .from(judgments)
        .where(
          and(
            or(...scopeConditions),
            inArray(judgments.promptId, enabledPromptIds),
            eq(judgments.modelId, project.modelId),
            eq(judgments.useTitle, project.useTitle),
            eq(judgments.useAbstract, project.useAbstract),
            eq(judgments.useFulltext, project.useFulltext),
            eq(judgments.useFulltextNoImages, project.useFulltextNoImages),
          ),
        )

      const pgIds = new Set(pgJudgmentIds.map((r) => r.id))
      console.log(`[ProjectBackfill] Found ${pgIds.size} judgments in PostgreSQL for project ${projectId}`)

      // Get judgment IDs from ClickHouse for this project
      const promptIdsQuoted = enabledPromptIds.map((id) => `'${id}'`).join(', ')
      let chScopeFilter = ''
      if (curatedIds.length > 0) {
        const idsQuoted = curatedIds.map((id) => `'${id}'`).join(', ')
        chScopeFilter = `AND articleId IN (${idsQuoted})`
      } else if (routes.length > 0) {
        const routesQuoted = routes.map((r) => `'${r}'`).join(', ')
        chScopeFilter = `AND articleImportRoute IN (${routesQuoted})`
      }

      const chIdsResult = await chClient.query({
        query: `
          SELECT id FROM judgments
          WHERE promptId IN (${promptIdsQuoted})
            AND modelId = '${project.modelId}'
            AND useTitle = ${project.useTitle}
            AND useAbstract = ${project.useAbstract}
            AND useFulltext = ${project.useFulltext}
            AND useFulltextNoImages = ${project.useFulltextNoImages}
            ${chScopeFilter}
        `,
        format: 'JSONEachRow',
      })
      const chIdsRows = await chIdsResult.json<{id: string}>()
      const chIds = new Set(chIdsRows.map((r) => r.id))
      console.log(`[ProjectBackfill] Found ${chIds.size} judgments in ClickHouse for project ${projectId}`)

      // Find missing IDs
      const missingIds = [...pgIds].filter((id) => !chIds.has(id))
      console.log(`[ProjectBackfill] Missing ${missingIds.length} judgments in ClickHouse`)

      if (missingIds.length === 0) {
        return {synced: 0, message: 'ClickHouse is already in sync with PostgreSQL for this project'}
      }

      // Fetch and sync missing judgments in batches
      const batchSize = 1000
      let totalSynced = 0

      for (let i = 0; i < missingIds.length; i += batchSize) {
        const batchIds = missingIds.slice(i, i + batchSize)

        const pgJudgments = await db
          .select({
            id: judgments.id,
            createdAt: judgments.createdAt,
            deletedAt: judgments.deletedAt,
            articleId: judgments.articleId,
            promptId: judgments.promptId,
            modelId: judgments.modelId,
            useTitle: judgments.useTitle,
            useAbstract: judgments.useAbstract,
            useFulltext: judgments.useFulltext,
            useFulltextNoImages: judgments.useFulltextNoImages,
            answeredOriginal: judgments.answeredOriginal,
            answeredOriginalAsArray: judgments.answeredOriginalAsArray,
          })
          .from(judgments)
          .where(inArray(judgments.id, batchIds))

        const articleIds = [...new Set(pgJudgments.map((j) => j.articleId))]
        const articleRows = await db.select().from(articles).where(inArray(articles.id, articleIds))
        const articlesMap = new Map(articleRows.map((a) => [a.id, a]))

        const clickhouseRecords = pgJudgments.map((judgment) => {
          const article = articlesMap.get(judgment.articleId)
          return {
            id: judgment.id,
            createdAt: formatDateForClickHouse(judgment.createdAt),
            deletedAt: formatDateForClickHouse(judgment.deletedAt),
            articleId: judgment.articleId,
            articleTitle: article?.articleTitle ?? null,
            articleCreatedAt: formatDateForClickHouse(article?.articleCreatedAt ?? null),
            articleUpdatedAt: formatDateForClickHouse(article?.articleUpdatedAt ?? null),
            articleCreatedYear: article?.articleCreatedAt ? article.articleCreatedAt.getUTCFullYear() : null,
            articleUpdatedYear: article?.articleUpdatedAt ? article.articleUpdatedAt.getUTCFullYear() : null,
            articleImportRoute: article?.importRoute ?? null,
            articleImportedBy: article?.importedBy ?? null,
            promptId: judgment.promptId,
            modelId: judgment.modelId,
            useTitle: judgment.useTitle,
            useAbstract: judgment.useAbstract,
            useFulltext: judgment.useFulltext,
            useFulltextNoImages: judgment.useFulltextNoImages,
            answeredOriginal: judgment.answeredOriginal,
            answeredOriginalAsArray: judgment.answeredOriginalAsArray ?? [],
            explanation: null,
            quotes: null,
          }
        })

        await chClient.insert({table: 'forska.judgments', values: clickhouseRecords, format: 'JSONEachRow'})
        totalSynced += clickhouseRecords.length
        console.log(`[ProjectBackfill] Synced batch ${Math.floor(i / batchSize) + 1}, total: ${totalSynced}`)
      }

      return {synced: totalSynced, message: `Synced ${totalSynced} missing judgments for project`}
    },
    {body: t.Object({projectId: t.String()})},
  )
