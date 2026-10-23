import {getSystemPromptVariant} from '../../../agent/judge/systemPromptVariant.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getDateValue} from '../../services/appQueryHelpers.ts'
import {getProjectModelLabel} from './getProjectModelLabel.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'
import {
  getProjectFullTextSelectSql,
  getProjectFullTextValues,
  type ProjectFullTextRow,
} from './projectFullTextSettings.ts'
import type {projectsRoutesGetProjectQuery} from './projectsRoutesGetProjectQuery.ts'

export const projectsRoutesGetProject = async ({
  params,
  query,
}: {
  params: {id: string}
  query: typeof projectsRoutesGetProjectQuery.static
}) => {
  await assertProjectIsActive(params.id)
  const includeImportablePrompts = query.includeImportablePrompts === 'true'

  const [project] = await getAppDatabaseService()
    .queryJson<
      {
        id: string
        name: string
        description: string | null
        modelId: string
        useTitle: boolean
        useAbstract: boolean
        useFulltext: boolean
        useFulltextNoImages: boolean
        useMetadata: boolean
        humanJudgmentMode: 'prompt' | 'summary' | null
        systemPromptVariant: string | null
        dateFrom: unknown
        dateTo: unknown
        archived: boolean
        createdAt: unknown
        updatedAt: unknown
      } & ProjectFullTextRow
    >(
      `
      SELECT
        id,
        name,
        description,
        model_id AS modelId,
        use_title AS useTitle,
        use_abstract AS useAbstract,
        use_fulltext AS useFulltext,
        use_fulltext_no_images AS useFulltextNoImages,
        COALESCE(use_metadata, FALSE) AS useMetadata,
        human_judgment_mode AS humanJudgmentMode,
        system_prompt_variant AS systemPromptVariant,
        ${getProjectFullTextSelectSql('app.project')},
        date_from AS dateFrom,
        date_to AS dateTo,
        archived,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM app.project
      WHERE id = '${escapeSqlString(params.id)}'
        AND delete_pending_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM app.archived_project_delete_tombstone tombstone
          WHERE tombstone.project_id = app.project.id
            AND tombstone.completed_at IS NULL
        )
      LIMIT 1
    `,
    )
    .then((rows) => {
      return rows.map((row) => {
        return {
          ...getProjectFullTextValues(row),
          systemPromptVariant: getSystemPromptVariant(row.systemPromptVariant),
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

  type ProjectPromptRouteRow = {
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
    linkedToProject: boolean
    contentHash: string | null
    createdAt: unknown
  }

  const importablePromptsPromise = includeImportablePrompts
    ? getAppDatabaseService().queryJson<ProjectPromptRouteRow>(`
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
          FALSE AS linkedToProject,
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
      `)
    : Promise.resolve<ProjectPromptRouteRow[]>([])

  const [projectPromptsList, importablePrompts, existingJob, projectModelRows, linkedImportRoutes] = await Promise.all([
    getAppDatabaseService().queryJson<ProjectPromptRouteRow>(`
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
          TRUE AS linkedToProject,
          p.content_hash AS contentHash,
          p.created_at AS createdAt
        FROM app.project_prompt pp
        INNER JOIN app.prompt p ON pp.prompt_id = p.id
        WHERE pp.project_id = '${escapeSqlString(params.id)}'
        ORDER BY pp.prompt_order ASC NULLS LAST
      `),
    importablePromptsPromise,
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
      modelMetadataJson: unknown
      baseURL: string | null
      version: string | null
    }>(`
        SELECT
          m.id AS id,
          COALESCE(m.display_name, m.name, m.remote_model_id) AS name,
          pc.provider_kind AS provider,
          m.remote_model_id AS modelName,
          TO_JSON(m.metadata_json) AS modelMetadataJson,
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
  const [projectModelRow] = projectModelRows
  const projectModel = projectModelRow
    ? {
        ...(({modelMetadataJson: _modelMetadataJson, ...modelRow}) => {
          return modelRow
        })(projectModelRow),
        name: getProjectModelLabel({
          metadataJson: projectModelRow.modelMetadataJson,
          modelName: projectModelRow.name,
          provider: projectModelRow.provider,
          version: projectModelRow.version,
        }),
      }
    : undefined

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
}
