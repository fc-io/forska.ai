import {
  getComparisonProjectConflictResolutionImportAnalyzeResult,
  getComparisonProjectConflictResolutionImportPlan,
} from './comparisonProjectConflictResolutionImport.ts'
import {getComparisonProjectConflictResolutionImportSourceRowsFromTransferArtifact} from './comparisonProjectConflictResolutionImport/getComparisonProjectConflictResolutionImportSourceRowsFromTransferArtifact.ts'
import {getConflictResolutionImportCommentChanges} from './comparisonProjectConflictResolutionImportCandidates.ts'
import {
  getComparisonProjectConflictResolutionArtifactImportRequest,
  validateConflictResolutionImportAnalyzeTarget,
} from './comparisonProjectConflictResolutionImportRequests.ts'
import {getComparisonProjectPromptTypeOptions} from './comparisonProjectConflictResolutionOptions.ts'
import type {AppQueryRunner} from './comparisonProjectRouteTypes.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getUniqueStringValues} from './comparisonProjectValueHelpers.ts'
import {getConflictResolutionImportTargetArticles} from './getConflictResolutionImportTargetArticles.ts'

const getComparisonProjectScopeSummaryOptionValues = (scope: ComparisonProjectScope) => {
  return getUniqueStringValues(
    scope.prompts.flatMap((promptConfig) => {
      return getComparisonProjectPromptTypeOptions(promptConfig.type)
    }),
  )
}

export const getConflictResolutionArtifactImportAnalysis = async (params: {
  body: unknown
  scope: ComparisonProjectScope
  tx: AppQueryRunner
}) => {
  validateConflictResolutionImportAnalyzeTarget(params.scope)

  const {artifact, importMode, overwriteMode} = getComparisonProjectConflictResolutionArtifactImportRequest(params.body)
  const sourceRows = getComparisonProjectConflictResolutionImportSourceRowsFromTransferArtifact(artifact)
  const targetArticles = await getConflictResolutionImportTargetArticles({
    sourceRows,
    scope: params.scope,
    tx: params.tx,
  })
  const targetSummaryOptionValues = getComparisonProjectScopeSummaryOptionValues(params.scope)
  const plan = getComparisonProjectConflictResolutionImportPlan({
    importMode,
    overwriteMode,
    sourceRows,
    targetArticles,
    targetSummaryOptionValues,
  })
  const commentChanges = await getConflictResolutionImportCommentChanges({
    comparisonProjectId: params.scope.id,
    overwriteMode,
    plan,
    tx: params.tx,
  })
  const analyzeResult = getComparisonProjectConflictResolutionImportAnalyzeResult({
    artifact,
    commentChanges,
    importMode,
    overwriteMode,
    sourceRows,
    targetArticles,
    targetSummaryOptionValues,
  })

  return {analyzeResult, artifact, commentChanges, plan, sourceRows}
}
