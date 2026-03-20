import {Elysia, t} from 'elysia'

import {assertSelectableProviderModelId} from '../providers/providerModelRepository.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import * as appQueryHelpers from '../services/appQueryHelpers.ts'
import {getDuckdbMartRefreshService} from '../services/getDuckdbMartRefreshService.ts'
import {computePromptContentHash} from '../utils/computePromptContentHash.ts'
import {hasMatchingJudgmentAnswer} from '../utils/judgmentAnswers.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'

const appDatabaseService = getAppDatabaseService()

type ProjectWithPrompts = {
  id: string
  name: string
  description: string | null
  modelId: string
  modelName: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  prompts: Array<{id: string; promptHeading: string | null; originalText: string; type: string | null}>
}

type ProjectBound = {
  id: string
  dateFrom: Date | null
  dateTo: Date | null
  modelId: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}

type PromptFilter = {promptId: string; types: string[]}

type PromptRow = {
  id: string
  promptHeading: string | null
  originalText: string
  transformedText: string | null
  type: string | null
  contentHash: string | null
}

const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

const getProjectArticleWhereClause = (params: {
  projectId: string
  routeIds: string[]
  dateFrom: Date | null
  dateTo: Date | null
}) => {
  return appQueryHelpers.getAndClause([
    appQueryHelpers.getProjectScopeClause({
      articleAlias: 'a',
      importRouteIds: params.routeIds,
      projectId: params.projectId,
    }),
    params.dateFrom ? `a.article_created_at >= ${appQueryHelpers.getSqlLiteral(params.dateFrom)}` : null,
    params.dateTo ? `a.article_created_at <= ${appQueryHelpers.getSqlLiteral(params.dateTo)}` : null,
  ])
}

const queryArticlesWithPromptFilters = async (
  promptFilters: PromptFilter[],
  allSelectedPromptIds: string[],
  projectBounds: ProjectBound[],
  combinedWhereClause: string | null,
) => {
  const judgmentConfigCondition = appQueryHelpers.getJudgmentConfigClause({
    judgmentAlias: 'j',
    configs: projectBounds.map((project) => {
      return {
        modelId: project.modelId,
        useTitle: project.useTitle,
        useAbstract: project.useAbstract,
        useFulltext: project.useFulltext,
        useFulltextNoImages: project.useFulltextNoImages,
      }
    }),
  })
  const judgmentRows = await appDatabaseService.queryJson<{
    id: string
    promptId: string
    answeredOriginal: string | null
    answeredOriginalAsArray: unknown
  }>(`
    SELECT
      a.id AS id,
      j.prompt_id AS promptId,
      j.answered_original AS answeredOriginal,
      TO_JSON(j.answered_original_as_array) AS answeredOriginalAsArray
    FROM app.article a
    INNER JOIN app.judgment j ON ${appQueryHelpers.getAndClause([
      'j.article_id = a.id',
      `j.prompt_id IN (${appQueryHelpers.getQuotedStringList(allSelectedPromptIds).join(', ')})`,
      'j.deleted_at IS NULL',
      judgmentConfigCondition,
    ])}
    ${combinedWhereClause ? `WHERE ${combinedWhereClause}` : ''}
  `)
  const normalizedRows = judgmentRows.map((row) => {
    const parsedArray = appQueryHelpers.getJsonValue(row.answeredOriginalAsArray)

    return {
      ...row,
      answeredOriginalAsArray: Array.isArray(parsedArray)
        ? parsedArray.filter((value): value is string => {
            return typeof value === 'string'
          })
        : null,
    }
  })
  const rowsByArticleId = normalizedRows.reduce<Map<string, typeof normalizedRows>>((rowMap, row) => {
    const currentRows = rowMap.get(row.id) ?? []
    currentRows.push(row)
    rowMap.set(row.id, currentRows)
    return rowMap
  }, new Map<string, typeof normalizedRows>())

  return Array.from(rowsByArticleId.entries())
    .filter(([, rows]) => {
      return promptFilters.every((filter) => {
        return rows.some((row) => {
          return row.promptId === filter.promptId && hasMatchingJudgmentAnswer(row, filter.types)
        })
      })
    })
    .map(([articleId]) => {
      return {id: articleId}
    })
}

const queryAllArticlesInScope = async (combinedWhereClause: string | null) => {
  return appDatabaseService.queryJson<{id: string}>(`
    SELECT a.id AS id
    FROM app.article a
    ${combinedWhereClause ? `WHERE ${combinedWhereClause}` : ''}
  `)
}

export const subprojectsRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/subprojects/sources', async () => {
    const [projectsList, projectPromptsList] = await Promise.all([
      appDatabaseService.queryJson<{
        id: string
        name: string
        description: string | null
        modelId: string
        modelName: string | null
        useTitle: boolean | null
        useAbstract: boolean | null
        useFulltext: boolean | null
        useFulltextNoImages: boolean | null
      }>(`
        SELECT
          p.id AS id,
          p.name AS name,
          p.description AS description,
          p.model_id AS modelId,
          COALESCE(m.display_name, m.name, m.remote_model_id, m.model_name) AS modelName,
          p.use_title AS useTitle,
          p.use_abstract AS useAbstract,
          p.use_fulltext AS useFulltext,
          p.use_fulltext_no_images AS useFulltextNoImages
        FROM app.project p
        INNER JOIN app.model m ON p.model_id = m.id
        WHERE p.archived = FALSE
        ORDER BY p.name ASC
      `),
      appDatabaseService.queryJson<{
        projectId: string
        id: string
        promptHeading: string | null
        originalText: string
        type: string | null
      }>(`
        SELECT
          pp.project_id AS projectId,
          p.id AS id,
          p.prompt_heading AS promptHeading,
          p.original_text AS originalText,
          p.type AS type
        FROM app.project_prompt pp
        INNER JOIN app.prompt p ON pp.prompt_id = p.id
        WHERE pp.enabled = TRUE
        ORDER BY pp.prompt_order ASC NULLS LAST
      `),
    ])
    const promptsByProjectId = projectPromptsList.reduce<Map<string, typeof projectPromptsList>>((map, row) => {
      const currentRows = map.get(row.projectId) ?? []
      currentRows.push(row)
      map.set(row.projectId, currentRows)
      return map
    }, new Map<string, typeof projectPromptsList>())
    const projectsWithPrompts = projectsList.reduce<ProjectWithPrompts[]>((result, project) => {
      const projectPrompts = promptsByProjectId.get(project.id) ?? []

      return projectPrompts.length > 0
        ? [
            ...result,
            {
              id: project.id,
              name: project.name,
              description: project.description,
              modelId: project.modelId,
              modelName: project.modelName,
              useTitle: project.useTitle ?? true,
              useAbstract: project.useAbstract ?? true,
              useFulltext: project.useFulltext ?? false,
              useFulltextNoImages: project.useFulltextNoImages ?? false,
              prompts: projectPrompts.map((prompt) => {
                return {
                  id: prompt.id,
                  promptHeading: prompt.promptHeading,
                  originalText: prompt.originalText,
                  type: prompt.type,
                }
              }),
            },
          ]
        : result
    }, [])

    return {data: projectsWithPrompts}
  })
  .post(
    '/api/subprojects',
    async ({body}) => {
      await assertSelectableProviderModelId(appDatabaseService, {
        errorMessage: 'Selected model does not exist or is disabled',
        modelId: body.modelId,
      })

      const [newProject] = await appDatabaseService.queryJson<{
        id: string
        name: string
        description: string | null
        modelId: string
        useTitle: boolean
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        dateFrom: unknown
        dateTo: unknown
      }>(`
        INSERT INTO app.project (
          name,
          description,
          model_id,
          use_title,
          use_abstract,
          use_fulltext,
          date_from,
          date_to
        )
        VALUES (
          ${appQueryHelpers.getSqlLiteral(body.name)},
          ${appQueryHelpers.getSqlLiteral(body.description || null)},
          ${appQueryHelpers.getSqlLiteral(body.modelId)},
          TRUE,
          TRUE,
          FALSE,
          ${appQueryHelpers.getSqlLiteral(body.dateFrom ? new Date(body.dateFrom) : null)},
          ${appQueryHelpers.getSqlLiteral(body.dateTo ? new Date(body.dateTo) : null)}
        )
        RETURNING
          id,
          name,
          description,
          model_id AS modelId,
          use_title AS useTitle,
          use_abstract AS useAbstract,
          use_fulltext AS useFulltext,
          use_fulltext_no_images AS useFulltextNoImages,
          date_from AS dateFrom,
          date_to AS dateTo
      `)
      if (!newProject) {
        throw new Error('Failed to create project')
      }

      const promptIdSet = body.promptSelections.reduce((set, selection) => {
        set.add(selection.promptId)
        return set
      }, new Set<string>())
      const promptIds = Array.from(promptIdSet)

      if (promptIds.length > 0) {
        const promptDetails = await appDatabaseService.queryJson<PromptRow>(`
          SELECT
            id,
            prompt_heading AS promptHeading,
            original_text AS originalText,
            transformed_text AS transformedText,
            type,
            content_hash AS contentHash
          FROM app.prompt
          WHERE id IN (${appQueryHelpers.getQuotedStringList(promptIds).join(', ')})
        `)

        let orderIndex = 0
        for (const prompt of promptDetails) {
          const contentHash = computePromptContentHash(
            prompt.originalText,
            prompt.transformedText,
            prompt.promptHeading,
            prompt.type,
          )
          const [existingByHash] =
            contentHash !== prompt.contentHash
              ? await appDatabaseService.queryJson<{id: string}>(`
                  SELECT id
                  FROM app.prompt
                  WHERE content_hash = ${appQueryHelpers.getSqlLiteral(contentHash)}
                  LIMIT 1
                `)
              : []
          const targetPromptId = existingByHash?.id ?? prompt.id

          await appDatabaseService.run(`
            INSERT INTO app.project_prompt (
              project_id,
              prompt_id,
              prompt_order,
              archived,
              enabled,
              origin_project_id
            )
            VALUES (
              '${appQueryHelpers.escapeSqlString(newProject.id)}',
              '${appQueryHelpers.escapeSqlString(targetPromptId)}',
              ${orderIndex},
              FALSE,
              TRUE,
              '${appQueryHelpers.escapeSqlString(newProject.id)}'
            )
            ON CONFLICT DO NOTHING
          `)
          orderIndex += 1
        }
      }

      if (body.sourceProjectIds.length === 0) {
        console.log('[subprojects] No source projects selected, no articles added')
        await getDuckdbMartRefreshService().queueProjectRefresh(newProject.id, 'SubprojectsRoutes.post')
        return {
          data: {
            project: {
              ...newProject,
              dateFrom: appQueryHelpers.getDateValue(newProject.dateFrom),
              dateTo: appQueryHelpers.getDateValue(newProject.dateTo),
            },
            articleCount: 0,
          },
        }
      }

      const promptFilters = body.promptSelections.filter((selection) => {
        return selection.types.length > 0
      })
      const allSelectedPromptIds = promptFilters.map((filter) => {
        return filter.promptId
      })
      const [projectImportRoutes, projectBoundsRows] = await Promise.all([
        appDatabaseService.queryJson<{projectId: string; importRouteId: string}>(`
          SELECT
            project_id AS projectId,
            import_route_id AS importRouteId
          FROM app.project_import_route
          WHERE project_id IN (${appQueryHelpers.getQuotedStringList(body.sourceProjectIds).join(', ')})
        `),
        appDatabaseService.queryJson<{
          id: string
          dateFrom: unknown
          dateTo: unknown
          modelId: string | null
          useTitle: boolean | null
          useAbstract: boolean | null
          useFulltext: boolean | null
          useFulltextNoImages: boolean | null
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
          WHERE id IN (${appQueryHelpers.getQuotedStringList(body.sourceProjectIds).join(', ')})
        `),
      ])
      const projectBounds = projectBoundsRows.map<ProjectBound>((row) => {
        return {
          id: row.id,
          dateFrom: appQueryHelpers.getDateValue(row.dateFrom),
          dateTo: appQueryHelpers.getDateValue(row.dateTo),
          modelId: row.modelId,
          useTitle: row.useTitle ?? true,
          useAbstract: row.useAbstract ?? true,
          useFulltext: row.useFulltext ?? false,
          useFulltextNoImages: row.useFulltextNoImages ?? false,
        }
      })
      const importRouteIdsByProjectId = projectImportRoutes.reduce<Map<string, string[]>>((map, row) => {
        const currentIds = map.get(row.projectId) ?? []
        currentIds.push(row.importRouteId)
        map.set(row.projectId, currentIds)
        return map
      }, new Map<string, string[]>())
      const promptIdsForMapping = allSelectedPromptIds.length > 0 ? Array.from(new Set(allSelectedPromptIds)) : []
      const promptIdsByProjectId = new Map<string, Set<string>>()

      if (promptIdsForMapping.length > 0) {
        const projectPromptRows = await appDatabaseService.queryJson<{projectId: string; promptId: string}>(`
          SELECT
            project_id AS projectId,
            prompt_id AS promptId
          FROM app.project_prompt
          WHERE project_id IN (${appQueryHelpers.getQuotedStringList(body.sourceProjectIds).join(', ')})
            AND prompt_id IN (${appQueryHelpers.getQuotedStringList(promptIdsForMapping).join(', ')})
            AND enabled = TRUE
        `)

        for (const row of projectPromptRows) {
          const current = promptIdsByProjectId.get(row.projectId) ?? new Set<string>()
          current.add(row.promptId)
          promptIdsByProjectId.set(row.projectId, current)
        }
      }

      const userDateFrom = body.dateFrom ? new Date(`${body.dateFrom}T00:00:00.000Z`) : null
      const userDateTo = body.dateTo ? new Date(`${body.dateTo}T23:59:59.999Z`) : null
      const uniqueArticleIds = new Set<string>()
      const projectQueryConcurrency = 3

      for (const boundsChunk of chunk(projectBounds, projectQueryConcurrency)) {
        const chunkResults = await Promise.all(
          boundsChunk.map(async (sourceProject) => {
            const projectPromptIdSet = promptIdsByProjectId.get(sourceProject.id) ?? new Set<string>()
            const applicablePromptFilters = promptFilters.filter((filter) => {
              return projectPromptIdSet.has(filter.promptId)
            })
            const applicablePromptIds = applicablePromptFilters.map((filter) => {
              return filter.promptId
            })
            const projectWhereClause = appQueryHelpers.getAndClause([
              getProjectArticleWhereClause({
                projectId: sourceProject.id,
                routeIds: importRouteIdsByProjectId.get(sourceProject.id) ?? [],
                dateFrom: sourceProject.dateFrom,
                dateTo: sourceProject.dateTo,
              }),
              userDateFrom ? `a.article_created_at >= ${appQueryHelpers.getSqlLiteral(userDateFrom)}` : null,
              userDateTo ? `a.article_created_at <= ${appQueryHelpers.getSqlLiteral(userDateTo)}` : null,
            ])

            return applicablePromptFilters.length > 0
              ? queryArticlesWithPromptFilters(
                  applicablePromptFilters,
                  applicablePromptIds,
                  [sourceProject],
                  projectWhereClause,
                ).then((rows) => {
                  return rows.map((row) => {
                    return row.id
                  })
                })
              : queryAllArticlesInScope(projectWhereClause).then((rows) => {
                  return rows.map((row) => {
                    return row.id
                  })
                })
          }),
        )

        for (const ids of chunkResults) {
          for (const id of ids) {
            uniqueArticleIds.add(id)
          }
        }
      }

      const articleIds = Array.from(uniqueArticleIds)
      console.log(
        `[subprojects] Found ${articleIds.length} articles matching criteria across ${projectBounds.length} projects`,
      )

      const batchSize = 5000
      let insertedCount = 0
      await appDatabaseService.transaction(async (tx) => {
        for (const idsChunk of chunk(articleIds, batchSize)) {
          if (idsChunk.length === 0) {
            continue
          }

          await tx.run(`
            INSERT INTO app.project_article (project_id, article_id, imported_from_project_id)
            VALUES ${idsChunk
              .map((articleId) => {
                return `('${appQueryHelpers.escapeSqlString(newProject.id)}', '${appQueryHelpers.escapeSqlString(articleId)}', NULL)`
              })
              .join(', ')}
            ON CONFLICT DO NOTHING
          `)
          insertedCount += idsChunk.length
        }
      })

      console.log(`[subprojects] Inserted ${insertedCount} articles into project ${newProject.id}`)

      await getDuckdbMartRefreshService().queueProjectRefresh(newProject.id, 'SubprojectsRoutes.post')

      return {
        data: {
          project: {
            ...newProject,
            dateFrom: appQueryHelpers.getDateValue(newProject.dateFrom),
            dateTo: appQueryHelpers.getDateValue(newProject.dateTo),
          },
          articleCount: articleIds.length,
        },
      }
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.String()),
        modelId: t.String(),
        dateFrom: t.Optional(t.String()),
        dateTo: t.Optional(t.String()),
        promptSelections: t.Array(t.Object({promptId: t.String(), types: t.Array(t.String())})),
        sourceProjectIds: t.Array(t.String()),
      }),
    },
  )
