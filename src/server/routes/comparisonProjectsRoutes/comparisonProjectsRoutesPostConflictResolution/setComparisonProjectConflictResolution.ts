import {getDateValue, getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import {getUserConfigQueryService} from '../../../services/userConfigQueryService.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../../../utils/duckdbService.ts'
import {HttpError} from '../../../utils/httpError.ts'
import {getComparisonProjectConflictResolutionOptionByValue} from '../comparisonProjectConflictResolutionOptions.ts'
import {
  comparisonProjectConflictResolutionInsertColumnsSql,
  type ComparisonProjectConflictResolutionWriteProvenance,
  getComparisonProjectConflictResolutionInsertValuesSql,
  getComparisonProjectConflictResolutionProvenance,
  getComparisonProjectConflictResolutionProvenanceMatchesCurrent,
  getComparisonProjectConflictResolutionReviewer,
} from '../comparisonProjectConflictResolutionProvenance.ts'
import {
  getConflictResolutionSaveDiagnostic,
  getConflictResolutionSaveErrorDiagnostic,
  getConflictResolutionSaveMemorySnapshot,
  getConflictResolutionSaveRuntimeDiagnostic,
  logConflictResolutionSavePhase,
} from '../comparisonProjectConflictResolutionSaveDiagnostics.ts'
import {getComparisonProjectConflictResolutionTargetRow} from '../comparisonProjectConflictResolutionTargetRows.ts'
import {comparisonProjectConflictResolutionTable} from '../comparisonProjectRouteConstants.ts'
import {appDatabaseService} from '../comparisonProjectRouteServices.ts'
import type {
  ComparisonProjectConflictResolution,
  ComparisonProjectConflictResolutionOption,
  ComparisonProjectConflictResolutionTargetRow,
} from '../comparisonProjectRouteTypes.ts'
import type {ComparisonProjectScope} from '../comparisonProjectScopeTypes.ts'
import {getIsSummaryMode} from '../getIsSummaryMode.ts'

type ComparisonProjectConflictResolutionSavedRow = {
  articleId: string
  replacedExistingResolution: boolean
  reviewerDisplayName: string | null
  reviewerUserId: string | null
  setAt?: unknown
}

const getValidatedComparisonProjectConflictResolutionOption = (scope: ComparisonProjectScope, value: string) => {
  const option = getComparisonProjectConflictResolutionOptionByValue(scope).get(value)

  if (!option) {
    throw new HttpError(
      400,
      getIsSummaryMode(scope)
        ? 'Conflict resolution answer must be one of the summary prompt options'
        : 'Conflict resolution prompt must belong to the comparison project',
    )
  }

  return option
}

const getComparisonProjectConflictResolutionUiProvenance = (
  scope: Pick<ComparisonProjectScope, 'activeGeneration' | 'judgmentContextId'>,
  reviewer: {id: string; name: string},
): ComparisonProjectConflictResolutionWriteProvenance => {
  return {
    judgmentContextId: scope.judgmentContextId,
    origin: 'ui',
    originRef: null,
    reviewerDisplayName: reviewer.name,
    reviewerUserId: reviewer.id,
    servingGeneration: scope.activeGeneration,
  }
}

const getSavedComparisonProjectConflictResolution = (params: {
  option: ComparisonProjectConflictResolutionOption
  resolutionRow: ComparisonProjectConflictResolutionSavedRow
  reviewer: {id: string; name: string}
  scope: Pick<ComparisonProjectScope, 'activeGeneration' | 'judgmentContextId'>
}): ComparisonProjectConflictResolution => {
  const provenance = getComparisonProjectConflictResolutionUiProvenance(params.scope, params.reviewer)
  const provenanceRow = {
    judgmentContextId: provenance.judgmentContextId,
    origin: provenance.origin,
    reviewerDisplayName: params.resolutionRow.reviewerDisplayName ?? provenance.reviewerDisplayName,
    reviewerUserId: params.resolutionRow.reviewerUserId ?? provenance.reviewerUserId,
    servingGeneration: provenance.servingGeneration,
    setAt: params.resolutionRow.setAt ?? new Date(),
  }

  return {
    articleId: params.resolutionRow.articleId,
    label: params.option.label,
    provenance: getComparisonProjectConflictResolutionProvenance(provenanceRow),
    provenanceMatchesCurrent: getComparisonProjectConflictResolutionProvenanceMatchesCurrent(
      provenance.judgmentContextId,
      params.scope.judgmentContextId,
    ),
    reviewer: getComparisonProjectConflictResolutionReviewer(provenanceRow),
    reviewerDisplayName: provenanceRow.reviewerDisplayName,
    reviewerUserId: provenanceRow.reviewerUserId,
    setAt: getDateValue(provenanceRow.setAt),
    value: params.option.value,
  }
}

export const setComparisonProjectConflictResolution = async (params: {
  articleId: string
  value: string
  scope: ComparisonProjectScope
}) => {
  const startedAt = Date.now()
  const baseDiagnostic = {
    activeGeneration: params.scope.activeGeneration,
    articleId: params.articleId,
    comparisonProjectId: params.scope.id,
    isSummaryMode: getIsSummaryMode(params.scope),
    requestedValue: params.value,
  }
  let phase = 'target-validation'
  let targetRow: ComparisonProjectConflictResolutionTargetRow | null = null

  console.info(
    '[comparison-projects] conflict-resolution save started',
    getConflictResolutionSaveDiagnostic(baseDiagnostic),
  )

  try {
    logConflictResolutionSavePhase('target-validation:start', baseDiagnostic)
    targetRow = await getComparisonProjectConflictResolutionTargetRow(params.scope, params.articleId)
    logConflictResolutionSavePhase('target-validation:complete', baseDiagnostic, {
      articleCategory: targetRow.articleCategory,
      hasConflict: targetRow.hasConflict,
    })
    phase = 'option-validation'
    logConflictResolutionSavePhase('option-validation:start', baseDiagnostic)
    const option = getValidatedComparisonProjectConflictResolutionOption(params.scope, params.value)
    const isSummaryMode = getIsSummaryMode(params.scope)
    logConflictResolutionSavePhase('option-validation:complete', baseDiagnostic, {resolvedValue: option.value})
    phase = 'reviewer-load'
    logConflictResolutionSavePhase('reviewer-load:start', baseDiagnostic)
    const reviewer = await getUserConfigQueryService().getOrCreateUserConfig()
    logConflictResolutionSavePhase('reviewer-load:complete', baseDiagnostic, {reviewerUserId: reviewer.id})
    phase = 'resolution-replace'
    logConflictResolutionSavePhase('resolution-replace:start', baseDiagnostic, {reviewerUserId: reviewer.id})
    const resolutionRow = await appDatabaseService.transaction<ComparisonProjectConflictResolutionSavedRow>(
      async (tx): Promise<ComparisonProjectConflictResolutionSavedRow> => {
        const deletedRows = await tx.queryJson<{articleId: string}>(
          `
          DELETE FROM ${comparisonProjectConflictResolutionTable}
          WHERE comparison_project_id = ${getSqlLiteral(params.scope.id)}
            AND article_id = ${getSqlLiteral(params.articleId)}
          RETURNING article_id AS articleId
        `,
        )
        const [insertedRow] = await tx.queryJson<{
          articleId: string
          reviewerDisplayName: string | null
          reviewerUserId: string | null
          setAt?: unknown
        }>(`
          INSERT INTO ${comparisonProjectConflictResolutionTable} (${comparisonProjectConflictResolutionInsertColumnsSql})
          VALUES ${getComparisonProjectConflictResolutionInsertValuesSql({
            answerValue: isSummaryMode ? option.value : null,
            articleId: params.articleId,
            comparisonProjectId: params.scope.id,
            id: crypto.randomUUID(),
            promptId: isSummaryMode ? null : option.value,
            provenance: getComparisonProjectConflictResolutionUiProvenance(params.scope, reviewer),
          })}
          RETURNING
            article_id AS articleId,
            reviewer_user_id AS reviewerUserId,
            reviewer_display_name AS reviewerDisplayName,
            updated_at AS setAt
        `)

        if (!insertedRow) {
          throw new Error('Failed to save conflict resolution')
        }

        return {...insertedRow, replacedExistingResolution: deletedRows.length > 0}
      },
      getMaintenanceDuckdbWorkloadContext('comparisonProjectConflictResolution.replace'),
    )

    if (!resolutionRow) {
      throw new Error('Failed to save conflict resolution')
    }
    logConflictResolutionSavePhase('resolution-replace:complete', baseDiagnostic, {
      replacedExistingResolution: resolutionRow.replacedExistingResolution,
      returnedArticleId: resolutionRow.articleId,
      reviewerUserId: reviewer.id,
    })

    console.info('[comparison-projects] conflict-resolution save completed', {
      ...baseDiagnostic,
      articleCategory: targetRow.articleCategory,
      durationMs: Date.now() - startedAt,
      hasConflict: targetRow.hasConflict,
      memory: getConflictResolutionSaveMemorySnapshot(),
      resolvedValue: option.value,
      reviewerUserId: reviewer.id,
      runtime: getConflictResolutionSaveRuntimeDiagnostic(),
    })

    return getSavedComparisonProjectConflictResolution({option, resolutionRow, reviewer, scope: params.scope})
  } catch (error) {
    console.error('[comparison-projects] conflict-resolution save failed', {
      ...baseDiagnostic,
      articleCategory: targetRow?.articleCategory ?? null,
      durationMs: Date.now() - startedAt,
      error: getConflictResolutionSaveErrorDiagnostic(error),
      hasConflict: targetRow?.hasConflict ?? null,
      memory: getConflictResolutionSaveMemorySnapshot(),
      phase,
      runtime: getConflictResolutionSaveRuntimeDiagnostic(),
    })
    throw error
  }
}
