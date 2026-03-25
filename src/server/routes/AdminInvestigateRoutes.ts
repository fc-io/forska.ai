import {Elysia, t} from 'elysia'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import * as appQueryHelpers from '../services/appQueryHelpers.ts'
import {getAppQueryService} from '../services/getAppQueryService.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'

const appDatabaseService = getAppDatabaseService()
const appQueryService = getAppQueryService()

const parseArktypeOptions = (typeStr: string | null): string[] => {
  if (!typeStr) return []
  const matches = typeStr.match(/['"]([^'"]+)['"]/g)
  return (
    matches?.map((match) => {
      return match.slice(1, -1)
    }) ?? []
  )
}

const isArrayType = (typeStr: string | null): boolean => {
  if (!typeStr) return false
  return typeStr.includes('[]')
}

const isOpenEndedType = (typeStr: string | null): boolean => {
  if (!typeStr) return true
  return !/['"]/.test(typeStr)
}

type ProjectScope = {
  modelId: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  dateFrom: Date | null
  dateTo: Date | null
  importRouteIds: string[]
  curatedArticleIds: string[]
}

type PromptWithType = {id: string; promptHeading: string | null; type: string | null}

type StringAnswerBucket = {value: string | null; count: number}
type ArrayAnswerBucket = {value: string | null; parsedValue: unknown; count: number}

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

const getProjectJudgmentClause = (projectScope: ProjectScope | null, judgmentAlias: string) => {
  if (!projectScope) {
    return null
  }

  const curatedClause =
    projectScope.curatedArticleIds.length > 0
      ? `a.id IN (${appQueryHelpers.getQuotedStringList(projectScope.curatedArticleIds).join(', ')})`
      : null
  const routeOrCuratedClause = appQueryHelpers.getAndClause([
    `a.id = ${judgmentAlias}.article_id`,
    projectScope.importRouteIds.length > 0 || curatedClause
      ? `(${[
          projectScope.importRouteIds.length > 0
            ? `EXISTS (
                SELECT 1
                FROM app.article_import_route air
                WHERE air.article_id = a.id
                  AND air.import_route_id IN (${appQueryHelpers.getQuotedStringList(projectScope.importRouteIds).join(', ')})
              )`
            : null,
          curatedClause,
        ]
          .filter(Boolean)
          .join(' OR ')})`
      : null,
    projectScope.dateFrom ? `a.article_created_at >= ${appQueryHelpers.getSqlLiteral(projectScope.dateFrom)}` : null,
    projectScope.dateTo ? `a.article_created_at <= ${appQueryHelpers.getSqlLiteral(projectScope.dateTo)}` : null,
  ])

  return appQueryHelpers.getAndClause([
    `${judgmentAlias}.model_id = ${appQueryHelpers.getSqlLiteral(projectScope.modelId)}`,
    `${judgmentAlias}.use_title = ${appQueryHelpers.getSqlLiteral(projectScope.useTitle)}`,
    `${judgmentAlias}.use_abstract = ${appQueryHelpers.getSqlLiteral(projectScope.useAbstract)}`,
    `${judgmentAlias}.use_fulltext = ${appQueryHelpers.getSqlLiteral(projectScope.useFulltext)}`,
    `${judgmentAlias}.use_fulltext_no_images = ${appQueryHelpers.getSqlLiteral(projectScope.useFulltextNoImages)}`,
    routeOrCuratedClause ? `EXISTS (SELECT 1 FROM app.article a WHERE ${routeOrCuratedClause})` : null,
  ])
}

const getPromptById = async (promptId: string) => {
  const [prompt] = await appDatabaseService.queryJson<{id: string; type: string | null}>(`
    SELECT id, type
    FROM app.prompt
    WHERE id = '${appQueryHelpers.escapeSqlString(promptId)}'
    LIMIT 1
  `)

  return prompt ?? null
}

const getProjectName = async (projectId: string) => {
  const [project] = await appDatabaseService.queryJson<{name: string}>(`
    SELECT name
    FROM app.project
    WHERE id = '${appQueryHelpers.escapeSqlString(projectId)}'
    LIMIT 1
  `)

  return project?.name ?? null
}

const getProjectPrompts = async (projectId: string) => {
  return appQueryService.getProjectPromptRows(projectId).then((rows) => {
    return rows.filter((row) => {
      return row.type !== null
    })
  })
}

const getTypedPrompts = async () => {
  return appDatabaseService.queryJson<{
    id: string
    promptHeading: string | null
    type: string | null
    originalText: string
    createdAt: unknown
    archived: boolean
  }>(`
    SELECT
      id,
      prompt_heading AS promptHeading,
      type,
      original_text AS originalText,
      created_at AS createdAt,
      archived
    FROM app.prompt
    WHERE type IS NOT NULL
    ORDER BY prompt_heading ASC NULLS LAST
  `)
}

const getPromptSelection = async (projectId: string | null, promptId: string | null) => {
  return promptId
    ? appDatabaseService.queryJson<PromptWithType>(`
        SELECT id, prompt_heading AS promptHeading, type
        FROM app.prompt
        WHERE id = '${appQueryHelpers.escapeSqlString(promptId)}'
          AND type IS NOT NULL
      `)
    : projectId
      ? getProjectPrompts(projectId)
      : appDatabaseService.queryJson<PromptWithType>(`
          SELECT id, prompt_heading AS promptHeading, type
          FROM app.prompt
          WHERE type IS NOT NULL
        `)
}

const fetchProjectScope = async (projectId: string): Promise<ProjectScope | null> => {
  const [projectConfig, curatedRows] = await Promise.all([
    appQueryService.getProjectReviewConfig(projectId),
    appDatabaseService.queryJson<{articleId: string}>(`
      SELECT article_id AS articleId
      FROM app.project_article
      WHERE project_id = '${appQueryHelpers.escapeSqlString(projectId)}'
    `),
  ])

  return projectConfig
    ? {
        modelId: projectConfig.modelId,
        useTitle: projectConfig.useTitle,
        useAbstract: projectConfig.useAbstract,
        useFulltext: projectConfig.useFulltext,
        useFulltextNoImages: projectConfig.useFulltextNoImages,
        dateFrom: projectConfig.dateFrom,
        dateTo: projectConfig.dateTo,
        importRouteIds: projectConfig.importRouteIds,
        curatedArticleIds: curatedRows.map((row) => {
          return row.articleId
        }),
      }
    : null
}

const getStringAnswerBuckets = async (
  promptId: string,
  projectScope: ProjectScope | null,
): Promise<StringAnswerBucket[]> => {
  const whereClause = appQueryHelpers.getAndClause([
    `j.prompt_id = '${appQueryHelpers.escapeSqlString(promptId)}'`,
    'j.deleted_at IS NULL',
    getProjectJudgmentClause(projectScope, 'j'),
  ])

  return appDatabaseService.queryJson<StringAnswerBucket>(`
    SELECT
      j.answered_original AS value,
      COUNT(*) AS count
    FROM app.judgment j
    WHERE ${whereClause}
    GROUP BY j.answered_original
  `)
}

const getArrayAnswerBuckets = async (
  promptId: string,
  projectScope: ProjectScope | null,
): Promise<ArrayAnswerBucket[]> => {
  const whereClause = appQueryHelpers.getAndClause([
    `j.prompt_id = '${appQueryHelpers.escapeSqlString(promptId)}'`,
    'j.deleted_at IS NULL',
    getProjectJudgmentClause(projectScope, 'j'),
  ])
  const rows = await appDatabaseService.queryJson<{value: string | null; count: number}>(`
    SELECT
      TO_JSON(j.answered_original_as_array) AS value,
      COUNT(*) AS count
    FROM app.judgment j
    WHERE ${whereClause}
    GROUP BY j.answered_original_as_array
  `)

  return rows.map((row) => {
    return {value: row.value, parsedValue: appQueryHelpers.getJsonValue(row.value), count: row.count}
  })
}

const getUnexpectedArrayAnswers = (buckets: ArrayAnswerBucket[], expectedOptions: string[]) => {
  return buckets
    .filter((bucket) => {
      if (bucket.parsedValue === null) return true
      if (!Array.isArray(bucket.parsedValue)) return true
      if (bucket.parsedValue.length === 0) return true
      return bucket.parsedValue.some((value) => {
        return typeof value !== 'string' || !expectedOptions.includes(value)
      })
    })
    .map((bucket) => {
      return {value: bucket.value, count: bucket.count}
    })
}

const getUnexpectedStringAnswers = (buckets: StringAnswerBucket[], expectedOptions: string[]) => {
  return buckets.filter((bucket) => {
    if (bucket.value === null) return true
    if (bucket.value === '') return true
    return !expectedOptions.includes(bucket.value)
  })
}

const getUnexpectedAnswersSummary = async (params: {
  promptId: string
  promptType: string | null
  projectScope: ProjectScope | null
}) => {
  const expectedOptions = parseArktypeOptions(params.promptType)
  const isArray = isArrayType(params.promptType)
  const arrayBuckets = isArray ? await getArrayAnswerBuckets(params.promptId, params.projectScope) : []
  const stringBuckets = isArray ? [] : await getStringAnswerBuckets(params.promptId, params.projectScope)
  const unexpectedAnswers = isArray
    ? getUnexpectedArrayAnswers(arrayBuckets, expectedOptions).sort((left, right) => {
        return right.count - left.count
      })
    : getUnexpectedStringAnswers(stringBuckets, expectedOptions).sort((left, right) => {
        return right.count - left.count
      })
  const totalJudgments = (isArray ? arrayBuckets : stringBuckets).reduce((sum, bucket) => {
    return sum + bucket.count
  }, 0)

  return {expectedOptions, totalJudgments, unexpectedAnswers}
}

const deleteUnexpectedJudgments = async (
  projectId: string | null,
  promptId: string,
  unexpectedValue: string | null,
) => {
  const prompt = await getPromptById(promptId)

  if (!prompt || isOpenEndedType(prompt.type)) {
    return {deleted: 0}
  }

  const expectedOptions = parseArktypeOptions(prompt.type)
  if (expectedOptions.length === 0) {
    return {deleted: 0}
  }

  const projectScope = projectId ? await fetchProjectScope(projectId) : null
  if (projectId && !projectScope) {
    return {deleted: 0}
  }

  const isArray = isArrayType(prompt.type)
  const whereClause = appQueryHelpers.getAndClause([
    `j.prompt_id = '${appQueryHelpers.escapeSqlString(promptId)}'`,
    'j.deleted_at IS NULL',
    getProjectJudgmentClause(projectScope, 'j'),
  ])
  const judgmentRows = await appDatabaseService.queryJson<{
    id: string
    answeredOriginal: string | null
    answeredOriginalAsArray: string | null
  }>(`
    SELECT
      j.id AS id,
      j.answered_original AS answeredOriginal,
      TO_JSON(j.answered_original_as_array) AS answeredOriginalAsArray
    FROM app.judgment j
    WHERE ${whereClause}
  `)
  const idsToDelete = judgmentRows
    .filter((row) => {
      const parsedArray = appQueryHelpers.getJsonValue(row.answeredOriginalAsArray)
      const currentValue = isArray ? (parsedArray === null ? null : JSON.stringify(parsedArray)) : row.answeredOriginal
      return currentValue === unexpectedValue
    })
    .map((row) => {
      return row.id
    })

  if (idsToDelete.length === 0) {
    return {deleted: 0}
  }

  const now = new Date()
  await appDatabaseService.run(`
    UPDATE app.judgment
    SET deleted_at = ${appQueryHelpers.getSqlLiteral(now)},
        updated_at = ${appQueryHelpers.getSqlLiteral(now)}
    WHERE id IN (${appQueryHelpers.getQuotedStringList(idsToDelete).join(', ')})
  `)

  return {deleted: idsToDelete.length}
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
    try {
      console.log(
        `[AutoSyncAll] Starting auto-sync all unexpected answers${projectId ? ` for project ${projectId}` : ''}...`,
      )

      const promptsToProcess = await getPromptSelection(projectId, null)
      const projectScope = projectId ? await fetchProjectScope(projectId) : null
      const filteredPrompts = promptsToProcess.filter((prompt) => {
        return !isOpenEndedType(prompt.type)
      })

      autoSyncAllProgress.totalPrompts = filteredPrompts.length
      console.log(`[AutoSyncAll] Found ${filteredPrompts.length} prompts with defined types to process`)

      for (const prompt of filteredPrompts) {
        autoSyncAllProgress.currentPromptId = prompt.id
        autoSyncAllProgress.currentPromptHeading = prompt.promptHeading ?? 'Untitled'

        const {expectedOptions, unexpectedAnswers} = await getUnexpectedAnswersSummary({
          promptId: prompt.id,
          promptType: prompt.type,
          projectScope,
        })

        if (expectedOptions.length === 0) {
          autoSyncAllProgress.processedPrompts += 1
          continue
        }

        let promptDeleted = 0
        for (const unexpectedAnswer of unexpectedAnswers) {
          const result = await deleteUnexpectedJudgments(projectId, prompt.id, unexpectedAnswer.value)
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

export const adminInvestigateRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/admin/duckdb-append-metrics', async () => {
    return appDatabaseService.getAppendMetrics()
  })
  .get('/api/admin/list-prompts-with-types', async () => {
    const promptsList = await getTypedPrompts()
    const filtered = promptsList.filter((prompt) => {
      return !isOpenEndedType(prompt.type)
    })

    return {
      prompts: filtered.map((prompt) => {
        return {
          id: prompt.id,
          promptHeading: prompt.promptHeading || 'Untitled',
          type: prompt.type,
          originalText: prompt.originalText,
          createdAt: appQueryHelpers.getDateValue(prompt.createdAt),
          archived: prompt.archived,
        }
      }),
    }
  })
  .post(
    '/api/admin/delete-unexpected-answers',
    async ({body}) => {
      return deleteUnexpectedJudgments(body.projectId, body.promptId, body.unexpectedValue)
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
      return runAutoSyncAllAsync(body?.projectId ?? null)
    },
    {body: t.Optional(t.Object({projectId: t.Optional(t.Union([t.String(), t.Null()]))}))},
  )
  .get('/api/admin/auto-sync-all-progress', async () => {
    return getAutoSyncAllProgress()
  })
  .get(
    '/api/admin/investigate-unexpected-answers',
    async ({query}) => {
      const projectId = query.projectId
      const promptId = query.promptId

      console.log(
        `[Admin] Fetching prompts${projectId ? ` for project ${projectId}` : ''}${promptId ? ` for prompt ${promptId}` : ''}...`,
      )

      const projectName = projectId ? await getProjectName(projectId) : 'All Projects'
      if (projectId && !projectName) {
        throw new Error('Project not found')
      }

      const allPrompts = await getPromptSelection(projectId ?? null, promptId ?? null)
      console.log(`[Admin] Found ${allPrompts.length} prompts with defined types`)

      const projectScope = projectId ? await fetchProjectScope(projectId) : null
      if (projectId && !projectScope) {
        throw new Error('Project not found or has no configuration')
      }

      const results: Array<{
        promptId: string
        promptHeading: string
        expectedOptions: string[]
        unexpectedAnswers: Array<{value: string | null; count: number}>
        totalJudgments: number
        percentUnexpected: number
      }> = []

      for (const prompt of allPrompts) {
        if (isOpenEndedType(prompt.type)) {
          continue
        }

        const {expectedOptions, totalJudgments, unexpectedAnswers} = await getUnexpectedAnswersSummary({
          promptId: prompt.id,
          promptType: prompt.type,
          projectScope,
        })

        if (expectedOptions.length === 0 || unexpectedAnswers.length === 0) {
          continue
        }

        const unexpectedCount = unexpectedAnswers.reduce((sum, answer) => {
          return sum + answer.count
        }, 0)
        const percentUnexpected = totalJudgments > 0 ? (unexpectedCount / totalJudgments) * 100 : 0

        results.push({
          promptId: prompt.id,
          promptHeading: prompt.promptHeading || 'Untitled',
          expectedOptions,
          unexpectedAnswers,
          totalJudgments,
          percentUnexpected,
        })
      }

      console.log(`[Admin] Found ${results.length} prompts with unexpected answers`)

      return promptId
        ? {projectName, promptHeading: allPrompts[0]?.promptHeading || 'Untitled', result: results[0] ?? null}
        : {
            summary: {totalPromptsWithTypes: allPrompts.length, promptsWithUnexpectedAnswers: results.length},
            results: results.sort((left, right) => {
              return right.percentUnexpected - left.percentUnexpected
            }),
            projectName,
          }
    },
    {query: t.Object({projectId: t.Optional(t.String()), promptId: t.Optional(t.String())})},
  )
