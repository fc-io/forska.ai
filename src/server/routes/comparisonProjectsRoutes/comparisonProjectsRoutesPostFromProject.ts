import {Elysia, t} from 'elysia'

import {rejectLegacyFullTextNoImagesBody} from '../../utils/rejectLegacyFullTextNoImagesBody.ts'
import {writeComparisonProjectConflictCommentImportChanges} from './comparisonProjectConflictComment.ts'
import type {ComparisonProjectConflictResolutionImportSummary} from './comparisonProjectConflictResolutionImport/comparisonProjectConflictResolutionImportAnalyzeTypes.ts'
import type {
  ComparisonProjectConflictResolutionImportMode,
  ComparisonProjectConflictResolutionImportSourceRow,
} from './comparisonProjectConflictResolutionImport/comparisonProjectConflictResolutionImportTypes.ts'
import {getConflictResolutionImportCommentChanges} from './comparisonProjectConflictResolutionImportCandidates.ts'
import {getConflictResolutionImportRejectedError} from './comparisonProjectConflictResolutionImportValidation.ts'
import {checkpointComparisonProjectMutation} from './comparisonProjectMutationCheckpoint.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import type {AppTx, PromptSelection} from './comparisonProjectRouteTypes.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {markComparisonProjectServingStaleAndQueueRebuild} from './comparisonProjectServingRebuildQueue.ts'
import {getUniqueStringValues} from './comparisonProjectValueHelpers.ts'
import {createComparisonProjectRecord} from './createComparisonProjectRecord.ts'
import {getComparisonProjectConflictResolutionImportProvenanceResolver} from './getComparisonProjectConflictResolutionImportProvenanceResolver.ts'
import {getConflictResolutionImportPlanResult} from './getConflictResolutionImportPlanResult.ts'
import {getConflictResolutionImportSummary} from './getConflictResolutionImportSummary.ts'
import {getCreateComparisonProjectFromProjectContext} from './getCreateComparisonProjectFromProjectContext.ts'
import {getCreateFromProjectImportScope} from './getCreateFromProjectImportScope.ts'
import {insertComparisonProjectConflictResolutionImportCandidates} from './insertComparisonProjectConflictResolutionImportCandidates.ts'
import {validateConflictResolutionImportSources} from './validateConflictResolutionImportSources.ts'

const getComparisonProjectConflictResolutionSourceReviewer = (
  sourceRow: ComparisonProjectConflictResolutionImportSourceRow | null,
) => {
  return {
    displayName: sourceRow?.sourceProvenance?.reviewerDisplayName ?? null,
    userId: sourceRow?.sourceProvenance?.reviewerUserId ?? null,
  }
}

const importComparisonProjectConflictResolutions = async (params: {
  comparisonProjectId: string
  importMode?: ComparisonProjectConflictResolutionImportMode
  promptSelections: PromptSelection[]
  scope: ComparisonProjectScope
  sourceComparisonProjectIds: string[]
  tx: AppTx
}) => {
  const {plan, sourceRows} = await getConflictResolutionImportPlanResult(params)

  const importedCount = await insertComparisonProjectConflictResolutionImportCandidates({
    candidates: plan.candidates,
    comparisonProjectId: params.comparisonProjectId,
    getProvenance: getComparisonProjectConflictResolutionImportProvenanceResolver({
      origin: 'project-import',
      reviewer: getComparisonProjectConflictResolutionSourceReviewer,
      sourceRows,
    }),
    tx: params.tx,
  })
  await writeComparisonProjectConflictCommentImportChanges({
    commentChanges: await getConflictResolutionImportCommentChanges({
      comparisonProjectId: params.comparisonProjectId,
      overwriteMode: 'skip-existing',
      plan,
      tx: params.tx,
    }),
    comparisonProjectId: params.comparisonProjectId,
    tx: params.tx,
  })

  return getConflictResolutionImportSummary({importedCount, plan, scannedCount: sourceRows.length})
}

export const comparisonProjectsRoutesPostFromProject = new Elysia().post(
  '/api/comparison-projects/from-project',
  async (context) => {
    const {body} = context
    const fromProjectContext = await getCreateComparisonProjectFromProjectContext(body)
    const conflictResolutionImportSourceComparisonProjectIds = getUniqueStringValues(
      body.conflictResolutionImportSourceComparisonProjectIds ?? [],
    )
    const hasConflictResolutionImportSources = conflictResolutionImportSourceComparisonProjectIds.length > 0

    if (
      hasConflictResolutionImportSources
      && (fromProjectContext.humanJudgmentMode !== 'summary'
        || !body.compareWithHumans
        || !body.allowConflictResolution)
    ) {
      throw getConflictResolutionImportRejectedError(
        'Conflict resolution imports require summary mode and allow conflict resolution to be enabled',
      )
    }
    const createResult = (await appDatabaseService.transaction(async (tx) => {
      await validateConflictResolutionImportSources(tx, conflictResolutionImportSourceComparisonProjectIds)

      const createdComparisonProject = await createComparisonProjectRecord(tx, {
        name: body.name,
        description: body.description,
        modelIds: fromProjectContext.selectedModelIds,
        compareWithHumans: body.compareWithHumans,
        allowConflictResolution: body.allowConflictResolution,
        humanJudgmentMode: fromProjectContext.humanJudgmentMode,
        summarySourceProjectId: fromProjectContext.summarySourceProjectId,
        useTitle: fromProjectContext.sourceProject.useTitle,
        useAbstract: fromProjectContext.sourceProject.useAbstract,
        useFulltext: fromProjectContext.sourceProject.useFulltext,
        useFulltextNoImages: fromProjectContext.sourceProject.useFulltextNoImages,
        importRoutes: fromProjectContext.selectedImportRoutes,
        sourceProjectIds:
          fromProjectContext.humanJudgmentMode === 'summary'
            ? fromProjectContext.selectedSourceProjectIds
            : [fromProjectContext.sourceProject.id],
        promptSelections: fromProjectContext.sourcePromptSelections,
        validateModelIds: false,
      })
      const conflictResolutionImportSummary = hasConflictResolutionImportSources
        ? await importComparisonProjectConflictResolutions({
            comparisonProjectId: createdComparisonProject.id,
            importMode: body.conflictResolutionImportMode,
            promptSelections: fromProjectContext.sourcePromptSelections,
            scope: await getCreateFromProjectImportScope({
              createdComparisonProject,
              promptSelections: fromProjectContext.sourcePromptSelections,
              selectedImportRoutes: fromProjectContext.selectedImportRoutes,
              selectedSourceProjectIds: fromProjectContext.selectedSourceProjectIds,
              selectedSourceProjects: fromProjectContext.selectedSourceProjects,
              summarySourceProjectId: fromProjectContext.summarySourceProjectId,
              tx,
            }),
            sourceComparisonProjectIds: conflictResolutionImportSourceComparisonProjectIds,
            tx,
          })
        : null

      return {createdComparisonProject, conflictResolutionImportSummary}
    })) as {
      createdComparisonProject: Awaited<ReturnType<typeof createComparisonProjectRecord>>
      conflictResolutionImportSummary: ComparisonProjectConflictResolutionImportSummary | null
    }
    const createdComparisonProject = createResult.createdComparisonProject
    await checkpointComparisonProjectMutation()
    await markComparisonProjectServingStaleAndQueueRebuild(createdComparisonProject.id)

    return createResult.conflictResolutionImportSummary
      ? {data: createdComparisonProject, conflictResolutionImportSummary: createResult.conflictResolutionImportSummary}
      : {data: createdComparisonProject}
  },
  {
    transform: rejectLegacyFullTextNoImagesBody,
    body: t.Object({
      name: t.String(),
      description: t.Optional(t.Union([t.String(), t.Null()])),
      compareWithHumans: t.Optional(t.Boolean()),
      allowConflictResolution: t.Optional(t.Boolean()),
      humanJudgmentMode: t.Optional(t.Union([t.Literal('prompt'), t.Literal('summary')])),
      summarySourceProjectId: t.Optional(t.Union([t.String(), t.Null()])),
      sourceProjectId: t.String(),
      sourceProjectIds: t.Optional(t.Array(t.String())),
      conflictResolutionImportMode: t.Optional(t.Union([t.Literal('conflicting-only'), t.Literal('all-matched')])),
      conflictResolutionImportSourceComparisonProjectIds: t.Optional(t.Array(t.String())),
    }),
  },
)
