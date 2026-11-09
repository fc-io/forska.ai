import {
  type ComparisonProjectColumnHeaderColumn,
  getComparisonProjectColumnHeader,
} from '../../../../../utils/comparisonProjectColumnHeader.ts'
import {
  covidenceImportMaxReferencesPerFile,
  getCovidenceImportPartCount,
} from '../../../../../utils/covidenceImportLimits.ts'

export const getCompareProjectCovidenceExportColumnLabel = (column: ComparisonProjectColumnHeaderColumn) => {
  return getComparisonProjectColumnHeader({...column, sourceProjectName: null})
}

const getArticleCountText = (count: number) => {
  return count === 1 ? '1 article' : `${count.toLocaleString()} articles`
}

const getCountedButtonLabel = (count: number | null) => {
  return count === null ? 'Export to Covidence' : `Export ${getArticleCountText(count)} to Covidence`
}

export const getCompareProjectCovidenceExportButtonLabel = (count: number | null, isExporting: boolean) => {
  return isExporting ? 'Exporting to Covidence...' : getCountedButtonLabel(count)
}

const getSplitFilesHint = (count: number | null) => {
  return count !== null && count > covidenceImportMaxReferencesPerFile
    ? `Covidence imports at most ${covidenceImportMaxReferencesPerFile.toLocaleString()} references per file, so the download is a ZIP with ${getCovidenceImportPartCount(count)} RIS files. Import each file separately.`
    : null
}

const getMatchingSelectionResultHint = (count: number | null) => {
  return count === 0 ? 'No articles match this selection.' : getSplitFilesHint(count)
}

const getNotMatchingArticleCountText = (count: number) => {
  return count === 1 ? '1 article does not match' : `${count.toLocaleString()} articles do not match`
}

const getInvertedSelectionCountHint = (count: number) => {
  return [`Inverted: ${getNotMatchingArticleCountText(count)} the selection above.`, getSplitFilesHint(count)]
    .filter((hint): hint is string => {
      return hint !== null
    })
    .join(' ')
}

const getInvertedSelectionResultHint = (count: number | null) => {
  return count === null ? null : getInvertedSelectionCountHint(count)
}

const getSelectionResultHint = (count: number | null, invertSelection: boolean) => {
  return invertSelection ? getInvertedSelectionResultHint(count) : getMatchingSelectionResultHint(count)
}

export const getCompareProjectCovidenceExportHint = (
  hasSelection: boolean,
  count: number | null,
  invertSelection = false,
) => {
  return hasSelection
    ? getSelectionResultHint(count, invertSelection)
    : 'Nothing is selected, so there is nothing to export.'
}
