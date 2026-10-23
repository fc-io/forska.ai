import {Elysia, t} from 'elysia'

import type {
  ComparisonProjectConflictResolutionImportMode,
  ComparisonProjectConflictResolutionImportSummary,
} from './comparisonProjectConflictResolutionImport.ts'
import {getConflictResolutionImportRejectedError} from './comparisonProjectConflictResolutionImportValidation.ts'
import {getComparisonProjectRecordValue} from './comparisonProjectRecord.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import type {
  AppQueryRunner,
  CreateComparisonProjectFromProjectContext,
  CreateComparisonProjectFromProjectSelectionBody,
  PromptSelection,
} from './comparisonProjectRouteTypes.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getUniqueStringValues} from './comparisonProjectValueHelpers.ts'
import {getConflictResolutionImportPlanResult} from './getConflictResolutionImportPlanResult.ts'
import {getConflictResolutionImportSummary} from './getConflictResolutionImportSummary.ts'
import {getCreateComparisonProjectFromProjectContext} from './getCreateComparisonProjectFromProjectContext.ts'
import {getCreateFromProjectImportScope} from './getCreateFromProjectImportScope.ts'
import {validateConflictResolutionImportSources} from './validateConflictResolutionImportSources.ts'

const getEmptyConflictResolutionImportSummary = (): ComparisonProjectConflictResolutionImportSummary => {
  return {
    deduped: 0,
    scanned: 0,
    matched: 0,
    imported: 0,
    skipped: 0,
    skippedAmbiguousTarget: 0,
    skippedConflictingIdentifiers: 0,
    skippedConflicting: 0,
    skippedExistingTargetResolution: 0,
    skippedInvalidValue: 0,
    skippedNoTargetMatch: 0,
    skippedNoUsableKey: 0,
    skippedNotConflicting: 0,
    skippedUnsupportedMode: 0,
    sameValue: 0,
    overwriteCandidates: 0,
    warnings: [],
  }
}

const previewComparisonProjectConflictResolutionImport = async (params: {
  importMode?: ComparisonProjectConflictResolutionImportMode
  promptSelections: PromptSelection[]
  scope: ComparisonProjectScope
  sourceComparisonProjectIds: string[]
  tx: AppQueryRunner
}) => {
  const {plan, sourceRows} = await getConflictResolutionImportPlanResult(params)

  return getConflictResolutionImportSummary({
    importedCount: plan.candidates.length,
    plan,
    scannedCount: sourceRows.length,
  })
}

const getComparisonProjectConflictResolutionImportPreview = async (
  body: CreateComparisonProjectFromProjectSelectionBody & {
    conflictResolutionImportSourceComparisonProjectIds?: string[]
  },
) => {
  const context = await getCreateComparisonProjectFromProjectContext(body)
  const sourceComparisonProjectIds = getUniqueStringValues(
    body.conflictResolutionImportSourceComparisonProjectIds ?? [],
  )

  if (sourceComparisonProjectIds.length === 0) {
    return getEmptyConflictResolutionImportSummary()
  }

  if (context.humanJudgmentMode !== 'summary' || !body.compareWithHumans || !body.allowConflictResolution) {
    throw getConflictResolutionImportRejectedError(
      'Conflict resolution imports require summary mode and allow conflict resolution to be enabled',
    )
  }

  await validateConflictResolutionImportSources(appDatabaseService, sourceComparisonProjectIds)

  return previewComparisonProjectConflictResolutionImport({
    importMode: body.conflictResolutionImportMode,
    promptSelections: context.sourcePromptSelections,
    scope: await getCreateFromProjectImportScope({
      createdComparisonProject: getCreateFromProjectPreviewComparisonProject({body, context}),
      promptSelections: context.sourcePromptSelections,
      selectedImportRoutes: context.selectedImportRoutes,
      selectedSourceProjectIds: context.selectedSourceProjectIds,
      selectedSourceProjects: context.selectedSourceProjects,
      summarySourceProjectId: context.summarySourceProjectId,
      tx: appDatabaseService,
    }),
    sourceComparisonProjectIds,
    tx: appDatabaseService,
  })
}

const getCreateFromProjectPreviewComparisonProject = (params: {
  body: CreateComparisonProjectFromProjectSelectionBody
  context: CreateComparisonProjectFromProjectContext
}): ReturnType<typeof getComparisonProjectRecordValue> => {
  const now = new Date(0)

  return {
    id: 'comparison-project-conflict-resolution-import-preview',
    name: 'Conflict resolution import preview',
    description: null,
    modelIds: params.context.selectedModelIds,
    compareWithHumans: params.body.compareWithHumans ?? false,
    allowConflictResolution: params.body.allowConflictResolution ?? false,
    humanJudgmentMode: params.context.humanJudgmentMode,
    summarySourceProjectId: params.context.summarySourceProjectId,
    useTitle: params.context.sourceProject.useTitle,
    useAbstract: params.context.sourceProject.useAbstract,
    useFulltext: params.context.sourceProject.useFulltext,
    useFulltextNoImages: params.context.sourceProject.useFulltextNoImages,
    archived: false,
    createdAt: now,
    updatedAt: now,
  }
}

export const comparisonProjectsRoutesPostConflictResolutionImportPreview = new Elysia().post(
  '/api/comparison-projects/conflict-resolution-import-preview',
  async (context) => {
    const {body} = context
    const data = await getComparisonProjectConflictResolutionImportPreview(body)

    return {data}
  },
  {
    body: t.Object({
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
