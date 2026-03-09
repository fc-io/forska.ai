import {and, asc, desc, eq, gte, ilike, inArray, lte, or, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {
  articleRouteLink,
  articles,
  comparisonProject,
  comparisonProjectPrompt,
  comparisonProjectRouteLink,
  importRoute as importRouteTable,
  judgments,
  judgmentsHuman,
  models,
  prompts,
} from '../../db/schema.ts'
import {requireUserAuth} from '../utils/authGuard.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'

type PromptSelection = {promptId: string; order: number}
type Database = ReturnType<typeof getDatabase>
type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type DatabaseClient = Database | DatabaseTransaction
type ComparisonProjectPromptConfig = {id: string; promptHeading: string | null; promptLabel: string; order: number}
type ComparisonProjectModelConfig = {id: string; name: string}
type ComparisonProjectJudgmentsColumn = {
  id: string
  kind: 'llm' | 'human'
  promptId: string
  promptLabel: string
  modelId: string | null
  modelLabel: string
}
type ComparisonProjectScope = {
  id: string
  name: string
  description: string | null
  compareWithHumans: boolean
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  dateFrom: Date | null
  dateTo: Date | null
  archived: boolean
  createdAt: Date
  modelIds: string[] | null
  prompts: ComparisonProjectPromptConfig[]
  models: ComparisonProjectModelConfig[]
  importRouteIds: string[]
  columns: ComparisonProjectJudgmentsColumn[]
}
type ComparisonProjectLlmRow = {
  articleId: string
  promptId: string
  modelId: string
  answeredOriginal: string | null
  answeredOriginalAsArray: string[] | null
}
type ComparisonProjectHumanRow = {
  articleId: string
  promptId: string
  userId: string
  answer: string | null
  updatedAt: Date | null
}

const isDefined = <T>(value: T | null | undefined): value is T => {
  return value !== null && value !== undefined
}

const parseOptionalDate = (value?: string | null) => {
  if (!value) {
    return null
  }

  const trimmedValue = value.trim()
  if (!trimmedValue) {
    return null
  }

  const isoDateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/
  const hasIsoDateOnlyMatch = isoDateOnlyPattern.exec(trimmedValue)
  const normalizedValue = hasIsoDateOnlyMatch ? `${trimmedValue}T00:00:00.000Z` : trimmedValue
  const parsedDate = new Date(normalizedValue)

  if (Number.isNaN(parsedDate.getTime())) {
    throw new Error('Invalid date value provided')
  }

  return parsedDate
}

const getUniqueStringValues = (values: string[]) => {
  return Array.from(
    new Set(
      values
        .map((value) => {
          return value.trim()
        })
        .filter((value) => {
          return value !== ''
        }),
    ),
  )
}

const getUniquePromptSelections = (promptSelections: PromptSelection[]) => {
  const uniqueSelections = promptSelections.reduce<Map<string, PromptSelection>>((selectionMap, selection) => {
    if (!selectionMap.has(selection.promptId)) {
      selectionMap.set(selection.promptId, selection)
    }

    return selectionMap
  }, new Map<string, PromptSelection>())

  return Array.from(uniqueSelections.values()).sort((left, right) => {
    return left.order - right.order
  })
}

const getPromptLabel = (promptHeading: string | null, order: number) => {
  const trimmedHeading = promptHeading?.trim() ?? ''

  return trimmedHeading || `Prompt ${order + 1}`
}

const getColumnId = (kind: 'llm' | 'human', promptId: string, modelId?: string | null) => {
  return kind === 'human' ? `human:${promptId}` : `llm:${modelId}:${promptId}`
}

const getUuidArraySql = (values: string[]) => {
  if (values.length === 0) {
    return null
  }

  return sql.join(
    values.map((value) => {
      return sql`${value}::uuid`
    }),
    sql`,`,
  )
}

const getComparisonProjectPromptCounts = (db: Database) => {
  return db
    .select({
      comparisonProjectId: comparisonProjectPrompt.comparisonProjectId,
      promptCount: sql<number>`count(*)::int`.as('prompt_count'),
    })
    .from(comparisonProjectPrompt)
    .groupBy(comparisonProjectPrompt.comparisonProjectId)
    .as('comparison_project_prompt_counts')
}

const getComparisonProjectRouteCounts = (db: Database) => {
  return db
    .select({
      comparisonProjectId: comparisonProjectRouteLink.comparisonProjectId,
      routeCount: sql<number>`count(*)::int`.as('route_count'),
    })
    .from(comparisonProjectRouteLink)
    .groupBy(comparisonProjectRouteLink.comparisonProjectId)
    .as('comparison_project_route_counts')
}

const getComparisonProjectsList = async (archived: boolean) => {
  const db = getDatabase()
  const promptCounts = getComparisonProjectPromptCounts(db)
  const routeCounts = getComparisonProjectRouteCounts(db)
  const orderByClause = archived ? desc(comparisonProject.createdAt) : asc(comparisonProject.name)

  return db
    .select({
      id: comparisonProject.id,
      name: comparisonProject.name,
      description: comparisonProject.description,
      compareWithHumans: comparisonProject.compareWithHumans,
      useTitle: comparisonProject.useTitle,
      useAbstract: comparisonProject.useAbstract,
      useFulltext: comparisonProject.useFulltext,
      useFulltextNoImages: comparisonProject.useFulltextNoImages,
      dateFrom: comparisonProject.dateFrom,
      dateTo: comparisonProject.dateTo,
      archived: comparisonProject.archived,
      createdAt: comparisonProject.createdAt,
      promptCount: sql<number>`COALESCE(${promptCounts.promptCount}, 0)`,
      routeCount: sql<number>`COALESCE(${routeCounts.routeCount}, 0)`,
    })
    .from(comparisonProject)
    .leftJoin(promptCounts, eq(promptCounts.comparisonProjectId, comparisonProject.id))
    .leftJoin(routeCounts, eq(routeCounts.comparisonProjectId, comparisonProject.id))
    .where(eq(comparisonProject.archived, archived))
    .orderBy(orderByClause)
}

const getArticleScopeConditions = (
  routeIds: string[],
  dateFrom: Date | null,
  dateTo: Date | null,
  searchTitle?: string | null,
) => {
  const routeIdArray = getUuidArraySql(routeIds)
  const trimmedSearchTitle = searchTitle?.trim() ?? ''

  return [
    routeIdArray
      ? sql`EXISTS (
          SELECT 1 FROM ${articleRouteLink} arl
          WHERE arl."article_id" = ${articles.id}
            AND arl."import_route_id" = ANY(ARRAY[${routeIdArray}])
        )`
      : null,
    dateFrom ? gte(articles.articleCreatedAt, dateFrom) : null,
    dateTo ? lte(articles.articleCreatedAt, dateTo) : null,
    trimmedSearchTitle ? ilike(articles.articleTitle, `%${trimmedSearchTitle}%`) : null,
  ].filter(isDefined)
}

const getComparisonProjectModels = async (
  comparisonProjectRow: {
    modelIds: string[] | null
    useTitle: boolean
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
    dateFrom: Date | null
    dateTo: Date | null
  },
  promptIds: string[],
  importRouteIds: string[],
) => {
  const db = getDatabase()
  const selectedModelIds = comparisonProjectRow.modelIds ?? []

  if (selectedModelIds.length > 0) {
    const modelRows = await db
      .select({id: models.id, name: models.name})
      .from(models)
      .where(inArray(models.id, selectedModelIds))
    const orderLookup = selectedModelIds.reduce<Record<string, number>>((acc, modelId, index) => {
      return {...acc, [modelId]: index}
    }, {})

    return modelRows.sort((left, right) => {
      return (orderLookup[left.id] ?? Number.MAX_SAFE_INTEGER) - (orderLookup[right.id] ?? Number.MAX_SAFE_INTEGER)
    })
  }

  if (promptIds.length === 0) {
    return []
  }

  const articleScopeConditions = getArticleScopeConditions(
    importRouteIds,
    comparisonProjectRow.dateFrom,
    comparisonProjectRow.dateTo,
  )
  const queryConditions = [
    inArray(judgments.promptId, promptIds),
    eq(judgments.useTitle, comparisonProjectRow.useTitle),
    eq(judgments.useAbstract, comparisonProjectRow.useAbstract),
    eq(judgments.useFulltext, comparisonProjectRow.useFulltext),
    eq(judgments.useFulltextNoImages, comparisonProjectRow.useFulltextNoImages),
    sql`${judgments.deletedAt} IS NULL`,
    ...articleScopeConditions,
  ]

  return db
    .select({id: models.id, name: models.name})
    .from(judgments)
    .innerJoin(models, eq(models.id, judgments.modelId))
    .innerJoin(articles, eq(articles.id, judgments.articleId))
    .where(and(...queryConditions))
    .groupBy(models.id, models.name)
    .orderBy(asc(models.name))
}

const getComparisonProjectColumns = (
  promptRows: ComparisonProjectPromptConfig[],
  modelRows: ComparisonProjectModelConfig[],
  compareWithHumans: boolean,
) => {
  const llmColumns = promptRows.flatMap((promptRow) => {
    return modelRows.map<ComparisonProjectJudgmentsColumn>((modelRow) => {
      return {
        id: getColumnId('llm', promptRow.id, modelRow.id),
        kind: 'llm',
        promptId: promptRow.id,
        promptLabel: promptRow.promptLabel,
        modelId: modelRow.id,
        modelLabel: modelRow.name,
      }
    })
  })
  const humanColumns = compareWithHumans
    ? promptRows.map<ComparisonProjectJudgmentsColumn>((promptRow) => {
        return {
          id: getColumnId('human', promptRow.id),
          kind: 'human',
          promptId: promptRow.id,
          promptLabel: promptRow.promptLabel,
          modelId: null,
          modelLabel: 'Human',
        }
      })
    : []

  return [...llmColumns, ...humanColumns]
}

const getComparisonProjectScope = async (comparisonProjectId: string): Promise<ComparisonProjectScope | null> => {
  const db = getDatabase()
  const [comparisonProjectRow] = await db
    .select({
      id: comparisonProject.id,
      name: comparisonProject.name,
      description: comparisonProject.description,
      compareWithHumans: comparisonProject.compareWithHumans,
      useTitle: comparisonProject.useTitle,
      useAbstract: comparisonProject.useAbstract,
      useFulltext: comparisonProject.useFulltext,
      useFulltextNoImages: comparisonProject.useFulltextNoImages,
      dateFrom: comparisonProject.dateFrom,
      dateTo: comparisonProject.dateTo,
      archived: comparisonProject.archived,
      createdAt: comparisonProject.createdAt,
      modelIds: comparisonProject.modelIds,
    })
    .from(comparisonProject)
    .where(eq(comparisonProject.id, comparisonProjectId))
    .limit(1)

  if (!comparisonProjectRow) {
    return null
  }

  const [promptRows, routeRows] = await Promise.all([
    db
      .select({id: prompts.id, promptHeading: prompts.promptHeading, order: comparisonProjectPrompt.order})
      .from(comparisonProjectPrompt)
      .innerJoin(prompts, eq(prompts.id, comparisonProjectPrompt.promptId))
      .where(eq(comparisonProjectPrompt.comparisonProjectId, comparisonProjectId))
      .orderBy(asc(comparisonProjectPrompt.order), asc(prompts.createdAt)),
    db
      .select({importRouteId: comparisonProjectRouteLink.importRouteId})
      .from(comparisonProjectRouteLink)
      .where(eq(comparisonProjectRouteLink.comparisonProjectId, comparisonProjectId)),
  ])

  const promptConfigs = promptRows.map<ComparisonProjectPromptConfig>((promptRow, index) => {
    const order = promptRow.order ?? index

    return {
      id: promptRow.id,
      promptHeading: promptRow.promptHeading,
      promptLabel: getPromptLabel(promptRow.promptHeading, order),
      order,
    }
  })
  const importRouteIds = routeRows.map((routeRow) => {
    return routeRow.importRouteId
  })
  const modelRows = await getComparisonProjectModels(
    comparisonProjectRow,
    promptConfigs.map((prompt) => {
      return prompt.id
    }),
    importRouteIds,
  )
  const columns = getComparisonProjectColumns(promptConfigs, modelRows, comparisonProjectRow.compareWithHumans)

  return {...comparisonProjectRow, prompts: promptConfigs, models: modelRows, importRouteIds, columns}
}

const getComparisonProjectLlmExistsCondition = (scope: ComparisonProjectScope) => {
  const promptIdArray = getUuidArraySql(
    scope.prompts.map((prompt) => {
      return prompt.id
    }),
  )
  const modelIdArray = getUuidArraySql(
    scope.models.map((model) => {
      return model.id
    }),
  )

  if (!promptIdArray || !modelIdArray) {
    return null
  }

  return sql`EXISTS (
    SELECT 1 FROM ${judgments} j
    WHERE j."article_id" = ${articles.id}
      AND j."deleted_at" IS NULL
      AND j."prompt_id" = ANY(ARRAY[${promptIdArray}])
      AND j."model_id" = ANY(ARRAY[${modelIdArray}])
      AND j."use_title" = ${scope.useTitle}
      AND j."use_abstract" = ${scope.useAbstract}
      AND j."use_fulltext" = ${scope.useFulltext}
      AND j."use_fulltext_no_images" = ${scope.useFulltextNoImages}
  )`
}

const getComparisonProjectHumanExistsCondition = (scope: ComparisonProjectScope) => {
  const promptIdArray = getUuidArraySql(
    scope.prompts.map((prompt) => {
      return prompt.id
    }),
  )

  if (!promptIdArray || !scope.compareWithHumans) {
    return null
  }

  return sql`EXISTS (
    SELECT 1 FROM ${judgmentsHuman} jh
    WHERE jh."article_id" = ${articles.id}
      AND jh."prompt_id" = ANY(ARRAY[${promptIdArray}])
      AND jh."is_answered" = true
      AND jh."answer" IS NOT NULL
  )`
}

const parseAnswerArrayFromString = (value: string | null) => {
  const trimmedValue = value?.trim() ?? ''

  if (!trimmedValue.startsWith('[')) {
    return null
  }

  try {
    const parsedValue = JSON.parse(trimmedValue) as unknown

    return Array.isArray(parsedValue)
      ? parsedValue.filter((item): item is string => {
          return typeof item === 'string' && item.trim() !== ''
        })
      : null
  } catch {
    return null
  }
}

const getDisplayAnswer = (answeredOriginal: string | null, answeredOriginalAsArray?: string[] | null) => {
  const arrayValues = (answeredOriginalAsArray ?? []).filter((value) => {
    return value.trim() !== ''
  })
  const parsedArrayValues = parseAnswerArrayFromString(answeredOriginal) ?? []
  const values = arrayValues.length > 0 ? arrayValues : parsedArrayValues
  const trimmedValue = answeredOriginal?.trim() ?? ''

  return values.length > 0 ? values.join('\n') : trimmedValue || null
}

const getComparisonProjectLlmRows = async (scope: ComparisonProjectScope, articleIds: string[]) => {
  const promptIds = scope.prompts.map((prompt) => {
    return prompt.id
  })
  const modelIds = scope.models.map((model) => {
    return model.id
  })

  if (articleIds.length === 0 || promptIds.length === 0 || modelIds.length === 0) {
    return []
  }

  const db = getDatabase()

  return db
    .select({
      articleId: judgments.articleId,
      promptId: judgments.promptId,
      modelId: judgments.modelId,
      answeredOriginal: judgments.answeredOriginal,
      answeredOriginalAsArray: judgments.answeredOriginalAsArray,
    })
    .from(judgments)
    .where(
      and(
        inArray(judgments.articleId, articleIds),
        inArray(judgments.promptId, promptIds),
        inArray(judgments.modelId, modelIds),
        eq(judgments.useTitle, scope.useTitle),
        eq(judgments.useAbstract, scope.useAbstract),
        eq(judgments.useFulltext, scope.useFulltext),
        eq(judgments.useFulltextNoImages, scope.useFulltextNoImages),
        sql`${judgments.deletedAt} IS NULL`,
      ),
    )
}

const getComparisonProjectHumanRows = async (scope: ComparisonProjectScope, articleIds: string[]) => {
  const promptIds = scope.prompts.map((prompt) => {
    return prompt.id
  })

  if (articleIds.length === 0 || promptIds.length === 0 || !scope.compareWithHumans) {
    return []
  }

  const db = getDatabase()

  return db
    .select({
      articleId: judgmentsHuman.articleId,
      promptId: judgmentsHuman.promptId,
      userId: judgmentsHuman.user,
      answer: judgmentsHuman.answer,
      updatedAt: judgmentsHuman.updatedAt,
    })
    .from(judgmentsHuman)
    .where(
      and(
        inArray(judgmentsHuman.articleId, articleIds),
        inArray(judgmentsHuman.promptId, promptIds),
        eq(judgmentsHuman.isAnswered, true),
        sql`${judgmentsHuman.answer} IS NOT NULL`,
      ),
    )
}

const getComparisonProjectLlmCells = (rows: ComparisonProjectLlmRow[]) => {
  return rows.reduce<Record<string, Record<string, string | null>>>((articleMap, row) => {
    const articleCells = articleMap[row.articleId] ?? {}
    const columnId = getColumnId('llm', row.promptId, row.modelId)

    return {
      ...articleMap,
      [row.articleId]: {
        ...articleCells,
        [columnId]: getDisplayAnswer(row.answeredOriginal, row.answeredOriginalAsArray),
      },
    }
  }, {})
}

const getComparisonProjectHumanCells = (rows: ComparisonProjectHumanRow[]) => {
  const latestRows = rows.reduce<Map<string, ComparisonProjectHumanRow>>((rowMap, row) => {
    const key = `${row.articleId}:${row.userId}:${row.promptId}`
    const existingRow = rowMap.get(key)

    if (!existingRow || (row.updatedAt?.getTime() ?? 0) > (existingRow.updatedAt?.getTime() ?? 0)) {
      rowMap.set(key, row)
    }

    return rowMap
  }, new Map<string, ComparisonProjectHumanRow>())
  const groupedAnswers = Array.from(latestRows.values()).reduce<Record<string, Record<string, string[]>>>(
    (articleMap, row) => {
      const articleCells = articleMap[row.articleId] ?? {}
      const columnId = getColumnId('human', row.promptId)
      const existingAnswers = articleCells[columnId] ?? []

      return row.answer
        ? {...articleMap, [row.articleId]: {...articleCells, [columnId]: [...existingAnswers, row.answer.trim()]}}
        : articleMap
    },
    {},
  )

  return Object.entries(groupedAnswers).reduce<Record<string, Record<string, string | null>>>(
    (articleMap, [articleId, articleCells]) => {
      const normalizedCells = Object.entries(articleCells).reduce<Record<string, string | null>>(
        (cellMap, [columnId, answers]) => {
          const uniqueAnswers = Array.from(
            new Set(
              answers.filter((answer) => {
                return answer !== ''
              }),
            ),
          ).sort((left, right) => {
            return left.localeCompare(right)
          })

          return {...cellMap, [columnId]: uniqueAnswers.length > 0 ? uniqueAnswers.join('\n') : null}
        },
        {},
      )

      return {...articleMap, [articleId]: normalizedCells}
    },
    {},
  )
}

const getComparisonProjectJudgmentsPage = async (scope: ComparisonProjectScope, page: number, limit: number) => {
  if (scope.prompts.length === 0 || scope.columns.length === 0) {
    return {data: [], totalCount: 0, page: 1, limit, totalPages: 0}
  }

  const db = getDatabase()
  const articleScopeConditions = getArticleScopeConditions(scope.importRouteIds, scope.dateFrom, scope.dateTo)
  const llmExistsCondition = getComparisonProjectLlmExistsCondition(scope)
  const humanExistsCondition = getComparisonProjectHumanExistsCondition(scope)
  const articleDataCondition =
    llmExistsCondition && humanExistsCondition
      ? or(llmExistsCondition, humanExistsCondition)
      : (llmExistsCondition ?? humanExistsCondition)

  if (!articleDataCondition) {
    return {data: [], totalCount: 0, page: 1, limit, totalPages: 0}
  }

  const whereConditions = [...articleScopeConditions, articleDataCondition]
  const whereCondition = whereConditions.length > 1 ? and(...whereConditions) : whereConditions[0]
  const [countRow] = await db
    .select({count: sql<number>`count(*)::int`.as('count')})
    .from(articles)
    .where(whereCondition)
  const totalCount = countRow?.count ?? 0
  const totalPages = totalCount > 0 ? Math.ceil(totalCount / limit) : 0
  const safePage = totalPages > 0 ? Math.min(Math.max(page, 1), totalPages) : 1
  const offset = (safePage - 1) * limit
  const pageArticles = await db
    .select({id: articles.id, articleTitle: articles.articleTitle, articleCreatedAt: articles.articleCreatedAt})
    .from(articles)
    .where(whereCondition)
    .orderBy(desc(articles.articleCreatedAt), asc(articles.articleTitle), asc(articles.id))
    .limit(limit)
    .offset(offset)
  const articleIds = pageArticles.map((article) => {
    return article.id
  })
  const [llmRows, humanRows] = await Promise.all([
    getComparisonProjectLlmRows(scope, articleIds),
    getComparisonProjectHumanRows(scope, articleIds),
  ])
  const llmCellsByArticle = getComparisonProjectLlmCells(llmRows)
  const humanCellsByArticle = getComparisonProjectHumanCells(humanRows)
  const data = pageArticles.map((article) => {
    return {
      id: article.id,
      articleTitle: article.articleTitle,
      articleCreatedAt: article.articleCreatedAt,
      cells: {...(llmCellsByArticle[article.id] ?? {}), ...(humanCellsByArticle[article.id] ?? {})},
    }
  })

  return {data, totalCount, page: safePage, limit, totalPages}
}

const insertComparisonProjectPromptLinks = async (
  tx: DatabaseClient,
  comparisonProjectId: string,
  promptSelections: PromptSelection[],
) => {
  const promptIds = promptSelections.map((selection) => {
    return selection.promptId
  })

  if (promptIds.length === 0) {
    return
  }

  const promptRows = await tx.select({id: prompts.id}).from(prompts).where(inArray(prompts.id, promptIds))

  if (promptRows.length !== promptIds.length) {
    throw new Error('One or more selected prompts are invalid')
  }

  await tx.insert(comparisonProjectPrompt).values(
    promptSelections.map((selection) => {
      return {comparisonProjectId, promptId: selection.promptId, order: selection.order}
    }),
  )
}

const insertComparisonProjectRouteLinks = async (
  tx: DatabaseClient,
  comparisonProjectId: string,
  importRoutes: string[],
) => {
  if (importRoutes.length === 0) {
    return
  }

  const routeRows = await tx
    .select({id: importRouteTable.id, route: importRouteTable.route})
    .from(importRouteTable)
    .where(inArray(importRouteTable.route, importRoutes))

  if (routeRows.length !== importRoutes.length) {
    throw new Error('One or more selected import routes are invalid')
  }

  await tx.insert(comparisonProjectRouteLink).values(
    routeRows.map((routeRow) => {
      return {comparisonProjectId, importRouteId: routeRow.id}
    }),
  )
}

const getValidatedModelIds = async (tx: DatabaseClient, modelIds: string[]) => {
  if (modelIds.length === 0) {
    return null
  }

  const modelRows = await tx.select({id: models.id}).from(models).where(inArray(models.id, modelIds))

  if (modelRows.length !== modelIds.length) {
    throw new Error('One or more selected models are invalid')
  }

  return modelIds
}

export const comparisonProjectsRoutes = new Elysia()
  .use(withErrorHandler())
  .use(requireUserAuth())
  .get('/api/comparison-projects', async () => {
    const data = await getComparisonProjectsList(false)

    return {data}
  })
  .get('/api/comparison-projects/archived', async () => {
    const data = await getComparisonProjectsList(true)

    return {data}
  })
  .get('/api/comparison-projects/:id', async ({params, set}) => {
    const data = await getComparisonProjectScope(params.id)

    if (!data) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

    return {data}
  })
  .post(
    '/api/comparison-projects/:id/judgments',
    async ({params, body, set}) => {
      const data = await getComparisonProjectScope(params.id)

      if (!data) {
        set.status = 404
        return {data: null, error: 'Comparison project not found'}
      }

      const parsedPage = Number.parseInt(body.page, 10)
      const parsedLimit = Number.parseInt(body.limit, 10)
      const page = Number.isNaN(parsedPage) ? 1 : parsedPage
      const limit = Number.isNaN(parsedLimit) ? 50 : Math.min(Math.max(parsedLimit, 1), 100)
      const judgmentsPage = await getComparisonProjectJudgmentsPage(data, page, limit)

      return {data: judgmentsPage}
    },
    {body: t.Object({page: t.String(), limit: t.String()})},
  )
  .post(
    '/api/comparison-projects',
    async ({body}) => {
      const db = getDatabase()
      const dateFrom = parseOptionalDate(body.dateFrom)
      const dateTo = parseOptionalDate(body.dateTo)

      if (dateFrom && dateTo && dateFrom > dateTo) {
        throw new Error('date_from must be on or before date_to')
      }

      if (body.useFulltext && body.useFulltextNoImages) {
        throw new Error('Cannot enable both "Use Full Text" and "Use Full Text (No Images)" at the same time')
      }

      const uniqueModelIds = getUniqueStringValues(body.modelIds ?? [])
      const uniquePromptSelections = getUniquePromptSelections(body.promptSelections ?? [])
      const uniqueImportRoutes = getUniqueStringValues(body.importRoutes ?? [])

      const createdComparisonProject = await db.transaction(async (tx) => {
        const validatedModelIds = await getValidatedModelIds(tx, uniqueModelIds)
        const [newComparisonProject] = await tx
          .insert(comparisonProject)
          .values({
            name: body.name,
            description: body.description?.trim() || null,
            ownerId: body.ownerId,
            modelIds: validatedModelIds,
            compareWithHumans: body.compareWithHumans ?? false,
            useTitle: body.useTitle ?? true,
            useAbstract: body.useAbstract ?? true,
            useFulltext: body.useFulltext ?? false,
            useFulltextNoImages: body.useFulltextNoImages ?? false,
            dateFrom,
            dateTo,
          })
          .returning()

        if (!newComparisonProject) {
          throw new Error('Failed to create comparison project')
        }

        await insertComparisonProjectPromptLinks(tx, newComparisonProject.id, uniquePromptSelections)
        await insertComparisonProjectRouteLinks(tx, newComparisonProject.id, uniqueImportRoutes)

        return newComparisonProject
      })

      return {data: createdComparisonProject}
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.Union([t.String(), t.Null()])),
        ownerId: t.String(),
        modelIds: t.Optional(t.Array(t.String())),
        compareWithHumans: t.Optional(t.Boolean()),
        dateFrom: t.Optional(t.Union([t.String(), t.Null()])),
        dateTo: t.Optional(t.Union([t.String(), t.Null()])),
        useTitle: t.Optional(t.Boolean()),
        useAbstract: t.Optional(t.Boolean()),
        useFulltext: t.Optional(t.Boolean()),
        useFulltextNoImages: t.Optional(t.Boolean()),
        importRoutes: t.Optional(t.Array(t.String())),
        promptSelections: t.Optional(t.Array(t.Object({promptId: t.String(), order: t.Number()}))),
      }),
    },
  )
  .delete('/api/comparison-projects/:id', async ({params}) => {
    const db = getDatabase()
    const [archivedComparisonProject] = await db
      .update(comparisonProject)
      .set({archived: true, updatedAt: new Date()})
      .where(eq(comparisonProject.id, params.id))
      .returning()

    if (!archivedComparisonProject) {
      throw new Error('Comparison project not found')
    }

    return {success: true}
  })
  .post('/api/comparison-projects/:id/unarchive', async ({params}) => {
    const db = getDatabase()
    const [unarchivedComparisonProject] = await db
      .update(comparisonProject)
      .set({archived: false, updatedAt: new Date()})
      .where(eq(comparisonProject.id, params.id))
      .returning()

    if (!unarchivedComparisonProject) {
      throw new Error('Comparison project not found')
    }

    return {success: true}
  })
