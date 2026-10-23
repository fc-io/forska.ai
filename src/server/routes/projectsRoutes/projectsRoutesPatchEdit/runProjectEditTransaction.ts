import type {ProjectReviewConfigReviewServingField} from '../../../reviewServing/reviewConfigReviewServingDeltaService.ts'
import {getAppDatabaseService} from '../../../services/appDatabaseService.ts'
import {escapeSqlString, getQuotedStringList, getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {getComparisonProjectServingInvalidationService} from '../../../services/comparisonProjectServingInvalidationService.ts'
import {HttpError} from '../../../utils/httpError.ts'
import {appendProjectReviewConfigDeltaIfNeeded} from '../appendProjectReviewConfigDeltaIfNeeded.ts'
import {assertSelectableProjectModelId} from '../assertSelectableProjectModelId.ts'
import {getProjectValue} from '../getProjectValue.ts'
import {getReviewServingSourceTimestamp} from '../getReviewServingSourceTimestamp.ts'
import {
  getProjectFullTextUpdateParts,
  type ProjectFullTextResolution,
  saveProjectFullTextStrategy,
} from '../projectFullTextSettings.ts'
import type {projectsRoutesPatchEditBody} from '../projectsRoutesPatchEditBody.ts'
import {updateProjectTx} from '../updateProjectTx.ts'
import {applyProjectPromptEditsTx} from './applyProjectPromptEditsTx.ts'
import {getProjectEditResponsePrompts} from './getProjectEditResponsePrompts.ts'
import {markComparisonServingStaleForProjectPromptEditTx} from './markComparisonServingStaleForProjectPromptEditTx.ts'
import type {ProjectPromptCleanupSummary} from './projectEditTypes.ts'

type RunProjectEditTransactionInput = {
  body: typeof projectsRoutesPatchEditBody.static
  changedReviewConfigFields: ProjectReviewConfigReviewServingField[]
  fullTextResolution: ProjectFullTextResolution | null
  hasDescriptionUpdate: boolean
  hasExistingJob: boolean
  hasFullTextStrategyChange: boolean
  hasFullTextUpdate: boolean
  hasImportRouteChanges: boolean
  hasModelIdUpdate: boolean
  hasNameUpdate: boolean
  hasPromptChanges: boolean
  hasSystemPromptVariantUpdate: boolean
  nextUseFulltext: boolean
  params: {id: string}
  parsedDateFrom: Date | null | undefined
  parsedDateTo: Date | null | undefined
}

export const runProjectEditTransaction = ({
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
}: RunProjectEditTransactionInput) => {
  return getAppDatabaseService().transaction(async (tx) => {
    let promptCleanupSummary: ProjectPromptCleanupSummary | undefined

    if (hasModelIdUpdate) {
      await assertSelectableProjectModelId(tx, body.modelId as string)
    }

    if (hasFullTextUpdate && fullTextResolution) {
      await saveProjectFullTextStrategy(tx, fullTextResolution)
    }

    const updateParts = [
      `updated_at = current_timestamp`,
      hasNameUpdate ? `name = ${getSqlLiteral(body.name)}` : null,
      hasDescriptionUpdate ? `description = ${getSqlLiteral(body.description)}` : null,
      !hasExistingJob && changedReviewConfigFields.includes('dateFrom')
        ? `date_from = ${getSqlLiteral(parsedDateFrom)}`
        : null,
      !hasExistingJob && changedReviewConfigFields.includes('dateTo')
        ? `date_to = ${getSqlLiteral(parsedDateTo)}`
        : null,
      !hasExistingJob && hasModelIdUpdate ? `model_id = ${getSqlLiteral(body.modelId)}` : null,
      !hasExistingJob && hasSystemPromptVariantUpdate
        ? `system_prompt_variant = ${getSqlLiteral(body.systemPromptVariant)}`
        : null,
      !hasExistingJob && changedReviewConfigFields.includes('humanJudgmentMode')
        ? `human_judgment_mode = ${getSqlLiteral(body.humanJudgmentMode)}`
        : null,
      !hasExistingJob && changedReviewConfigFields.includes('useTitle')
        ? `use_title = ${body.useTitle ? 'TRUE' : 'FALSE'}`
        : null,
      !hasExistingJob && changedReviewConfigFields.includes('useAbstract')
        ? `use_abstract = ${body.useAbstract ? 'TRUE' : 'FALSE'}`
        : null,
      !hasExistingJob && changedReviewConfigFields.includes('useFulltext')
        ? `use_fulltext = ${nextUseFulltext ? 'TRUE' : 'FALSE'}`
        : null,
      !hasExistingJob && changedReviewConfigFields.includes('useFulltextNoImages')
        ? 'use_fulltext_no_images = FALSE'
        : null,
      ...(hasFullTextUpdate && fullTextResolution ? getProjectFullTextUpdateParts(fullTextResolution) : []),
      !hasExistingJob && changedReviewConfigFields.includes('useMetadata')
        ? `use_metadata = ${body.useMetadata ? 'TRUE' : 'FALSE'}`
        : null,
    ].filter((part): part is string => {
      return part !== null
    })

    const updatedProject = await updateProjectTx(tx, {projectId: params.id, updateParts})

    if (!updatedProject) {
      throw new Error('Project not found')
    }

    if (body.prompts !== undefined && (!hasExistingJob || hasPromptChanges)) {
      promptCleanupSummary = await applyProjectPromptEditsTx(tx, {body: {prompts: body.prompts}, params})
    }

    if (promptCleanupSummary) {
      await markComparisonServingStaleForProjectPromptEditTx(tx, params.id)
    }

    if (
      hasFullTextStrategyChange
      || (!hasExistingJob && (hasSystemPromptVariantUpdate || changedReviewConfigFields.includes('useMetadata')))
    ) {
      await getComparisonProjectServingInvalidationService().markComparisonProjectsServingStaleForSourceProjects(
        [params.id],
        {runner: tx},
      )
    }

    if (hasImportRouteChanges && !hasExistingJob) {
      const selectedRoutes = Array.from(
        new Set(
          (body.importRoutes ?? []).filter((route) => {
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
          throw new HttpError(400, 'One or more selected import routes are invalid')
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

    const projectSourceUpdatedAt = getReviewServingSourceTimestamp(updatedProject.updatedAt)

    await appendProjectReviewConfigDeltaIfNeeded(tx, {
      changedReviewConfigFields,
      projectId: params.id,
      sourceMutationKey: `projectEdit|${params.id}|${projectSourceUpdatedAt}`,
      sourceOperation: 'update',
      sourceUpdatedAt: projectSourceUpdatedAt,
    })

    const updatedPrompts = await getProjectEditResponsePrompts(tx, params.id)

    return promptCleanupSummary
      ? {project: getProjectValue(updatedProject), promptCleanupSummary, prompts: updatedPrompts}
      : {project: getProjectValue(updatedProject), prompts: updatedPrompts}
  })
}
