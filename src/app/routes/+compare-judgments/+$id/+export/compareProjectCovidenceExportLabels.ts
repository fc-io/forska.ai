const getArticleCountText = (count: number) => {
  return count === 1 ? '1 article' : `${count.toLocaleString()} articles`
}

const getCountedButtonLabel = (count: number | null) => {
  return count === null ? 'Export to Covidence' : `Export ${getArticleCountText(count)} to Covidence`
}

export const getCompareProjectCovidenceExportButtonLabel = (count: number | null, isExporting: boolean) => {
  return isExporting ? 'Exporting to Covidence...' : getCountedButtonLabel(count)
}

const getEmptyResultHint = (count: number | null) => {
  return count === 0 ? 'No articles match this selection.' : null
}

export const getCompareProjectCovidenceExportHint = (hasSelection: boolean, count: number | null) => {
  return hasSelection ? getEmptyResultHint(count) : 'Nothing is selected, so there is nothing to export.'
}
