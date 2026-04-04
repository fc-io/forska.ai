import {Elysia, t} from 'elysia'

import {assertSelectableProviderModelId} from '../providers/providerModelRepository.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {
  escapeSqlString,
  getDateValue,
  getQuotedStringList,
  getSqlLiteral,
  getTimestampLiteral,
} from '../services/appQueryHelpers.ts'
import {getDuckdbMartRefreshService} from '../services/getDuckdbMartRefreshService.ts'
import {getProjectMartLargeRebuildStateService} from '../services/projectMartLargeRebuildStateService.ts'
import {getProjectMartRefreshStateService} from '../services/projectMartRefreshStateService.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'
import {assertProjectIsActive, getProjectAccess} from './projectsRoutes/projectAccessGuard.ts'
import {projectsRoutesGetArticlesReviews} from './projectsRoutes/projectsRoutesGetArticlesReviews.ts'
import {projectsRoutesGetArticlesReviewsBoth} from './projectsRoutes/projectsRoutesGetArticlesReviewsBoth.ts'
import {projectsRoutesGetArticlesReviewsCount} from './projectsRoutes/projectsRoutesGetArticlesReviewsCount.ts'
import {projectsRoutesGetArticlesReviewsFilters} from './projectsRoutes/projectsRoutesGetArticlesReviewsFilters.ts'
import {projectsRoutesGetArticlesReviewsHuman} from './projectsRoutes/projectsRoutesGetArticlesReviewsHuman.ts'
import {projectsRoutesGetArticlesReviewsHumanFilters} from './projectsRoutes/projectsRoutesGetArticlesReviewsHumanFilters.ts'
import {projectsRoutesGetArticlesReviewsUnassessed} from './projectsRoutes/projectsRoutesGetArticlesReviewsUnassessed.ts'
import {projectsRoutesGetReviewsWarnings} from './projectsRoutes/projectsRoutesGetReviewsWarnings.ts'
import {projectsRoutesPostArticleReviewDetails} from './projectsRoutes/projectsRoutesPostArticleReviewDetails.ts'
import {projectsRoutesPostDeleteArchived} from './projectsRoutes/projectsRoutesPostDeleteArchived.ts'

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

type AppQueryRunner = {queryJson: <T>(statement: string) => Promise<T[]>}
type AppTx = AppQueryRunner & {run: (statement: string) => Promise<void>}

type ProjectReferenceDetachSpec = {sourceTable: string; tempTable: string; whereClause: string}
type ProjectReferenceDetachPlan = {
  deleteSpecs: ProjectReferenceDetachSpec[]
  restoreSpecs: ProjectReferenceDetachSpec[]
}

type ProjectRow = {
  id: string
  name: string
  description: string | null
  engine: string | null
  modelId: string
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  dateFrom: unknown
  dateTo: unknown
  archived: boolean
  createdAt: unknown
  updatedAt: unknown
}

const getProjectValue = (row: ProjectRow) => {
  return {
    ...row,
    dateFrom: getDateValue(row.dateFrom),
    dateTo: getDateValue(row.dateTo),
    createdAt: getDateValue(row.createdAt),
    updatedAt: getDateValue(row.updatedAt),
  }
}

const getProjectRowSql = (projectId: string) => {
  return `
    SELECT
      id,
      name,
      description,
      engine,
      model_id AS modelId,
      use_title AS useTitle,
      use_abstract AS useAbstract,
      use_fulltext AS useFulltext,
      use_fulltext_no_images AS useFulltextNoImages,
      date_from AS dateFrom,
      date_to AS dateTo,
      archived,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM app.project
    WHERE id = '${escapeSqlString(projectId)}'
    LIMIT 1
  `
}

const getProjectRow = async (db: AppQueryRunner, projectId: string) => {
  const [project] = await db.queryJson<ProjectRow>(getProjectRowSql(projectId))
  return project ?? null
}

const updateProjectTx = async (tx: AppTx, params: {projectId: string; updateParts: string[]}) => {
  await tx.run(`
    UPDATE app.project
    SET ${params.updateParts.join(', ')}
    WHERE id = '${escapeSqlString(params.projectId)}'
  `)

  return getProjectRow(tx, params.projectId)
}

const runTxStatements = async (tx: AppTx, statements: string[]) => {
  return statements.reduce<Promise<void>>((promise, statement) => {
    return promise.then(() => {
      return tx.run(statement)
    })
  }, Promise.resolve())
}

const runAppStatements = async (statements: string[]) => {
  return statements.length === 0 ? undefined : getAppDatabaseService().run(statements.join(';\n'))
}

const getProjectReferenceDetachPlan = (projectId: string): ProjectReferenceDetachPlan => {
  const projectLiteral = getSqlLiteral(projectId)
  const suffix = crypto.randomUUID().replaceAll('-', '_')
  const getTempTable = (tableName: string) => {
    return `temp_project_update_${tableName}_${suffix}`
  }

  const projectPromptSpec = {
    sourceTable: 'app.project_prompt',
    tempTable: getTempTable('project_prompt'),
    whereClause: `project_id = ${projectLiteral} OR origin_project_id = ${projectLiteral}`,
  }
  const projectImportRouteSpec = {
    sourceTable: 'app.project_import_route',
    tempTable: getTempTable('project_import_route'),
    whereClause: `project_id = ${projectLiteral}`,
  }
  const projectArticleSpec = {
    sourceTable: 'app.project_article',
    tempTable: getTempTable('project_article'),
    whereClause: `project_id = ${projectLiteral} OR imported_from_project_id = ${projectLiteral}`,
  }
  const judgmentSpec = {
    sourceTable: 'app.judgment',
    tempTable: getTempTable('judgment'),
    whereClause: `project_id = ${projectLiteral}`,
  }
  const judgmentAssessmentSpec = {
    sourceTable: 'app.judgment_assessment',
    tempTable: getTempTable('judgment_assessment'),
    whereClause: `judgment_id IN (SELECT id FROM app.judgment WHERE project_id = ${projectLiteral})`,
  }
  const judgmentHumanSpec = {
    sourceTable: 'app.judgment_human',
    tempTable: getTempTable('judgment_human'),
    whereClause: `project_id = ${projectLiteral}`,
  }
  const projectMartRefreshStateSpec = {
    sourceTable: 'app.project_mart_refresh_state',
    tempTable: getTempTable('project_mart_refresh_state'),
    whereClause: `project_id = ${projectLiteral}`,
  }
  const projectMartRefreshArticleStateSpec = {
    sourceTable: 'app.project_mart_refresh_article_state',
    tempTable: getTempTable('project_mart_refresh_article_state'),
    whereClause: `project_id = ${projectLiteral}`,
  }
  const reviewSpec = {
    sourceTable: 'app.review',
    tempTable: getTempTable('review'),
    whereClause: `project_id = ${projectLiteral}`,
  }

  return {
    deleteSpecs: [
      projectPromptSpec,
      projectImportRouteSpec,
      projectArticleSpec,
      judgmentAssessmentSpec,
      judgmentSpec,
      judgmentHumanSpec,
      projectMartRefreshArticleStateSpec,
      projectMartRefreshStateSpec,
      reviewSpec,
    ],
    restoreSpecs: [
      projectPromptSpec,
      projectImportRouteSpec,
      projectArticleSpec,
      judgmentSpec,
      judgmentAssessmentSpec,
      judgmentHumanSpec,
      projectMartRefreshStateSpec,
      projectMartRefreshArticleStateSpec,
      reviewSpec,
    ],
  }
}

const getCreateDetachBackupStatement = (spec: ProjectReferenceDetachSpec) => {
  return `
    CREATE TEMP TABLE ${spec.tempTable} AS
    SELECT *
    FROM ${spec.sourceTable}
    WHERE ${spec.whereClause}
  `
}

const getDeleteDetachedReferencesStatement = (spec: ProjectReferenceDetachSpec) => {
  return `
    DELETE FROM ${spec.sourceTable}
    WHERE ${spec.whereClause}
  `
}

const getRestoreDetachedReferencesStatement = (spec: ProjectReferenceDetachSpec) => {
  return `
    INSERT INTO ${spec.sourceTable}
    SELECT *
    FROM ${spec.tempTable}
  `
}

const getDropDetachBackupStatement = (spec: ProjectReferenceDetachSpec) => {
  return `DROP TABLE ${spec.tempTable}`
}

const detachProjectReferencesForModelUpdate = async (projectId: string) => {
  const detachPlan = getProjectReferenceDetachPlan(projectId)

  await runAppStatements(
    detachPlan.restoreSpecs.map((spec) => {
      return getCreateDetachBackupStatement(spec)
    }),
  )
  await runAppStatements(
    detachPlan.deleteSpecs.map((spec) => {
      return getDeleteDetachedReferencesStatement(spec)
    }),
  )

  return detachPlan
}

const restoreDetachedProjectReferences = async (detachPlan: ProjectReferenceDetachPlan) => {
  return runAppStatements([
    ...detachPlan.restoreSpecs.map((spec) => {
      return getRestoreDetachedReferencesStatement(spec)
    }),
    ...detachPlan.restoreSpecs.map((spec) => {
      return getDropDetachBackupStatement(spec)
    }),
  ])
}

const runWithDetachedProjectReferenceRecovery = async <T>(
  operation: () => Promise<T>,
  detachPlan: ProjectReferenceDetachPlan,
): Promise<T> => {
  try {
    return await operation()
  } catch (error) {
    await restoreDetachedProjectReferences(detachPlan)
    throw error
  }
}

const createDetachedPromptTx = async (
  tx: AppTx,
  params: {
    originalText: string
    transformedText: string | null
    promptHeading: string | null
    type: string | null
    archived: boolean
  },
) => {
  const [insertedPrompt] = await tx.queryJson<{id: string}>(`
    INSERT INTO app.prompt (id, original_text, transformed_text, prompt_heading, type, content_hash, archived)
    VALUES (
      '${escapeSqlString(crypto.randomUUID())}',
      ${getSqlLiteral(params.originalText)},
      ${getSqlLiteral(params.transformedText)},
      ${getSqlLiteral(params.promptHeading)},
      ${getSqlLiteral(params.type)},
      NULL,
      ${params.archived ? 'TRUE' : 'FALSE'}
    )
    RETURNING id
  `)

  return insertedPrompt?.id ?? null
}

const upsertProjectPromptTx = async (
  tx: AppTx,
  params: {
    projectId: string
    promptId: string
    order: number
    archived: boolean
    enabled: boolean
    originProjectId: string | null
  },
) => {
  await tx.run(`
    INSERT INTO app.project_prompt (id, project_id, prompt_id, prompt_order, archived, enabled, origin_project_id)
    VALUES (
      '${escapeSqlString(crypto.randomUUID())}',
      '${escapeSqlString(params.projectId)}',
      '${escapeSqlString(params.promptId)}',
      ${params.order},
      ${params.archived ? 'TRUE' : 'FALSE'},
      ${params.enabled ? 'TRUE' : 'FALSE'},
      ${getSqlLiteral(params.originProjectId)}
    )
    ON CONFLICT(project_id, prompt_id) DO UPDATE SET
      prompt_order = EXCLUDED.prompt_order,
      archived = EXCLUDED.archived,
      enabled = EXCLUDED.enabled,
      updated_at = now()
  `)
}

export const projectsRoutes = new Elysia()
  .use(withErrorHandler())
  .use(projectsRoutesGetArticlesReviews)
  .use(projectsRoutesGetArticlesReviewsCount)
  .use(projectsRoutesGetArticlesReviewsBoth)
  .use(projectsRoutesGetArticlesReviewsHuman)
  .use(projectsRoutesGetArticlesReviewsUnassessed)
  .use(projectsRoutesGetArticlesReviewsFilters)
  .use(projectsRoutesGetArticlesReviewsHumanFilters)
  .use(projectsRoutesPostArticleReviewDetails)
  .use(projectsRoutesPostDeleteArchived)
  .use(projectsRoutesGetReviewsWarnings)
  .use(
    new Elysia().get('/api/projects-without-jobs', async () => {
      const rows = await getAppDatabaseService().queryJson<{id: string; name: string; description: string | null}>(`
        SELECT p.id AS id, p.name AS name, p.description AS description
        FROM app.project p
        LEFT JOIN app.judgment_job jj ON jj.project_id = p.id
        WHERE jj.id IS NULL
        ORDER BY p.created_at DESC
      `)

      return {data: rows}
    }),
  )
  .get('/api/projects', async () => {
    const projectsWithModelName = await getAppDatabaseService()
      .queryJson<{
        id: string
        name: string
        description: string | null
        engine: string | null
        modelId: string
        useTitle: boolean
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        dateFrom: unknown
        dateTo: unknown
        archived: boolean
        createdAt: unknown
        updatedAt: unknown
        modelName: string | null
      }>(
        `
      SELECT
        p.id AS id,
        p.name AS name,
        p.description AS description,
        p.engine AS engine,
        p.model_id AS modelId,
        p.use_title AS useTitle,
        p.use_abstract AS useAbstract,
        p.use_fulltext AS useFulltext,
        p.use_fulltext_no_images AS useFulltextNoImages,
        p.date_from AS dateFrom,
        p.date_to AS dateTo,
        p.archived AS archived,
        p.created_at AS createdAt,
        p.updated_at AS updatedAt,
        COALESCE(m.display_name, m.name, m.remote_model_id) AS modelName
      FROM app.project p
      LEFT JOIN app.model m ON p.model_id = m.id
      WHERE p.archived = FALSE
      ORDER BY p.name ASC
    `,
      )
      .then((rows) => {
        return rows.map((row) => {
          return {
            ...row,
            dateFrom: getDateValue(row.dateFrom),
            dateTo: getDateValue(row.dateTo),
            createdAt: getDateValue(row.createdAt),
            updatedAt: getDateValue(row.updatedAt),
          }
        })
      })

    return {data: projectsWithModelName}
  })
  .get('/api/projects/archived', async () => {
    const projectsWithModelName = await getAppDatabaseService()
      .queryJson<{
        id: string
        name: string
        description: string | null
        engine: string | null
        modelId: string
        useTitle: boolean
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        dateFrom: unknown
        dateTo: unknown
        archived: boolean
        createdAt: unknown
        updatedAt: unknown
        modelName: string | null
      }>(
        `
      SELECT
        p.id AS id,
        p.name AS name,
        p.description AS description,
        p.engine AS engine,
        p.model_id AS modelId,
        p.use_title AS useTitle,
        p.use_abstract AS useAbstract,
        p.use_fulltext AS useFulltext,
        p.use_fulltext_no_images AS useFulltextNoImages,
        p.date_from AS dateFrom,
        p.date_to AS dateTo,
        p.archived AS archived,
        p.created_at AS createdAt,
        p.updated_at AS updatedAt,
        COALESCE(m.display_name, m.name, m.remote_model_id) AS modelName
      FROM app.project p
      LEFT JOIN app.model m ON p.model_id = m.id
      WHERE p.archived = TRUE
      ORDER BY p.created_at DESC
    `,
      )
      .then((rows) => {
        return rows.map((row) => {
          return {
            ...row,
            dateFrom: getDateValue(row.dateFrom),
            dateTo: getDateValue(row.dateTo),
            createdAt: getDateValue(row.createdAt),
            updatedAt: getDateValue(row.updatedAt),
          }
        })
      })

    return {data: projectsWithModelName}
  })
  .get('/api/projects/:id/access', async ({params}) => {
    const project = await getProjectAccess(params.id)

    if (!project) {
      throw new Error('Project not found')
    }

    return {data: project}
  })
  .get('/api/projects/:id', async ({params}) => {
    await assertProjectIsActive(params.id)

    const [project] = await getAppDatabaseService()
      .queryJson<{
        id: string
        name: string
        description: string | null
        engine: string | null
        modelId: string
        useTitle: boolean
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        dateFrom: unknown
        dateTo: unknown
        archived: boolean
        createdAt: unknown
        updatedAt: unknown
      }>(
        `
      SELECT
        id,
        name,
        description,
        engine,
        model_id AS modelId,
        use_title AS useTitle,
        use_abstract AS useAbstract,
        use_fulltext AS useFulltext,
        use_fulltext_no_images AS useFulltextNoImages,
        date_from AS dateFrom,
        date_to AS dateTo,
        archived,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM app.project
      WHERE id = '${escapeSqlString(params.id)}'
      LIMIT 1
    `,
      )
      .then((rows) => {
        return rows.map((row) => {
          return {
            ...row,
            dateFrom: getDateValue(row.dateFrom),
            dateTo: getDateValue(row.dateTo),
            createdAt: getDateValue(row.createdAt),
            updatedAt: getDateValue(row.updatedAt),
          }
        })
      })

    if (!project) {
      throw new Error('Project not found')
    }

    const [projectPromptsList, importablePrompts, existingJob, projectModelRows, linkedImportRoutes] =
      await Promise.all([
        getAppDatabaseService().queryJson<{
          id: string
          originalText: string
          transformedText: string | null
          promptHeading: string | null
          order: number | null
          archived: boolean
          promptArchived: boolean
          type: string | null
          enabled: boolean
          originProjectId: string | null
          contentHash: string | null
          createdAt: unknown
        }>(`
        SELECT
          p.id AS id,
          p.original_text AS originalText,
          p.transformed_text AS transformedText,
          p.prompt_heading AS promptHeading,
          pp.prompt_order AS "order",
          pp.archived AS archived,
          p.archived AS promptArchived,
          p.type AS type,
          pp.enabled AS enabled,
          pp.origin_project_id AS originProjectId,
          p.content_hash AS contentHash,
          p.created_at AS createdAt
        FROM app.project_prompt pp
        INNER JOIN app.prompt p ON pp.prompt_id = p.id
        WHERE pp.project_id = '${escapeSqlString(params.id)}'
        ORDER BY pp.prompt_order ASC NULLS LAST
      `),
        getAppDatabaseService().queryJson<{
          id: string
          originalText: string
          transformedText: string | null
          promptHeading: string | null
          order: number | null
          archived: boolean
          promptArchived: boolean
          type: string | null
          enabled: boolean
          originProjectId: string | null
          contentHash: string | null
          createdAt: unknown
        }>(`
        SELECT
          p.id AS id,
          p.original_text AS originalText,
          p.transformed_text AS transformedText,
          p.prompt_heading AS promptHeading,
          NULL AS "order",
          FALSE AS archived,
          p.archived AS promptArchived,
          p.type AS type,
          FALSE AS enabled,
          NULL AS originProjectId,
          p.content_hash AS contentHash,
          p.created_at AS createdAt
        FROM app.prompt p
        LEFT JOIN app.project_prompt pp ON pp.project_id = '${escapeSqlString(params.id)}' AND pp.prompt_id = p.id
        WHERE pp.id IS NULL
          AND p.archived = FALSE
          AND NOT EXISTS (
            SELECT 1
            FROM app.project_prompt linked_pp
            INNER JOIN app.prompt linked_prompt ON linked_prompt.id = linked_pp.prompt_id
            WHERE linked_pp.project_id = '${escapeSqlString(params.id)}'
              AND linked_prompt.original_text = p.original_text
              AND COALESCE(linked_prompt.transformed_text, '') = COALESCE(p.transformed_text, '')
              AND COALESCE(linked_prompt.prompt_heading, '') = COALESCE(p.prompt_heading, '')
              AND COALESCE(linked_prompt.type, '') = COALESCE(p.type, '')
          )
      `),
        getAppDatabaseService().queryJson<{id: string}>(`
        SELECT id
        FROM app.judgment_job
        WHERE project_id = '${escapeSqlString(params.id)}'
        LIMIT 1
      `),
        getAppDatabaseService().queryJson<{
          id: string
          name: string
          provider: string | null
          modelName: string | null
          baseURL: string | null
          version: string | null
        }>(`
        SELECT
          m.id AS id,
          COALESCE(m.display_name, m.name, m.remote_model_id) AS name,
          pc.provider_kind AS provider,
          m.remote_model_id AS modelName,
          pc.base_url AS baseURL,
          m.variant AS version
        FROM app.model m
        LEFT JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
        WHERE m.id = '${escapeSqlString(project.modelId)}'
        LIMIT 1
      `),
        getAppDatabaseService().queryJson<{route: string; name: string | null}>(`
        SELECT ir.route AS route, ir.name AS name
        FROM app.project_import_route pir
        INNER JOIN app.import_route ir ON pir.import_route_id = ir.id
        WHERE pir.project_id = '${escapeSqlString(params.id)}'
      `),
      ])

    const promptsCombined = [...projectPromptsList, ...importablePrompts].map((row) => {
      return {...row, createdAt: getDateValue(row.createdAt)}
    })

    const hasJudgedArticles = existingJob.length > 0
    const [projectModel] = projectModelRows

    const importRoutes = linkedImportRoutes.map((r) => {
      return r.route
    })

    const importRouteNamesByRoute = linkedImportRoutes.reduce<Record<string, string | null>>((acc, row) => {
      acc[row.route] = row.name ?? null
      return acc
    }, {})

    return {
      data: {
        project,
        prompts: promptsCombined,
        hasJudgedArticles,
        model: projectModel ?? null,
        importRoutes,
        importRouteNamesByRoute,
      },
    }
  })
  .post(
    '/api/projects',
    async ({body}) => {
      const dateFrom = parseOptionalDate(body.dateFrom)
      const dateTo = parseOptionalDate(body.dateTo)
      if (dateFrom && dateTo && dateFrom > dateTo) {
        throw new Error('date_from must be on or before date_to')
      }

      await assertSelectableProviderModelId(getAppDatabaseService(), {
        errorMessage: 'Selected model does not exist or is disabled',
        modelId: body.modelId,
      })

      // Validate mutual exclusivity of useFulltext and useFulltextNoImages
      if (body.useFulltext && body.useFulltextNoImages) {
        throw new Error('Cannot enable both "Use Full Text" and "Use Full Text (No Images)" at the same time')
      }

      const newProject = (await getAppDatabaseService().transaction(async (tx) => {
        const newProjectId = crypto.randomUUID()
        const [createdProject] = await tx.queryJson<{
          id: string
          name: string
          description: string | null
          engine: string | null
          modelId: string
          useTitle: boolean
          useAbstract: boolean
          useFulltext: boolean
          useFulltextNoImages: boolean
          dateFrom: unknown
          dateTo: unknown
          archived: boolean
          createdAt: unknown
          updatedAt: unknown
        }>(`
          INSERT INTO app.project (
            id,
            name,
            description,
            model_id,
            use_title,
            use_abstract,
            use_fulltext,
            use_fulltext_no_images,
            date_from,
            date_to
          )
          VALUES (
            '${escapeSqlString(newProjectId)}',
            ${getSqlLiteral(body.name)},
            ${getSqlLiteral(body.description || null)},
            '${escapeSqlString(body.modelId)}',
            ${(body.useTitle ?? true) ? 'TRUE' : 'FALSE'},
            ${(body.useAbstract ?? true) ? 'TRUE' : 'FALSE'},
            ${(body.useFulltext ?? false) ? 'TRUE' : 'FALSE'},
            ${(body.useFulltextNoImages ?? false) ? 'TRUE' : 'FALSE'},
            ${dateFrom ? getTimestampLiteral(dateFrom) : 'NULL'},
            ${dateTo ? getTimestampLiteral(dateTo) : 'NULL'}
          )
          RETURNING
            id,
            name,
            description,
            engine,
            model_id AS modelId,
            use_title AS useTitle,
            use_abstract AS useAbstract,
            use_fulltext AS useFulltext,
            use_fulltext_no_images AS useFulltextNoImages,
            date_from AS dateFrom,
            date_to AS dateTo,
            archived,
            created_at AS createdAt,
            updated_at AS updatedAt
        `)

        if (!createdProject) {
          throw new Error('Failed to create project')
        }

        if (body.prompts && body.prompts.length > 0) {
          const submittedPrompts = (
            body.prompts as Array<string | {content: string; promptHeading?: string; type?: string; order: number}>
          ).filter((prompt) => {
            return typeof prompt === 'string' ? prompt.trim() !== '' : (prompt.content ?? '').trim() !== ''
          })

          for (let index = 0; index < submittedPrompts.length; index++) {
            const prompt = submittedPrompts[index] as
              | string
              | {content: string; promptHeading?: string; type?: string; order: number}
            const content = typeof prompt === 'string' ? prompt : prompt.content
            const heading = typeof prompt === 'object' ? prompt.promptHeading || null : null
            const typeVal = typeof prompt === 'object' ? prompt.type || null : null
            const orderVal = typeof prompt === 'object' && prompt.order !== undefined ? prompt.order : index
            const promptId = await createDetachedPromptTx(tx, {
              originalText: content,
              transformedText: null,
              promptHeading: heading,
              type: typeVal,
              archived: false,
            })

            if (!promptId) {
              throw new Error('Prompt not found after insert')
            }

            await upsertProjectPromptTx(tx, {
              projectId: createdProject.id,
              promptId,
              order: orderVal,
              archived: false,
              enabled: true,
              originProjectId: createdProject.id,
            })
          }
        }

        if (body.existingPromptIds && body.existingPromptIds.length > 0) {
          for (const existing of body.existingPromptIds) {
            const [existingPrompt] = await tx.queryJson<{id: string}>(`
              SELECT id
              FROM app.prompt
              WHERE id = '${escapeSqlString(existing.originalId)}'
              LIMIT 1
            `)

            if (!existingPrompt) {
              throw new Error(`Existing prompt not found: ${existing.originalId}`)
            }

            await upsertProjectPromptTx(tx, {
              projectId: createdProject.id,
              promptId: existing.originalId,
              order: existing.order,
              archived: false,
              enabled: true,
              originProjectId: null,
            })
          }
        }

        const selectedRoutes = Array.from(
          new Set(
            (body.importRoutes ?? []).filter((route) => {
              return typeof route === 'string' && route.trim() !== ''
            }),
          ),
        )

        if (selectedRoutes.length > 0) {
          const routeRows = await tx.queryJson<{id: string; route: string}>(`
            SELECT id, route
            FROM app.import_route
            WHERE route IN (${getQuotedStringList(selectedRoutes).join(', ')})
          `)

          if (routeRows.length !== selectedRoutes.length) {
            throw new Error('One or more selected import routes are invalid')
          }

          await tx.run(`
            INSERT INTO app.project_import_route (id, project_id, import_route_id)
            VALUES ${routeRows
              .map((row) => {
                return `(${getQuotedStringList([crypto.randomUUID(), createdProject.id, row.id]).join(', ')})`
              })
              .join(', ')}
            ON CONFLICT(project_id, import_route_id) DO NOTHING
          `)
        }

        const dirtyProjects = await getProjectMartRefreshStateService().getDirtyProjectsForProjectIds(tx, [
          createdProject.id,
        ])

        await getProjectMartRefreshStateService().markProjectsDirtyAtomically({
          projects: dirtyProjects,
          reason: 'ProjectsRoutes.post',
          runner: tx,
        })

        return getProjectValue(createdProject)
      })) as ReturnType<typeof getProjectValue>

      return {data: newProject}
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.String()),
        modelId: t.String(),
        dateFrom: t.Optional(t.String()),
        dateTo: t.Optional(t.String()),
        useTitle: t.Optional(t.Boolean()),
        useAbstract: t.Optional(t.Boolean()),
        useFulltext: t.Optional(t.Boolean()),
        useFulltextNoImages: t.Optional(t.Boolean()),
        importRoutes: t.Optional(t.Array(t.String())),
        prompts: t.Optional(
          t.Union([
            t.Array(t.String()),
            t.Array(
              t.Object({
                content: t.String(),
                promptHeading: t.Optional(t.String()),
                type: t.Optional(t.String()),
                order: t.Number(),
              }),
            ),
          ]),
        ),
        existingPromptIds: t.Optional(t.Array(t.Object({originalId: t.String(), order: t.Number()}))),
      }),
    },
  )
  .patch(
    '/api/projects/:id',
    async ({params, body}) => {
      await assertProjectIsActive(params.id)

      const [job] = await getAppDatabaseService().queryJson<{id: string}>(`
        SELECT id
        FROM app.judgment_job
        WHERE project_id = '${escapeSqlString(params.id)}'
        LIMIT 1
      `)
      if (job?.id) {
        throw new Error('Project is locked: a judgment job exists for this project')
      }

      const updateParts = [
        `updated_at = current_timestamp`,
        body.name !== undefined ? `name = ${getSqlLiteral(body.name)}` : null,
        body.description !== undefined ? `description = ${getSqlLiteral(body.description)}` : null,
      ].filter((part): part is string => {
        return part !== null
      })

      const updatedProject = (await getAppDatabaseService().transaction(async (tx) => {
        return updateProjectTx(tx, {projectId: params.id, updateParts})
      })) as ProjectRow | null

      if (!updatedProject) {
        throw new Error('Project not found')
      }

      return {data: getProjectValue(updatedProject)}
    },
    {body: t.Object({name: t.Optional(t.String()), description: t.Optional(t.Union([t.String(), t.Null()]))})},
  )
  .patch(
    '/api/projects/:id/edit',
    async ({params, body}) => {
      await assertProjectIsActive(params.id)

      const [job] = await getAppDatabaseService().queryJson<{id: string}>(`
        SELECT id
        FROM app.judgment_job
        WHERE project_id = '${escapeSqlString(params.id)}'
        LIMIT 1
      `)
      if (job?.id) {
        throw new Error('Project is locked: a judgment job exists for this project')
      }

      const parsedDateFrom = body.dateFrom === undefined ? undefined : parseOptionalDate(body.dateFrom)
      const parsedDateTo = body.dateTo === undefined ? undefined : parseOptionalDate(body.dateTo)
      if (parsedDateFrom && parsedDateTo && parsedDateFrom > parsedDateTo) {
        throw new Error('date_from must be on or before date_to')
      }

      const [currentProject] = await getAppDatabaseService().queryJson<{
        id: string
        modelId: string
        useTitle: boolean
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
      }>(`
        SELECT
          id,
          model_id AS modelId,
          use_title AS useTitle,
          use_abstract AS useAbstract,
          use_fulltext AS useFulltext,
          use_fulltext_no_images AS useFulltextNoImages
        FROM app.project
        WHERE id = '${escapeSqlString(params.id)}'
        LIMIT 1
      `)

      if (!currentProject) {
        throw new Error('Project not found')
      }

      const hasModelIdUpdate = body.modelId !== undefined && body.modelId !== currentProject.modelId
      const detachPlan = hasModelIdUpdate ? await detachProjectReferencesForModelUpdate(params.id) : null

      const runEditTransaction = () => {
        return getAppDatabaseService().transaction(async (tx) => {
          if (body.modelId !== undefined) {
            await assertSelectableProviderModelId(tx, {
              errorMessage: 'Selected model does not exist or is disabled',
              modelId: body.modelId,
            })
          }

          const finalUseFulltext = body.useFulltext ?? currentProject.useFulltext
          const finalUseFulltextNoImages = body.useFulltextNoImages ?? currentProject.useFulltextNoImages
          if (finalUseFulltext && finalUseFulltextNoImages) {
            throw new Error('Cannot enable both "Use Full Text" and "Use Full Text (No Images)" at the same time')
          }

          const updateParts = [
            `updated_at = current_timestamp`,
            body.name !== undefined ? `name = ${getSqlLiteral(body.name)}` : null,
            body.description !== undefined ? `description = ${getSqlLiteral(body.description)}` : null,
            parsedDateFrom !== undefined ? `date_from = ${getSqlLiteral(parsedDateFrom)}` : null,
            parsedDateTo !== undefined ? `date_to = ${getSqlLiteral(parsedDateTo)}` : null,
            hasModelIdUpdate ? `model_id = ${getSqlLiteral(body.modelId)}` : null,
            body.useTitle !== undefined ? `use_title = ${body.useTitle ? 'TRUE' : 'FALSE'}` : null,
            body.useAbstract !== undefined ? `use_abstract = ${body.useAbstract ? 'TRUE' : 'FALSE'}` : null,
            body.useFulltext !== undefined ? `use_fulltext = ${body.useFulltext ? 'TRUE' : 'FALSE'}` : null,
            body.useFulltextNoImages !== undefined
              ? `use_fulltext_no_images = ${body.useFulltextNoImages ? 'TRUE' : 'FALSE'}`
              : null,
          ].filter((part): part is string => {
            return part !== null
          })

          const updatedProject = await updateProjectTx(tx, {projectId: params.id, updateParts})

          if (detachPlan) {
            await runTxStatements(
              tx,
              detachPlan.restoreSpecs.map((spec) => {
                return getRestoreDetachedReferencesStatement(spec)
              }),
            )
          }

          if (!updatedProject) {
            throw new Error('Project not found')
          }

          if (body.prompts !== undefined) {
            const submitted = body.prompts.filter((prompt) => {
              return (prompt.originalText ?? '').trim() !== ''
            })
            const existing = await tx.queryJson<{
              id: string
              promptId: string
              originProjectId: string | null
              archived: boolean
              enabled: boolean
            }>(`
            SELECT
              id,
              prompt_id AS promptId,
              origin_project_id AS originProjectId,
              archived,
              enabled
            FROM app.project_prompt
            WHERE project_id = '${escapeSqlString(params.id)}'
          `)

            const existingPromptIds = new Set(
              existing.map((prompt) => {
                return prompt.promptId
              }),
            )
            const receivedOriginalIds = new Set(
              submitted
                .map((prompt) => {
                  return prompt.originalId
                })
                .filter((id): id is string => {
                  return typeof id === 'string'
                }),
            )
            const toDeleteAssoc = existing.filter((entry) => {
              return !receivedOriginalIds.has(entry.promptId)
            })

            if (toDeleteAssoc.length > 0) {
              await tx.run(`
              DELETE FROM app.project_prompt
              WHERE project_id = '${escapeSqlString(params.id)}'
                AND prompt_id IN (${getQuotedStringList(
                  toDeleteAssoc.map((entry) => {
                    return entry.promptId
                  }),
                ).join(', ')})
            `)
            }

            for (const prompt of submitted) {
              const order = prompt.order
              const archived = typeof prompt.archived === 'boolean' ? prompt.archived : undefined
              const enabled = typeof prompt.enabled === 'boolean' ? prompt.enabled : undefined

              if (prompt.originalId) {
                const isAlreadyAssociated = existingPromptIds.has(prompt.originalId)
                if (!isAlreadyAssociated && enabled !== true) {
                  continue
                }

                const [existingPrompt] = await tx.queryJson<{
                  id: string
                  originalText: string
                  promptHeading: string | null
                  type: string | null
                  promptArchived: boolean
                }>(`
                SELECT
                  id,
                  original_text AS originalText,
                  prompt_heading AS promptHeading,
                  type,
                  archived AS promptArchived
                FROM app.prompt
                WHERE id = '${escapeSqlString(prompt.originalId)}'
                LIMIT 1
              `)

                if (!existingPrompt) {
                  throw new Error('Prompt not found')
                }

                const textChanged = existingPrompt.originalText !== prompt.originalText
                const metaChanged =
                  (prompt.promptHeading !== undefined
                    && prompt.promptHeading !== (existingPrompt.promptHeading ?? null))
                  || (prompt.type !== undefined && prompt.type !== (existingPrompt.type ?? null))

                const targetPromptId =
                  textChanged || metaChanged
                    ? await createDetachedPromptTx(tx, {
                        originalText: prompt.originalText,
                        transformedText: null,
                        promptHeading: prompt.promptHeading || null,
                        type: prompt.type || null,
                        archived: existingPrompt.promptArchived,
                      })
                    : prompt.originalId

                if (!targetPromptId) {
                  throw new Error('Prompt not found after insert')
                }

                if (textChanged || metaChanged) {
                  await tx.run(`
                  DELETE FROM app.project_prompt
                  WHERE project_id = '${escapeSqlString(params.id)}'
                    AND prompt_id = '${escapeSqlString(prompt.originalId)}'
                `)
                }

                const currentAssociation = existing.find((entry) => {
                  return entry.promptId === prompt.originalId
                })
                const [originProjectRow] =
                  currentAssociation?.originProjectId !== undefined
                    ? [null]
                    : await tx.queryJson<{originProjectId: string | null}>(`
                    SELECT origin_project_id AS originProjectId
                    FROM app.project_prompt
                    WHERE prompt_id = '${escapeSqlString(prompt.originalId)}'
                    LIMIT 1
                  `)

                await upsertProjectPromptTx(tx, {
                  projectId: params.id,
                  promptId: targetPromptId,
                  order,
                  archived: archived ?? currentAssociation?.archived ?? false,
                  enabled: enabled ?? currentAssociation?.enabled ?? true,
                  originProjectId:
                    textChanged || metaChanged
                      ? params.id
                      : (currentAssociation?.originProjectId ?? originProjectRow?.originProjectId ?? params.id),
                })
              } else {
                const targetPromptId = await createDetachedPromptTx(tx, {
                  originalText: prompt.originalText,
                  transformedText: null,
                  promptHeading: prompt.promptHeading || null,
                  type: prompt.type || null,
                  archived: false,
                })

                if (!targetPromptId) {
                  throw new Error('Prompt not found after insert')
                }

                await upsertProjectPromptTx(tx, {
                  projectId: params.id,
                  promptId: targetPromptId,
                  order,
                  archived: archived ?? false,
                  enabled: enabled ?? true,
                  originProjectId: params.id,
                })
              }
            }
          }

          if (body.importRoutes !== undefined) {
            const selectedRoutes = Array.from(
              new Set(
                body.importRoutes.filter((route) => {
                  return typeof route === 'string' && route.trim() !== ''
                }),
              ),
            )

            await tx.run(`
            DELETE FROM app.project_import_route
            WHERE project_id = '${escapeSqlString(params.id)}'
          `)

            if (selectedRoutes.length > 0) {
              const routeRows = await tx.queryJson<{id: string; route: string}>(`
              SELECT id, route
              FROM app.import_route
              WHERE route IN (${getQuotedStringList(selectedRoutes).join(', ')})
            `)

              if (routeRows.length !== selectedRoutes.length) {
                throw new Error('One or more selected import routes are invalid')
              }

              await tx.run(`
              INSERT INTO app.project_import_route (id, project_id, import_route_id)
              VALUES ${routeRows
                .map((route) => {
                  return `(${getQuotedStringList([crypto.randomUUID(), params.id, route.id]).join(', ')})`
                })
                .join(', ')}
              ON CONFLICT(project_id, import_route_id) DO NOTHING
            `)
            }
          }

          const updatedPrompts = await tx.queryJson<{
            id: string
            originalText: string
            transformedText: string | null
            promptHeading: string | null
            order: number | null
            archived: boolean
            promptArchived: boolean
            type: string | null
            enabled: boolean
            originProjectId: string | null
          }>(`
          SELECT
            p.id AS id,
            p.original_text AS originalText,
            p.transformed_text AS transformedText,
            p.prompt_heading AS promptHeading,
            pp.prompt_order AS "order",
            pp.archived AS archived,
            p.archived AS promptArchived,
            p.type AS type,
            pp.enabled AS enabled,
            pp.origin_project_id AS originProjectId
          FROM app.project_prompt pp
          INNER JOIN app.prompt p ON pp.prompt_id = p.id
          WHERE pp.project_id = '${escapeSqlString(params.id)}'
          ORDER BY pp.prompt_order ASC NULLS LAST
        `)

          if (detachPlan) {
            await runTxStatements(
              tx,
              detachPlan.restoreSpecs.map((spec) => {
                return getDropDetachBackupStatement(spec)
              }),
            )
          }

          const dirtyProjects = await getProjectMartRefreshStateService().getDirtyProjectsForProjectIds(tx, [params.id])

          await getProjectMartRefreshStateService().markProjectsDirtyAtomically({
            projects: dirtyProjects,
            reason: 'ProjectsRoutes.edit',
            runner: tx,
          })

          return {project: getProjectValue(updatedProject), prompts: updatedPrompts}
        })
      }

      const result = detachPlan
        ? await runWithDetachedProjectReferenceRecovery(runEditTransaction, detachPlan)
        : await runEditTransaction()

      return {data: result}
    },
    {
      body: t.Object({
        name: t.Optional(t.String()),
        description: t.Optional(t.Union([t.String(), t.Null()])),
        dateFrom: t.Optional(t.Union([t.String(), t.Null()])),
        dateTo: t.Optional(t.Union([t.String(), t.Null()])),
        modelId: t.Optional(t.String()),
        useTitle: t.Optional(t.Boolean()),
        useAbstract: t.Optional(t.Boolean()),
        useFulltext: t.Optional(t.Boolean()),
        useFulltextNoImages: t.Optional(t.Boolean()),
        importRoutes: t.Optional(t.Array(t.String())),
        prompts: t.Optional(
          t.Array(
            t.Object({
              originalId: t.Optional(t.String()),
              originalText: t.String(),
              promptHeading: t.Optional(t.String()),
              type: t.Optional(t.String()),
              order: t.Number(),
              archived: t.Optional(t.Boolean()),
              enabled: t.Optional(t.Boolean()),
            }),
          ),
        ),
      }),
    },
  )
  .delete('/api/projects/:id', async ({params}) => {
    await assertProjectIsActive(params.id)

    const archivedProject = await getAppDatabaseService().transaction(async (tx) => {
      const updatedProject = await updateProjectTx(tx, {
        projectId: params.id,
        updateParts: ['archived = TRUE', 'updated_at = current_timestamp'],
      })

      if (updatedProject) {
        await tx.run(`
          UPDATE app.judgment_job
          SET status = CASE
                WHEN status IN ('completed', 'failed', 'project_removed') THEN status
                ELSE 'project_removed'
              END,
              storage_state = CASE
                WHEN storage_state IN ('drained', 'quarantined') THEN storage_state
                ELSE 'draining'
              END,
              pause_requested_at = current_timestamp,
              updated_at = current_timestamp
          WHERE project_id = '${escapeSqlString(params.id)}'
        `)
        await getProjectMartRefreshStateService().clearProjectRefreshState({projectId: params.id, runner: tx})
        await getProjectMartLargeRebuildStateService().clearLargeRebuildState({projectId: params.id, runner: tx})
      }

      return updatedProject
    })

    if (!archivedProject) {
      throw new Error('Project not found')
    }

    await getDuckdbMartRefreshService().queueProjectRefresh(params.id, 'ProjectsRoutes.archive')

    return {success: true}
  })
  .post('/api/projects/:id/unarchive', async ({params}) => {
    const unarchivedProject = await getAppDatabaseService().transaction(async (tx) => {
      const updatedProject = await updateProjectTx(tx, {
        projectId: params.id,
        updateParts: ['archived = FALSE', 'updated_at = current_timestamp'],
      })

      if (updatedProject) {
        await getProjectMartRefreshStateService().markProjectsDirtyAtomically({
          projects: [{projectId: params.id}],
          reason: 'ProjectsRoutes.unarchive',
          runner: tx,
        })
      }

      return updatedProject
    })

    if (!unarchivedProject) {
      throw new Error('Project not found')
    }

    await getDuckdbMartRefreshService().queueProjectRefresh(params.id, 'ProjectsRoutes.unarchive')

    return {success: true}
  })
  .post('/api/projects/:id/clone', async ({params}) => {
    await assertProjectIsActive(params.id)

    const [sourceProject] = await getAppDatabaseService()
      .queryJson<{
        id: string
        name: string
        description: string | null
        engine: string | null
        modelId: string
        useTitle: boolean
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        dateFrom: unknown
        dateTo: unknown
      }>(
        `
      SELECT
        id,
        name,
        description,
        engine,
        model_id AS modelId,
        use_title AS useTitle,
        use_abstract AS useAbstract,
        use_fulltext AS useFulltext,
        use_fulltext_no_images AS useFulltextNoImages,
        date_from AS dateFrom,
        date_to AS dateTo
      FROM app.project
      WHERE id = '${escapeSqlString(params.id)}'
      LIMIT 1
    `,
      )
      .then((rows) => {
        return rows.map((row) => {
          return {...row, dateFrom: getDateValue(row.dateFrom), dateTo: getDateValue(row.dateTo)}
        })
      })

    if (!sourceProject) {
      throw new Error('Project not found')
    }

    await assertSelectableProviderModelId(getAppDatabaseService(), {
      errorMessage: 'Source project model does not exist or is disabled',
      modelId: sourceProject.modelId,
    })

    const result = (await getAppDatabaseService().transaction(async (tx) => {
      const clonedProjectId = crypto.randomUUID()
      const [clonedProject] = await tx.queryJson<{
        id: string
        name: string
        description: string | null
        engine: string | null
        modelId: string
        useTitle: boolean
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        dateFrom: unknown
        dateTo: unknown
        archived: boolean
        createdAt: unknown
        updatedAt: unknown
      }>(`
        INSERT INTO app.project (
          id,
          name,
          description,
          engine,
          model_id,
          use_title,
          use_abstract,
          use_fulltext,
          use_fulltext_no_images,
          date_from,
          date_to,
          archived
        )
        VALUES (
          '${escapeSqlString(clonedProjectId)}',
          ${getSqlLiteral(`${sourceProject.name} - Copy`)},
          ${getSqlLiteral(sourceProject.description)},
          ${getSqlLiteral(sourceProject.engine)},
          '${escapeSqlString(sourceProject.modelId)}',
          ${sourceProject.useTitle ? 'TRUE' : 'FALSE'},
          ${sourceProject.useAbstract ? 'TRUE' : 'FALSE'},
          ${sourceProject.useFulltext ? 'TRUE' : 'FALSE'},
          ${sourceProject.useFulltextNoImages ? 'TRUE' : 'FALSE'},
          ${sourceProject.dateFrom ? getTimestampLiteral(sourceProject.dateFrom) : 'NULL'},
          ${sourceProject.dateTo ? getTimestampLiteral(sourceProject.dateTo) : 'NULL'},
          FALSE
        )
        RETURNING
          id,
          name,
          description,
          engine,
          model_id AS modelId,
          use_title AS useTitle,
          use_abstract AS useAbstract,
          use_fulltext AS useFulltext,
          use_fulltext_no_images AS useFulltextNoImages,
          date_from AS dateFrom,
          date_to AS dateTo,
          archived,
          created_at AS createdAt,
          updated_at AS updatedAt
      `)

      if (!clonedProject) {
        throw new Error('Failed to create cloned project')
      }

      const [sourcePrompts, sourceRouteLinks, sourceArticles] = await Promise.all([
        tx.queryJson<{
          order: number | null
          archived: boolean
          enabled: boolean
          originalText: string
          transformedText: string | null
          promptHeading: string | null
          type: string | null
          promptArchived: boolean
        }>(`
          SELECT
            pp.prompt_order AS "order",
            pp.archived AS archived,
            pp.enabled AS enabled,
            p.original_text AS originalText,
            p.transformed_text AS transformedText,
            p.prompt_heading AS promptHeading,
            p.type AS type,
            p.archived AS promptArchived
          FROM app.project_prompt pp
          INNER JOIN app.prompt p ON p.id = pp.prompt_id
          WHERE pp.project_id = '${escapeSqlString(params.id)}'
          ORDER BY pp.prompt_order ASC NULLS LAST
        `),
        tx.queryJson<{importRouteId: string}>(`
          SELECT import_route_id AS importRouteId
          FROM app.project_import_route
          WHERE project_id = '${escapeSqlString(params.id)}'
        `),
        tx.queryJson<{articleId: string}>(`
          SELECT article_id AS articleId
          FROM app.project_article
          WHERE project_id = '${escapeSqlString(params.id)}'
        `),
      ])

      if (sourcePrompts.length > 0) {
        for (const prompt of sourcePrompts) {
          const detachedPromptId = await createDetachedPromptTx(tx, {
            originalText: prompt.originalText,
            transformedText: prompt.transformedText,
            promptHeading: prompt.promptHeading,
            type: prompt.type,
            archived: prompt.promptArchived,
          })

          if (!detachedPromptId) {
            throw new Error('Failed to create detached cloned prompt')
          }

          await upsertProjectPromptTx(tx, {
            projectId: clonedProject.id,
            promptId: detachedPromptId,
            order: prompt.order ?? 0,
            archived: prompt.archived,
            enabled: prompt.enabled,
            originProjectId: clonedProject.id,
          })
        }
      }

      if (sourceRouteLinks.length > 0) {
        await tx.run(`
          INSERT INTO app.project_import_route (id, project_id, import_route_id)
          VALUES ${sourceRouteLinks
            .map((link) => {
              return `(${getQuotedStringList([crypto.randomUUID(), clonedProject.id, link.importRouteId]).join(', ')})`
            })
            .join(', ')}
        `)
      }

      if (sourceArticles.length > 0) {
        await tx.run(`
          INSERT INTO app.project_article (id, project_id, article_id, imported_from_project_id)
          VALUES ${sourceArticles
            .map((article) => {
              return `(${getQuotedStringList([crypto.randomUUID(), clonedProject.id, article.articleId, params.id]).join(', ')})`
            })
            .join(', ')}
        `)
      }

      const dirtyProjects = await getProjectMartRefreshStateService().getDirtyProjectsForProjectIds(tx, [
        clonedProject.id,
      ])

      await getProjectMartRefreshStateService().markProjectsDirtyAtomically({
        projects: dirtyProjects,
        reason: 'ProjectsRoutes.clone',
        runner: tx,
      })

      return getProjectValue(clonedProject)
    })) as ReturnType<typeof getProjectValue>

    return {data: result}
  })
