import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString} from '../../services/appQueryHelpers.ts'
import {HttpError} from '../../utils/httpError.ts'
import {getProjectRow} from './getProjectRow.ts'
import {getProjectValue} from './getProjectValue.ts'
import {parseOptionalDate} from './parseOptionalDate.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'
import {
  getProjectFullTextSelectSql,
  getProjectFullTextValues,
  hasProjectFullTextSettingsChanged,
  resolveProjectFullTextSettingsOrThrow,
} from './projectFullTextSettings.ts'
import {canEditPromptsWithJudgmentJob} from './projectsRoutesPatchEdit/canEditPromptsWithJudgmentJob.ts'
import {getChangedProtectedProjectEditFields} from './projectsRoutesPatchEdit/getChangedProtectedProjectEditFields.ts'
import {getChangedReviewConfigFields} from './projectsRoutesPatchEdit/getChangedReviewConfigFields.ts'
import {getCurrentProjectImportRoutes} from './projectsRoutesPatchEdit/getCurrentProjectImportRoutes.ts'
import {getExistingProjectPromptComparisonRows} from './projectsRoutesPatchEdit/getExistingProjectPromptComparisonRows.ts'
import {getFullTextReviewConfigFields} from './projectsRoutesPatchEdit/getFullTextReviewConfigFields.ts'
import {getHasProjectPromptEditChanges} from './projectsRoutesPatchEdit/getHasProjectPromptEditChanges.ts'
import {getProjectEditResponsePrompts} from './projectsRoutesPatchEdit/getProjectEditResponsePrompts.ts'
import {getProjectUsesFullText} from './projectsRoutesPatchEdit/getProjectUsesFullText.ts'
import {getRecordedProjectFullTextResolution} from './projectsRoutesPatchEdit/getRecordedProjectFullTextResolution.ts'
import {hasSameStringSet} from './projectsRoutesPatchEdit/hasSameStringSet.ts'
import {hasSystemPromptVariantEditChanged} from './projectsRoutesPatchEdit/hasSystemPromptVariantEditChanged.ts'
import type {
  ProjectEditCurrentProject,
  ProjectEditJudgmentJob,
  ProjectEditPromptPayload,
} from './projectsRoutesPatchEdit/projectEditTypes.ts'
import {runProjectEditTransaction} from './projectsRoutesPatchEdit/runProjectEditTransaction.ts'
import type {projectsRoutesPatchEditBody} from './projectsRoutesPatchEditBody.ts'

export const projectsRoutesPatchEdit = async ({
  params,
  body,
}: {
  params: {id: string}
  body: typeof projectsRoutesPatchEditBody.static
}) => {
  await assertProjectIsActive(params.id)

  const [job] = await getAppDatabaseService().queryJson<ProjectEditJudgmentJob>(`
        SELECT
          id,
          status,
          storage_state AS storageState,
          last_import_started_at AS lastImportStartedAt,
          last_import_completed_at AS lastImportCompletedAt
        FROM app.judgment_job
        WHERE project_id = '${escapeSqlString(params.id)}'
        LIMIT 1
      `)
  const hasExistingJob = Boolean(job)

  const parsedDateFrom = body.dateFrom === undefined ? undefined : parseOptionalDate(body.dateFrom)
  const parsedDateTo = body.dateTo === undefined ? undefined : parseOptionalDate(body.dateTo)
  if (parsedDateFrom && parsedDateTo && parsedDateFrom > parsedDateTo) {
    throw new HttpError(400, 'date_from must be on or before date_to')
  }

  const [currentProject] = await getAppDatabaseService().queryJson<ProjectEditCurrentProject>(`
        SELECT
          id,
          name,
          description,
          model_id AS modelId,
          human_judgment_mode AS humanJudgmentMode,
          system_prompt_variant AS systemPromptVariant,
          use_title AS useTitle,
          use_abstract AS useAbstract,
          use_fulltext AS useFulltext,
          use_fulltext_no_images AS useFulltextNoImages,
          COALESCE(use_metadata, FALSE) AS useMetadata,
          ${getProjectFullTextSelectSql('app.project')},
          date_from AS dateFrom,
          date_to AS dateTo
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
      `)

  if (!currentProject) {
    throw new Error('Project not found')
  }

  const [currentImportRoutes, existingPromptComparisonRows] = await Promise.all([
    body.importRoutes !== undefined ? getCurrentProjectImportRoutes(params.id) : Promise.resolve([]),
    body.prompts !== undefined ? getExistingProjectPromptComparisonRows(params.id) : Promise.resolve([]),
  ])
  const changedProtectedFields = hasExistingJob
    ? getChangedProtectedProjectEditFields({body, currentImportRoutes, currentProject, parsedDateFrom, parsedDateTo})
    : []

  if (changedProtectedFields.length > 0) {
    throw new HttpError(
      409,
      `Protected project fields cannot be changed after a judgment job exists: ${changedProtectedFields.join(', ')}`,
    )
  }

  const currentFullTextSettings = getProjectFullTextValues(currentProject)
  const nextUseFulltext = body.useFulltext ?? getProjectUsesFullText(currentProject)
  const hasFullTextSelection =
    body.useFulltext !== undefined || body.fullTextFigureMode !== undefined || body.fullTextChunkPolicy !== undefined
  const hasModelIdUpdate = body.modelId !== undefined && body.modelId !== currentProject.modelId
  const nextModelId = body.modelId ?? currentProject.modelId
  const fullTextResolution =
    (hasFullTextSelection || hasModelIdUpdate) && !hasExistingJob
      ? await resolveProjectFullTextSettingsOrThrow(
          {
            fullTextChunkPolicy:
              body.fullTextChunkPolicy === undefined
                ? currentFullTextSettings.fullTextChunkPolicy
                : body.fullTextChunkPolicy,
            fullTextFigureMode:
              body.fullTextFigureMode === undefined
                ? currentFullTextSettings.fullTextFigureMode
                : body.fullTextFigureMode,
            useFulltext: nextUseFulltext,
          },
          nextModelId,
        )
      : body.recordCurrentFullTextStrategy === true && job
        ? await getRecordedProjectFullTextResolution({
            currentFullTextSettings,
            job,
            modelId: nextModelId,
            useFulltext: nextUseFulltext,
          })
        : null
  const hasFullTextUpdate =
    fullTextResolution !== null
    && (hasProjectFullTextSettingsChanged(currentFullTextSettings, fullTextResolution)
      || nextUseFulltext !== currentProject.useFulltext)

  const hasPromptChanges = getHasProjectPromptEditChanges({
    existingPrompts: existingPromptComparisonRows,
    submittedPrompts: body.prompts as ProjectEditPromptPayload[] | undefined,
  })

  if (job && hasPromptChanges && !(await canEditPromptsWithJudgmentJob(getAppDatabaseService(), job))) {
    throw new HttpError(409, 'Pause or drain the judgment job before editing prompts.')
  }

  const hasImportRouteChanges =
    body.importRoutes !== undefined && !hasSameStringSet(body.importRoutes, currentImportRoutes)
  const changedReviewConfigFields = Array.from(
    new Set([
      ...getChangedReviewConfigFields({
        body,
        currentProject,
        hasImportRouteChanges,
        hasModelIdUpdate,
        hasPromptChanges,
        parsedDateFrom,
        parsedDateTo,
      }),
      ...getFullTextReviewConfigFields({currentProject, fullTextResolution, useFulltext: nextUseFulltext}),
    ]),
  )
  const hasFullTextStrategyChange = changedReviewConfigFields.includes('fullTextStrategyId')
  const hasNameUpdate = body.name !== undefined && body.name !== currentProject.name
  const hasDescriptionUpdate = body.description !== undefined && body.description !== currentProject.description
  const hasSystemPromptVariantUpdate = hasSystemPromptVariantEditChanged(body.systemPromptVariant, currentProject)
  const hasEditChanges =
    hasNameUpdate
    || hasDescriptionUpdate
    || hasSystemPromptVariantUpdate
    || hasFullTextUpdate
    || changedReviewConfigFields.length > 0

  if (!hasEditChanges) {
    const [project, prompts] = await Promise.all([
      getProjectRow(getAppDatabaseService(), params.id),
      getProjectEditResponsePrompts(getAppDatabaseService(), params.id),
    ])

    if (!project) {
      throw new Error('Project not found')
    }

    return {data: {project: getProjectValue(project), prompts}}
  }

  const runEditTransaction = () => {
    return runProjectEditTransaction({
      body,
      changedReviewConfigFields,
      fullTextResolution,
      hasDescriptionUpdate,
      hasExistingJob,
      hasFullTextStrategyChange,
      hasFullTextUpdate,
      hasImportRouteChanges,
      hasModelIdUpdate,
      hasNameUpdate,
      hasPromptChanges,
      hasSystemPromptVariantUpdate,
      nextUseFulltext,
      params,
      parsedDateFrom,
      parsedDateTo,
    })
  }

  const result = await runEditTransaction()

  return {data: result}
}
