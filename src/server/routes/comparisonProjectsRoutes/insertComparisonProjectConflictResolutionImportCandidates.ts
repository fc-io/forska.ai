import {getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getComparisonProjectConflictResolutionImportPlan} from './comparisonProjectConflictResolutionImport.ts'
import {
  type ComparisonProjectConflictResolutionImportCandidate,
  getComparisonProjectConflictResolutionImportResolutionCandidates,
} from './comparisonProjectConflictResolutionImportCandidates.ts'
import {
  comparisonProjectConflictResolutionInsertColumnsSql,
  type ComparisonProjectConflictResolutionWriteProvenance,
  getComparisonProjectConflictResolutionInsertValuesSql,
} from './comparisonProjectConflictResolutionProvenance.ts'
import {comparisonProjectConflictResolutionTable} from './comparisonProjectRouteConstants.ts'
import type {AppTx} from './comparisonProjectRouteTypes.ts'
import {getUniqueStringValues} from './comparisonProjectValueHelpers.ts'

export const insertComparisonProjectConflictResolutionImportCandidates = async (params: {
  candidates: ReturnType<typeof getComparisonProjectConflictResolutionImportPlan>['candidates']
  comparisonProjectId: string
  getProvenance: (
    candidate: ComparisonProjectConflictResolutionImportCandidate,
  ) => ComparisonProjectConflictResolutionWriteProvenance
  tx: AppTx
}) => {
  const resolutionCandidates = getComparisonProjectConflictResolutionImportResolutionCandidates(params.candidates)

  if (resolutionCandidates.length === 0) {
    return 0
  }

  const targetArticleIds = getUniqueStringValues(
    resolutionCandidates.map((candidate) => {
      return candidate.targetArticleId
    }),
  )

  await params.tx.run(`
    DELETE FROM ${comparisonProjectConflictResolutionTable}
    WHERE comparison_project_id = ${getSqlLiteral(params.comparisonProjectId)}
      AND article_id IN (${getQuotedStringList(targetArticleIds).join(', ')})
  `)
  await params.tx.run(`
    INSERT INTO ${comparisonProjectConflictResolutionTable} (${comparisonProjectConflictResolutionInsertColumnsSql})
    VALUES ${resolutionCandidates
      .map((candidate) => {
        return getComparisonProjectConflictResolutionInsertValuesSql({
          answerValue: candidate.resolutionValue,
          articleId: candidate.targetArticleId,
          comparisonProjectId: params.comparisonProjectId,
          id: crypto.randomUUID(),
          promptId: null,
          provenance: params.getProvenance(candidate),
        })
      })
      .join(',\n')}
  `)

  return resolutionCandidates.length
}
