import type {
  ImportRowMatchDetail,
  NormalizedSourceRow,
  NormalizedTargetArticle,
} from './comparisonProjectConflictResolutionImportMatchTypes.ts'
import type {ComparisonProjectConflictResolutionImportMatchKind} from './comparisonProjectConflictResolutionImportTypes.ts'

export const getImportRowMatchDetail = (params: {
  matchKey: string | null
  matchKind: ComparisonProjectConflictResolutionImportMatchKind | null
  sourceRow: NormalizedSourceRow
  targetArticles: readonly NormalizedTargetArticle[]
}): ImportRowMatchDetail => {
  return {
    matchKey: params.matchKey,
    matchKind: params.matchKind,
    sourceRow: params.sourceRow,
    targetArticles: [...params.targetArticles],
  }
}
