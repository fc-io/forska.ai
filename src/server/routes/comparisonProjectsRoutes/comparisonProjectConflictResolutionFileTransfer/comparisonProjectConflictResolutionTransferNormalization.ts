import type {ComparisonProjectConflictResolutionTransferIdentifierKind} from './comparisonProjectConflictResolutionTransferTypes.ts'

const doiPrefixPattern = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i
export const idTitleKeySeparator = '\u001F'

export const getTrimmedText = (value: string | null | undefined) => {
  const trimmedValue = value?.trim() ?? ''

  return trimmedValue.length > 0 ? trimmedValue : null
}

export const getNormalizedText = (value: string | null | undefined) => {
  const normalizedValue = getTrimmedText(value)?.toLowerCase() ?? ''

  return normalizedValue.length > 0 ? normalizedValue : null
}

export const normalizeComparisonProjectConflictResolutionTransferDoi = (value: string | null | undefined) => {
  const normalizedValue = getNormalizedText(value)?.replace(doiPrefixPattern, '').trim() ?? ''

  return normalizedValue.length > 0 ? normalizedValue : null
}

export const normalizeComparisonProjectConflictResolutionTransferIdentifier = (params: {
  kind: ComparisonProjectConflictResolutionTransferIdentifierKind
  value: string | null | undefined
}) => {
  return params.kind === 'doi'
    ? normalizeComparisonProjectConflictResolutionTransferDoi(params.value)
    : getNormalizedText(params.value)
}

export const normalizeComparisonProjectConflictResolutionTransferExternalArticleId = (
  value: string | null | undefined,
) => {
  return getNormalizedText(value)
}

export const normalizeComparisonProjectConflictResolutionTransferTitle = (value: string | null | undefined) => {
  const normalizedValue = getTrimmedText(value)?.toLowerCase().replace(/\s+/g, ' ') ?? ''

  return normalizedValue.length > 0 ? normalizedValue : null
}

export const getComparisonProjectConflictResolutionTransferIdTitleKey = (params: {
  externalArticleId?: string | null
  title?: string | null
}) => {
  const externalArticleId = normalizeComparisonProjectConflictResolutionTransferExternalArticleId(
    params.externalArticleId,
  )
  const title = normalizeComparisonProjectConflictResolutionTransferTitle(params.title)

  return externalArticleId && title ? `${externalArticleId}${idTitleKeySeparator}${title}` : null
}

export const getComparisonProjectConflictResolutionTransferTitleKey = (params: {title?: string | null}) => {
  return normalizeComparisonProjectConflictResolutionTransferTitle(params.title)
}
