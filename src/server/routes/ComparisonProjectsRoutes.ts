import {and, asc, desc, eq, gte, ilike, inArray, lte, or, SQL, sql} from 'drizzle-orm'
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
  projectPrompts,
  projectRouteLink,
  projects,
  prompts,
} from '../../db/schema.ts'
import {localUserId} from '../../utils/localUser.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'

type PromptSelection = {promptId: string; order: number}
type Database = ReturnType<typeof getDatabase>
type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type DatabaseClient = Database | DatabaseTransaction
type ComparisonProjectContentVariant = {
  key: string
  label: string
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}
type ComparisonProjectPromptConfig = {id: string; promptHeading: string | null; promptLabel: string; order: number}
type ComparisonProjectModelConfig = {id: string; name: string}
type ComparisonProjectJudgmentsColumn = {
  id: string
  kind: 'llm' | 'human'
  promptId: string
  promptLabel: string
  modelId: string | null
  modelLabel: string
  contentLabel: string | null
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
  contentVariants: ComparisonProjectContentVariant[]
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
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}
type ComparisonProjectHumanRow = {
  articleId: string
  promptId: string
  userId: string
  answer: string | null
  updatedAt: Date | null
}
type ComparisonProjectSourcePrompt = {id: string; promptHeading: string | null; order: number}
type ComparisonProjectSourceImportRoute = {route: string; name: string | null}
type ComparisonProjectSource = {
  id: string
  name: string
  description: string | null
  modelId: string
  modelName: string
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  prompts: ComparisonProjectSourcePrompt[]
  importRoutes: ComparisonProjectSourceImportRoute[]
}
type ComparisonProjectEditPrompt = {
  id: string
  originalText: string
  promptHeading: string | null
  type: string | null
  createdAt: Date
  archived: boolean
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

const getComparisonProjectContentKey = (settings: {
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}) => {
  return [settings.useTitle, settings.useAbstract, settings.useFulltext, settings.useFulltextNoImages]
    .map((value) => {
      return (value ? 1 : 0).toString()
    })
    .join('')
}

const getComparisonProjectContentLabel = (settings: {
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}) => {
  const textLabel =
    settings.useTitle || settings.useAbstract
      ? settings.useTitle && settings.useAbstract
        ? 'Article Title and Abstract'
        : settings.useTitle
          ? 'Article Title'
          : 'Article Abstract'
      : null
  const fulltextLabel = settings.useFulltextNoImages
    ? 'Use Full Text (without images)'
    : settings.useFulltext
      ? 'Use Full Text (with images)'
      : null
  const parts = [textLabel, fulltextLabel].filter(Boolean) as string[]

  return parts.length > 0 ? parts.join(' + ') : 'No content selected'
}

const getComparisonProjectContentVariants = (settings: {
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}) => {
  return [
    settings.useTitle || settings.useAbstract
      ? {
          key: getComparisonProjectContentKey({
            useTitle: settings.useTitle,
            useAbstract: settings.useAbstract,
            useFulltext: false,
            useFulltextNoImages: false,
          }),
          label: getComparisonProjectContentLabel({
            useTitle: settings.useTitle,
            useAbstract: settings.useAbstract,
            useFulltext: false,
            useFulltextNoImages: false,
          }),
          useTitle: settings.useTitle,
          useAbstract: settings.useAbstract,
          useFulltext: false,
          useFulltextNoImages: false,
        }
      : null,
    settings.useFulltext
      ? {
          key: getComparisonProjectContentKey({
            useTitle: false,
            useAbstract: false,
            useFulltext: true,
            useFulltextNoImages: false,
          }),
          label: getComparisonProjectContentLabel({
            useTitle: false,
            useAbstract: false,
            useFulltext: true,
            useFulltextNoImages: false,
          }),
          useTitle: false,
          useAbstract: false,
          useFulltext: true,
          useFulltextNoImages: false,
        }
      : null,
    settings.useFulltextNoImages
      ? {
          key: getComparisonProjectContentKey({
            useTitle: false,
            useAbstract: false,
            useFulltext: false,
            useFulltextNoImages: true,
          }),
          label: getComparisonProjectContentLabel({
            useTitle: false,
            useAbstract: false,
            useFulltext: false,
            useFulltextNoImages: true,
          }),
          useTitle: false,
          useAbstract: false,
          useFulltext: false,
          useFulltextNoImages: true,
        }
      : null,
  ].filter(isDefined)
}

const getComparisonProjectContentCondition = (contentVariants: ComparisonProjectContentVariant[]) => {
  const conditions = contentVariants.map((contentVariant) => {
    return and(
      eq(judgments.useTitle, contentVariant.useTitle),
      eq(judgments.useAbstract, contentVariant.useAbstract),
      eq(judgments.useFulltext, contentVariant.useFulltext),
      eq(judgments.useFulltextNoImages, contentVariant.useFulltextNoImages),
    )
  })

  return conditions.length > 0 ? or(...conditions) : null
}

const getComparisonProjectContentConditionSql = (
  tableAlias: string,
  contentVariants: ComparisonProjectContentVariant[],
) => {
  const getColumn = (columnName: string) => {
    return sql.raw(`${tableAlias}."${columnName}"`)
  }
  const conditions = contentVariants.map((contentVariant) => {
    return sql`(
      ${getColumn('use_title')} = ${contentVariant.useTitle}
      AND ${getColumn('use_abstract')} = ${contentVariant.useAbstract}
      AND ${getColumn('use_fulltext')} = ${contentVariant.useFulltext}
      AND ${getColumn('use_fulltext_no_images')} = ${contentVariant.useFulltextNoImages}
    )`
  })

  return conditions.length > 1 ? sql`(${sql.join(conditions, sql` OR `)})` : (conditions[0] ?? null)
}

const getColumnId = (kind: 'llm' | 'human', promptId: string, modelId?: string | null, contentKey?: string | null) => {
  return kind === 'human' ? `human:${promptId}` : `llm:${modelId}:${contentKey ?? 'default'}:${promptId}`
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

const getComparisonProjectSources = async (): Promise<ComparisonProjectSource[]> => {
  const db = getDatabase()
  const projectRows = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      modelId: projects.modelId,
      modelName: models.name,
      useTitle: projects.useTitle,
      useAbstract: projects.useAbstract,
      useFulltext: projects.useFulltext,
      useFulltextNoImages: projects.useFulltextNoImages,
    })
    .from(projects)
    .innerJoin(models, eq(models.id, projects.modelId))
    .where(eq(projects.archived, false))
    .orderBy(asc(projects.name))

  if (projectRows.length === 0) {
    return []
  }

  const projectIds = projectRows.map((projectRow) => {
    return projectRow.id
  })
  const [promptRows, routeRows] = await Promise.all([
    db
      .select({
        projectId: projectPrompts.projectId,
        promptId: prompts.id,
        promptHeading: prompts.promptHeading,
        order: projectPrompts.order,
      })
      .from(projectPrompts)
      .innerJoin(prompts, eq(prompts.id, projectPrompts.promptId))
      .where(and(inArray(projectPrompts.projectId, projectIds), eq(projectPrompts.enabled, true)))
      .orderBy(asc(projectPrompts.projectId), asc(projectPrompts.order), asc(prompts.createdAt)),
    db
      .select({projectId: projectRouteLink.projectId, route: importRouteTable.route, name: importRouteTable.name})
      .from(projectRouteLink)
      .innerJoin(importRouteTable, eq(projectRouteLink.importRouteId, importRouteTable.id))
      .where(inArray(projectRouteLink.projectId, projectIds))
      .orderBy(asc(projectRouteLink.projectId), asc(importRouteTable.route)),
  ])
  const promptRowsByProjectId = promptRows.reduce<Map<string, typeof promptRows>>((rowMap, promptRow) => {
    const currentRows = rowMap.get(promptRow.projectId) ?? []
    currentRows.push(promptRow)
    rowMap.set(promptRow.projectId, currentRows)
    return rowMap
  }, new Map<string, typeof promptRows>())
  const routeRowsByProjectId = routeRows.reduce<Map<string, typeof routeRows>>((rowMap, routeRow) => {
    const currentRows = rowMap.get(routeRow.projectId) ?? []
    currentRows.push(routeRow)
    rowMap.set(routeRow.projectId, currentRows)
    return rowMap
  }, new Map<string, typeof routeRows>())

  return projectRows
    .map<ComparisonProjectSource | null>((projectRow) => {
      const sourcePromptRows = promptRowsByProjectId.get(projectRow.id) ?? []
      const sourceImportRouteRows = routeRowsByProjectId.get(projectRow.id) ?? []

      if (sourcePromptRows.length === 0) {
        return null
      }

      return {
        ...projectRow,
        prompts: sourcePromptRows.map<ComparisonProjectSourcePrompt>((promptRow, index) => {
          return {id: promptRow.promptId, promptHeading: promptRow.promptHeading, order: promptRow.order ?? index}
        }),
        importRoutes: sourceImportRouteRows.map<ComparisonProjectSourceImportRoute>((routeRow) => {
          return {route: routeRow.route, name: routeRow.name}
        }),
      }
    })
    .filter(isDefined)
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
    contentVariants: ComparisonProjectContentVariant[]
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

  const contentCondition = getComparisonProjectContentCondition(comparisonProjectRow.contentVariants)

  if (!contentCondition) {
    return []
  }

  const articleScopeConditions = getArticleScopeConditions(
    importRouteIds,
    comparisonProjectRow.dateFrom,
    comparisonProjectRow.dateTo,
  )
  const queryConditions = [
    inArray(judgments.promptId, promptIds),
    contentCondition,
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
  contentVariants: ComparisonProjectContentVariant[],
  compareWithHumans: boolean,
) => {
  const llmColumns = promptRows.flatMap((promptRow) => {
    return modelRows.flatMap((modelRow) => {
      return contentVariants.map<ComparisonProjectJudgmentsColumn>((contentVariant) => {
        return {
          id: getColumnId('llm', promptRow.id, modelRow.id, contentVariant.key),
          kind: 'llm',
          promptId: promptRow.id,
          promptLabel: promptRow.promptLabel,
          modelId: modelRow.id,
          modelLabel: modelRow.name,
          contentLabel: contentVariant.label,
        }
      })
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
          contentLabel: null,
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
  const contentVariants = getComparisonProjectContentVariants(comparisonProjectRow)
  const modelRows = await getComparisonProjectModels(
    {...comparisonProjectRow, contentVariants},
    promptConfigs.map((prompt) => {
      return prompt.id
    }),
    importRouteIds,
  )
  const columns = getComparisonProjectColumns(
    promptConfigs,
    modelRows,
    contentVariants,
    comparisonProjectRow.compareWithHumans,
  )

  return {...comparisonProjectRow, contentVariants, prompts: promptConfigs, models: modelRows, importRouteIds, columns}
}

const getComparisonProjectEditFormData = async (comparisonProjectId: string) => {
  const db = getDatabase()
  const [comparisonProjectRow] = await db
    .select({
      id: comparisonProject.id,
      name: comparisonProject.name,
      description: comparisonProject.description,
      compareWithHumans: comparisonProject.compareWithHumans,
    })
    .from(comparisonProject)
    .where(eq(comparisonProject.id, comparisonProjectId))
    .limit(1)

  if (!comparisonProjectRow) {
    return null
  }

  const [selectedPromptRows, availablePromptRows] = await Promise.all([
    db
      .select({
        id: prompts.id,
        originalText: prompts.originalText,
        promptHeading: prompts.promptHeading,
        type: prompts.type,
        createdAt: prompts.createdAt,
        archived: prompts.archived,
        order: comparisonProjectPrompt.order,
      })
      .from(comparisonProjectPrompt)
      .innerJoin(prompts, eq(prompts.id, comparisonProjectPrompt.promptId))
      .where(eq(comparisonProjectPrompt.comparisonProjectId, comparisonProjectId))
      .orderBy(asc(comparisonProjectPrompt.order), asc(prompts.createdAt)),
    db
      .select({
        id: prompts.id,
        originalText: prompts.originalText,
        promptHeading: prompts.promptHeading,
        type: prompts.type,
        createdAt: prompts.createdAt,
        archived: prompts.archived,
      })
      .from(prompts)
      .where(eq(prompts.archived, false))
      .orderBy(desc(prompts.createdAt)),
  ])
  const selectedPromptIds = new Set(
    selectedPromptRows.map((promptRow) => {
      return promptRow.id
    }),
  )
  const availablePrompts = [
    ...selectedPromptRows.map<ComparisonProjectEditPrompt>((promptRow) => {
      return {
        id: promptRow.id,
        originalText: promptRow.originalText,
        promptHeading: promptRow.promptHeading,
        type: promptRow.type,
        createdAt: promptRow.createdAt,
        archived: promptRow.archived,
      }
    }),
    ...availablePromptRows
      .filter((promptRow) => {
        return !selectedPromptIds.has(promptRow.id)
      })
      .map<ComparisonProjectEditPrompt>((promptRow) => {
        return {
          id: promptRow.id,
          originalText: promptRow.originalText,
          promptHeading: promptRow.promptHeading,
          type: promptRow.type,
          createdAt: promptRow.createdAt,
          archived: promptRow.archived,
        }
      }),
  ]

  return {
    ...comparisonProjectRow,
    promptSelections: selectedPromptRows.map((promptRow, index) => {
      return {promptId: promptRow.id, order: promptRow.order ?? index}
    }),
    availablePrompts,
  }
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
  const contentCondition = getComparisonProjectContentConditionSql('j', scope.contentVariants)

  if (!promptIdArray || !modelIdArray || !contentCondition) {
    return null
  }

  return sql`EXISTS (
    SELECT 1 FROM ${judgments} j
    WHERE j."article_id" = ${articles.id}
      AND j."deleted_at" IS NULL
      AND j."prompt_id" = ANY(ARRAY[${promptIdArray}])
      AND j."model_id" = ANY(ARRAY[${modelIdArray}])
      AND ${contentCondition}
      AND (
        NULLIF(BTRIM(j."answered_original"), '') IS NOT NULL
        OR COALESCE(array_length(j."answered_original_as_array", 1), 0) > 0
      )
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
      AND NULLIF(BTRIM(jh."answer"), '') IS NOT NULL
  )`
}

const getComparisonProjectMinimumAnsweredPromptsCondition = (
  scope: ComparisonProjectScope,
  minimumAnsweredPrompts: number,
) => {
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
  const llmContentCondition = getComparisonProjectContentConditionSql('j', scope.contentVariants)
  const llmAnsweredPromptsQuery =
    modelIdArray && llmContentCondition
      ? sql`
        SELECT j."prompt_id" AS prompt_id
        FROM ${judgments} j
        WHERE j."article_id" = ${articles.id}
          AND j."deleted_at" IS NULL
          AND j."prompt_id" = ANY(ARRAY[${promptIdArray}])
          AND j."model_id" = ANY(ARRAY[${modelIdArray}])
          AND ${llmContentCondition}
          AND (
            NULLIF(BTRIM(j."answered_original"), '') IS NOT NULL
            OR COALESCE(array_length(j."answered_original_as_array", 1), 0) > 0
          )
      `
      : null
  const humanAnsweredPromptsQuery = scope.compareWithHumans
    ? sql`
        SELECT jh."prompt_id" AS prompt_id
        FROM ${judgmentsHuman} jh
        WHERE jh."article_id" = ${articles.id}
          AND jh."prompt_id" = ANY(ARRAY[${promptIdArray}])
          AND jh."is_answered" = true
          AND NULLIF(BTRIM(jh."answer"), '') IS NOT NULL
      `
    : null
  const answeredPromptsQueries = [llmAnsweredPromptsQuery, humanAnsweredPromptsQuery].filter(isDefined)

  if (!promptIdArray || answeredPromptsQueries.length === 0) {
    return null
  }

  return sql`(
    SELECT COUNT(DISTINCT answered_prompts.prompt_id)::int
    FROM (${sql.join(answeredPromptsQueries, sql` UNION `)}) AS answered_prompts
  ) >= ${minimumAnsweredPrompts}`
}

const getComparisonProjectAllShownColumnsAnsweredCondition = (scope: ComparisonProjectScope) => {
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
  const llmContentCondition = getComparisonProjectContentConditionSql('j', scope.contentVariants)

  if (!promptIdArray || !modelIdArray || !llmContentCondition || scope.contentVariants.length === 0) {
    return null
  }

  const requiredLlmColumnCount = scope.prompts.length * scope.models.length * scope.contentVariants.length
  const llmColumnsCondition = sql`(
    SELECT COUNT(DISTINCT (j."prompt_id", j."model_id", j."use_title", j."use_abstract", j."use_fulltext", j."use_fulltext_no_images"))::int
    FROM ${judgments} j
    WHERE j."article_id" = ${articles.id}
      AND j."deleted_at" IS NULL
      AND j."prompt_id" = ANY(ARRAY[${promptIdArray}])
      AND j."model_id" = ANY(ARRAY[${modelIdArray}])
      AND ${llmContentCondition}
      AND (
        NULLIF(BTRIM(j."answered_original"), '') IS NOT NULL
        OR COALESCE(array_length(j."answered_original_as_array", 1), 0) > 0
      )
  ) = ${requiredLlmColumnCount}`
  const humanColumnsCondition = scope.compareWithHumans
    ? sql`(
        SELECT COUNT(DISTINCT jh."prompt_id")::int
        FROM ${judgmentsHuman} jh
        WHERE jh."article_id" = ${articles.id}
          AND jh."prompt_id" = ANY(ARRAY[${promptIdArray}])
          AND jh."is_answered" = true
          AND NULLIF(BTRIM(jh."answer"), '') IS NOT NULL
      ) = ${scope.prompts.length}`
    : null

  return humanColumnsCondition ? and(llmColumnsCondition, humanColumnsCondition) : llmColumnsCondition
}

const getComparisonProjectModelDifferenceCondition = (scope: ComparisonProjectScope) => {
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
  const contentCondition = getComparisonProjectContentConditionSql('j', scope.contentVariants)

  if (!promptIdArray || !modelIdArray || !contentCondition || scope.models.length * scope.contentVariants.length < 2) {
    return sql`false`
  }

  return sql`EXISTS (
    SELECT 1
    FROM ${judgments} j
    WHERE j."article_id" = ${articles.id}
      AND j."deleted_at" IS NULL
      AND j."prompt_id" = ANY(ARRAY[${promptIdArray}])
      AND j."model_id" = ANY(ARRAY[${modelIdArray}])
      AND ${contentCondition}
      AND (
        NULLIF(BTRIM(j."answered_original"), '') IS NOT NULL
        OR COALESCE(array_length(j."answered_original_as_array", 1), 0) > 0
      )
    GROUP BY j."prompt_id"
    HAVING COUNT(
      DISTINCT LOWER(
        BTRIM(
          CASE
            WHEN COALESCE(array_length(j."answered_original_as_array", 1), 0) > 0
              THEN array_to_string(j."answered_original_as_array", E'\n')
            ELSE j."answered_original"
          END
        )
      )
    ) > 1
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
  const contentCondition = getComparisonProjectContentCondition(scope.contentVariants)

  if (!contentCondition) {
    return []
  }

  return db
    .select({
      articleId: judgments.articleId,
      promptId: judgments.promptId,
      modelId: judgments.modelId,
      answeredOriginal: judgments.answeredOriginal,
      answeredOriginalAsArray: judgments.answeredOriginalAsArray,
      useTitle: judgments.useTitle,
      useAbstract: judgments.useAbstract,
      useFulltext: judgments.useFulltext,
      useFulltextNoImages: judgments.useFulltextNoImages,
    })
    .from(judgments)
    .where(
      and(
        inArray(judgments.articleId, articleIds),
        inArray(judgments.promptId, promptIds),
        inArray(judgments.modelId, modelIds),
        contentCondition,
        sql`${judgments.deletedAt} IS NULL`,
        sql`(
          NULLIF(BTRIM(${judgments.answeredOriginal}), '') IS NOT NULL
          OR COALESCE(array_length(${judgments.answeredOriginalAsArray}, 1), 0) > 0
        )`,
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
        sql`NULLIF(BTRIM(${judgmentsHuman.answer}), '') IS NOT NULL`,
      ),
    )
}

const getComparisonProjectLlmCells = (rows: ComparisonProjectLlmRow[]) => {
  return rows.reduce<Record<string, Record<string, string | null>>>((articleMap, row) => {
    const articleCells = articleMap[row.articleId] ?? {}
    const columnId = getColumnId('llm', row.promptId, row.modelId, getComparisonProjectContentKey(row))

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

const getComparisonProjectDefaultLlmJudgmentsPage = async (
  scope: ComparisonProjectScope,
  page: number,
  limit: number,
  articleScopeConditions: SQL<unknown>[],
) => {
  const llmExistsCondition = getComparisonProjectLlmExistsCondition(scope)

  if (!llmExistsCondition) {
    return {data: [], totalCount: 0, page: 1, limit, totalPages: 0}
  }

  const db = getDatabase()
  const whereConditions = [...articleScopeConditions, llmExistsCondition]
  const whereCondition = whereConditions.length > 1 ? and(...whereConditions) : whereConditions[0]
  const safePage = Math.max(page, 1)
  const offset = (safePage - 1) * limit
  const pageArticlesWithExtra = await db
    .select({id: articles.id, articleTitle: articles.articleTitle, articleCreatedAt: articles.articleCreatedAt})
    .from(articles)
    .where(whereCondition)
    .orderBy(desc(articles.articleCreatedAt), asc(articles.articleTitle), asc(articles.id))
    .limit(limit + 1)
    .offset(offset)
  const hasMore = pageArticlesWithExtra.length > limit
  const pageArticles = hasMore ? pageArticlesWithExtra.slice(0, limit) : pageArticlesWithExtra
  const articleIds = pageArticles.map((article) => {
    return article.id
  })
  const llmRows = await getComparisonProjectLlmRows(scope, articleIds)
  const llmCellsByArticle = getComparisonProjectLlmCells(llmRows)
  const data = pageArticles.map((article) => {
    return {
      id: article.id,
      articleTitle: article.articleTitle,
      articleCreatedAt: article.articleCreatedAt,
      cells: llmCellsByArticle[article.id] ?? {},
    }
  })
  const totalCount = offset + pageArticles.length + (hasMore ? 1 : 0)
  const totalPages = hasMore ? safePage + 1 : safePage

  return {data, totalCount, page: safePage, limit, totalPages}
}

const getComparisonProjectJudgmentsPage = async (
  scope: ComparisonProjectScope,
  page: number,
  limit: number,
  hideSparseRows: boolean,
  showOnlyFullyAnsweredPrompts: boolean,
  showOnlyModelDifferences: boolean,
) => {
  if (scope.prompts.length === 0 || scope.columns.length === 0) {
    return {data: [], totalCount: 0, page: 1, limit, totalPages: 0}
  }

  const articleScopeConditions = getArticleScopeConditions(scope.importRouteIds, scope.dateFrom, scope.dateTo)
  const useDefaultLlmPath =
    !scope.compareWithHumans && !hideSparseRows && !showOnlyFullyAnsweredPrompts && !showOnlyModelDifferences

  if (useDefaultLlmPath) {
    return getComparisonProjectDefaultLlmJudgmentsPage(scope, page, limit, articleScopeConditions)
  }

  const db = getDatabase()
  const llmExistsCondition = getComparisonProjectLlmExistsCondition(scope)
  const humanExistsCondition = getComparisonProjectHumanExistsCondition(scope)
  const minimumAnsweredPromptsCondition = hideSparseRows
    ? getComparisonProjectMinimumAnsweredPromptsCondition(scope, 2)
    : null
  const fullyAnsweredPromptsCondition = showOnlyFullyAnsweredPrompts
    ? getComparisonProjectAllShownColumnsAnsweredCondition(scope)
    : null
  const modelDifferenceCondition = showOnlyModelDifferences ? getComparisonProjectModelDifferenceCondition(scope) : null
  const articleDataCondition =
    llmExistsCondition && humanExistsCondition
      ? or(llmExistsCondition, humanExistsCondition)
      : (llmExistsCondition ?? humanExistsCondition)

  if (!articleDataCondition) {
    return {data: [], totalCount: 0, page: 1, limit, totalPages: 0}
  }

  const whereConditions = [
    ...articleScopeConditions,
    articleDataCondition,
    minimumAnsweredPromptsCondition,
    fullyAnsweredPromptsCondition,
    modelDifferenceCondition,
  ].filter(isDefined)
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

const createComparisonProjectRecord = async (
  tx: DatabaseClient,
  body: {
    name: string
    description?: string | null
    modelIds?: string[]
    compareWithHumans?: boolean
    dateFrom?: string | null
    dateTo?: string | null
    useTitle?: boolean
    useAbstract?: boolean
    useFulltext?: boolean
    useFulltextNoImages?: boolean
    importRoutes?: string[]
    promptSelections?: PromptSelection[]
  },
) => {
  const dateFrom = parseOptionalDate(body.dateFrom)
  const dateTo = parseOptionalDate(body.dateTo)
  const useTitle = body.useTitle ?? true
  const useAbstract = body.useAbstract ?? true
  const useFulltext = body.useFulltext ?? false
  const useFulltextNoImages = body.useFulltextNoImages ?? false

  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new Error('date_from must be on or before date_to')
  }

  if (!useTitle && !useAbstract && !useFulltext && !useFulltextNoImages) {
    throw new Error('Select at least one article content option to compare')
  }

  const validatedModelIds = await getValidatedModelIds(tx, getUniqueStringValues(body.modelIds ?? []))
  const uniquePromptSelections = getUniquePromptSelections(body.promptSelections ?? [])
  const uniqueImportRoutes = getUniqueStringValues(body.importRoutes ?? [])
  const [newComparisonProject] = await tx
    .insert(comparisonProject)
    .values({
      name: body.name,
      description: body.description?.trim() || null,
      ownerId: localUserId,
      modelIds: validatedModelIds,
      compareWithHumans: body.compareWithHumans ?? false,
      useTitle,
      useAbstract,
      useFulltext,
      useFulltextNoImages,
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
}

export const comparisonProjectsRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/comparison-projects', async () => {
    const data = await getComparisonProjectsList(false)

    return {data}
  })
  .get('/api/comparison-projects/archived', async () => {
    const data = await getComparisonProjectsList(true)

    return {data}
  })
  .get('/api/comparison-projects/sources', async () => {
    const data = await getComparisonProjectSources()

    return {data}
  })
  .post(
    '/api/comparison-projects/from-project',
    async (context) => {
      const {body} = context
      const sources = await getComparisonProjectSources()
      const sourceProject = sources.find((source) => {
        return source.id === body.sourceProjectId
      })

      if (!sourceProject) {
        throw new Error('Source project not found')
      }

      const db = getDatabase()
      const createdComparisonProject = await db.transaction(async (tx) => {
        return createComparisonProjectRecord(tx, {
          name: body.name,
          description: body.description,
          modelIds: [sourceProject.modelId],
          compareWithHumans: body.compareWithHumans,
          dateFrom: body.dateFrom,
          dateTo: body.dateTo,
          useTitle: sourceProject.useTitle,
          useAbstract: sourceProject.useAbstract,
          useFulltext: sourceProject.useFulltext,
          useFulltextNoImages: sourceProject.useFulltextNoImages,
          importRoutes: sourceProject.importRoutes.map((importRoute) => {
            return importRoute.route
          }),
          promptSelections: sourceProject.prompts.map((prompt) => {
            return {promptId: prompt.id, order: prompt.order}
          }),
        })
      })

      return {data: createdComparisonProject}
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.Union([t.String(), t.Null()])),
        compareWithHumans: t.Optional(t.Boolean()),
        dateFrom: t.Optional(t.Union([t.String(), t.Null()])),
        dateTo: t.Optional(t.Union([t.String(), t.Null()])),
        sourceProjectId: t.String(),
      }),
    },
  )
  .get('/api/comparison-projects/:id/edit', async (context) => {
    const {params, set} = context
    const data = await getComparisonProjectEditFormData(params.id)

    if (!data) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

    return {data}
  })
  .get('/api/comparison-projects/:id', async (context) => {
    const {params, set} = context
    const data = await getComparisonProjectScope(params.id)

    if (!data) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

    return {data}
  })
  .post(
    '/api/comparison-projects/:id/judgments',
    async (context) => {
      const {params, body, set} = context
      const data = await getComparisonProjectScope(params.id)

      if (!data) {
        set.status = 404
        return {data: null, error: 'Comparison project not found'}
      }

      const parsedPage = Number.parseInt(body.page, 10)
      const parsedLimit = Number.parseInt(body.limit, 10)
      const page = Number.isNaN(parsedPage) ? 1 : parsedPage
      const limit = Number.isNaN(parsedLimit) ? 50 : Math.min(Math.max(parsedLimit, 1), 100)
      const judgmentsPage = await getComparisonProjectJudgmentsPage(
        data,
        page,
        limit,
        body.hideSparseRows ?? false,
        body.showOnlyFullyAnsweredPrompts ?? false,
        body.showOnlyModelDifferences ?? false,
      )

      return {data: judgmentsPage}
    },
    {
      body: t.Object({
        page: t.String(),
        limit: t.String(),
        hideSparseRows: t.Optional(t.Boolean()),
        showOnlyFullyAnsweredPrompts: t.Optional(t.Boolean()),
        showOnlyModelDifferences: t.Optional(t.Boolean()),
      }),
    },
  )
  .post(
    '/api/comparison-projects',
    async (context) => {
      const {body} = context
      const db = getDatabase()
      const createdComparisonProject = await db.transaction(async (tx) => {
        return createComparisonProjectRecord(tx, body)
      })

      return {data: createdComparisonProject}
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.Union([t.String(), t.Null()])),
        modelIds: t.Optional(t.Array(t.String())),
        compareWithHumans: t.Optional(t.Boolean()),
        dateFrom: t.Optional(t.Union([t.String(), t.Null()])),
        dateTo: t.Optional(t.Union([t.String(), t.Null()])),
        useTitle: t.Boolean(),
        useAbstract: t.Boolean(),
        useFulltext: t.Boolean(),
        useFulltextNoImages: t.Boolean(),
        importRoutes: t.Optional(t.Array(t.String())),
        promptSelections: t.Optional(t.Array(t.Object({promptId: t.String(), order: t.Number()}))),
      }),
    },
  )
  .patch(
    '/api/comparison-projects/:id',
    async (context) => {
      const {params, body, set} = context
      const db = getDatabase()
      const existingComparisonProject = await getComparisonProjectEditFormData(params.id)

      if (!existingComparisonProject) {
        set.status = 404
        return {data: null, error: 'Comparison project not found'}
      }

      const updatedComparisonProject = await db.transaction(async (tx) => {
        const [updatedComparisonProjectRow] = await tx
          .update(comparisonProject)
          .set({
            name: body.name,
            description: body.description?.trim() || null,
            compareWithHumans: body.compareWithHumans,
            updatedAt: new Date(),
          })
          .where(eq(comparisonProject.id, params.id))
          .returning()

        if (!updatedComparisonProjectRow) {
          throw new Error('Comparison project not found')
        }

        await tx.delete(comparisonProjectPrompt).where(eq(comparisonProjectPrompt.comparisonProjectId, params.id))
        await insertComparisonProjectPromptLinks(tx, params.id, getUniquePromptSelections(body.promptSelections))

        return updatedComparisonProjectRow
      })

      return {data: updatedComparisonProject}
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.Union([t.String(), t.Null()])),
        compareWithHumans: t.Boolean(),
        promptSelections: t.Array(t.Object({promptId: t.String(), order: t.Number()})),
      }),
    },
  )
  .delete('/api/comparison-projects/:id', async (context) => {
    const {params, set} = context
    const db = getDatabase()
    const [archivedComparisonProject] = await db
      .update(comparisonProject)
      .set({archived: true, updatedAt: new Date()})
      .where(eq(comparisonProject.id, params.id))
      .returning()

    if (!archivedComparisonProject) {
      set.status = 404
      return {success: false, error: 'Comparison project not found'}
    }

    return {success: true}
  })
  .post('/api/comparison-projects/:id/unarchive', async (context) => {
    const {params, set} = context
    const db = getDatabase()
    const [unarchivedComparisonProject] = await db
      .update(comparisonProject)
      .set({archived: false, updatedAt: new Date()})
      .where(eq(comparisonProject.id, params.id))
      .returning()

    if (!unarchivedComparisonProject) {
      set.status = 404
      return {success: false, error: 'Comparison project not found'}
    }

    return {success: true}
  })
