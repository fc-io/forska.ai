import {getComparisonProjectConflictCommentTextsByArticleId} from './comparisonProjectConflictComment.ts'
import {getComparisonProjectConflictResolutionImportPlan} from './comparisonProjectConflictResolutionImport.ts'
import {getComparisonProjectConflictResolutionImportCommentChanges} from './comparisonProjectConflictResolutionImport/comparisonProjectConflictResolutionImportCommentChanges.ts'
import type {
  ComparisonProjectConflictResolutionImportOverwriteMode,
  ComparisonProjectConflictResolutionImportSourceRow,
} from './comparisonProjectConflictResolutionImport/comparisonProjectConflictResolutionImportTypes.ts'
import type {AppQueryRunner} from './comparisonProjectRouteTypes.ts'

export type ComparisonProjectConflictResolutionImportCandidate = ReturnType<
  typeof getComparisonProjectConflictResolutionImportPlan
>['candidates'][number]

export const getComparisonProjectConflictResolutionImportSourceRowsById = (
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[],
) => {
  return sourceRows.reduce<Map<string, ComparisonProjectConflictResolutionImportSourceRow>>((rowMap, sourceRow) => {
    return rowMap.has(sourceRow.sourceRowId) ? rowMap : rowMap.set(sourceRow.sourceRowId, sourceRow)
  }, new Map<string, ComparisonProjectConflictResolutionImportSourceRow>())
}

export const getComparisonProjectConflictResolutionImportCandidateSourceRow = (
  candidate: ComparisonProjectConflictResolutionImportCandidate,
  sourceRowsById: ReadonlyMap<string, ComparisonProjectConflictResolutionImportSourceRow>,
) => {
  const [firstSourceRow] = candidate.sourceRows

  return firstSourceRow ? (sourceRowsById.get(firstSourceRow.sourceRowId) ?? null) : null
}

export const getConflictResolutionImportCommentChanges = async (params: {
  comparisonProjectId: string
  overwriteMode: ComparisonProjectConflictResolutionImportOverwriteMode
  plan: ReturnType<typeof getComparisonProjectConflictResolutionImportPlan>
  tx: AppQueryRunner
}) => {
  return getComparisonProjectConflictResolutionImportCommentChanges({
    commentSources: params.plan.commentSources,
    existingCommentsByArticleId: await getComparisonProjectConflictCommentTextsByArticleId({
      articleIds: params.plan.commentSources.map((commentSource) => {
        return commentSource.targetArticleId
      }),
      comparisonProjectId: params.comparisonProjectId,
      queryRunner: params.tx,
    }),
    overwriteMode: params.overwriteMode,
  })
}

type ComparisonProjectConflictResolutionImportResolutionCandidate =
  ComparisonProjectConflictResolutionImportCandidate & {resolutionValue: string}

export const getComparisonProjectConflictResolutionImportResolutionCandidates = (
  candidates: readonly ComparisonProjectConflictResolutionImportCandidate[],
) => {
  return candidates.filter((candidate): candidate is ComparisonProjectConflictResolutionImportResolutionCandidate => {
    return candidate.resolutionValue !== null
  })
}
