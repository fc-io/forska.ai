import {getComparisonProjectConflictResolutionImportDoiKeys} from './comparisonProjectConflictResolutionImportIdentifierKeys.ts'
import type {NormalizedTargetArticle} from './comparisonProjectConflictResolutionImportMatchTypes.ts'
import {
  getComparisonProjectConflictResolutionImportCovidenceIdTitleKey,
  getComparisonProjectConflictResolutionImportIdTitleKey,
  getComparisonProjectConflictResolutionImportTitleKey,
} from './comparisonProjectConflictResolutionImportTitleKeys.ts'
import type {ComparisonProjectConflictResolutionImportTargetArticle} from './comparisonProjectConflictResolutionImportTypes.ts'
import {getNormalizedIdentifierKeys} from './getNormalizedIdentifierKeys.ts'

export const getNormalizedTargetArticles = (
  targetArticles: readonly ComparisonProjectConflictResolutionImportTargetArticle[],
): NormalizedTargetArticle[] => {
  return targetArticles.map((article) => {
    const doiKeys = getComparisonProjectConflictResolutionImportDoiKeys(article)

    return {
      ...article,
      covidenceIdTitleKey: getComparisonProjectConflictResolutionImportCovidenceIdTitleKey(article),
      doiKeys,
      identifierKeys: getNormalizedIdentifierKeys(article),
      idTitleKey: getComparisonProjectConflictResolutionImportIdTitleKey(article),
      titleKey: getComparisonProjectConflictResolutionImportTitleKey(article),
    }
  })
}
