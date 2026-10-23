import {idTitleKeySeparator} from './comparisonProjectConflictResolutionImportConstants.ts'
import {getTrimmedText} from './comparisonProjectConflictResolutionImportUtils.ts'

export const normalizeComparisonProjectConflictResolutionImportExternalArticleId = (
  value: string | null | undefined,
) => {
  const normalizedValue = getTrimmedText(value)?.toLowerCase() ?? ''

  return normalizedValue.length > 0 ? normalizedValue : null
}

export const normalizeComparisonProjectConflictResolutionImportTitle = (value: string | null | undefined) => {
  const normalizedValue = getTrimmedText(value)?.toLowerCase().replace(/\s+/g, ' ') ?? ''

  return normalizedValue.length > 0 ? normalizedValue : null
}

export const getComparisonProjectConflictResolutionImportIdTitleKey = (params: {
  externalArticleId?: string | null
  title?: string | null
}) => {
  const externalArticleId = normalizeComparisonProjectConflictResolutionImportExternalArticleId(
    params.externalArticleId,
  )
  const title = normalizeComparisonProjectConflictResolutionImportTitle(params.title)

  return externalArticleId && title ? `${externalArticleId}${idTitleKeySeparator}${title}` : null
}

export const getComparisonProjectConflictResolutionImportTitleKey = (params: {title?: string | null}) => {
  return normalizeComparisonProjectConflictResolutionImportTitle(params.title)
}

const getDecodedExternalArticleIdTail = (value: string) => {
  const tail = value.slice(value.lastIndexOf(':') + 1)

  try {
    return decodeURIComponent(tail)
  } catch {
    return tail
  }
}

export const getComparisonProjectConflictResolutionImportCovidenceArticleKey = (params: {
  externalArticleId?: string | null
}) => {
  const externalArticleId = getTrimmedText(params.externalArticleId)

  if (!externalArticleId) {
    return null
  }

  const normalizedExternalArticleId = externalArticleId.toLowerCase()
  const articleKey = normalizedExternalArticleId.startsWith('covidence:#')
    ? normalizedExternalArticleId
    : normalizedExternalArticleId.startsWith('covidence:')
      ? normalizeComparisonProjectConflictResolutionImportExternalArticleId(
          getDecodedExternalArticleIdTail(externalArticleId),
        )
      : null

  return articleKey?.startsWith('covidence:#') && articleKey.length > 'covidence:#'.length ? articleKey : null
}

export const getComparisonProjectConflictResolutionImportCovidenceIdTitleKey = (params: {
  externalArticleId?: string | null
  title?: string | null
}) => {
  const covidenceArticleKey = getComparisonProjectConflictResolutionImportCovidenceArticleKey(params)
  const title = normalizeComparisonProjectConflictResolutionImportTitle(params.title)

  return covidenceArticleKey && title ? `${covidenceArticleKey}${idTitleKeySeparator}${title}` : null
}
