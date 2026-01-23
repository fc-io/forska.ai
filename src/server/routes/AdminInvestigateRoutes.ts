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

export const adminInvestigateRoutes = new Elysia()
  .use(withErrorHandler())
  .use(requireUserAuth())
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
