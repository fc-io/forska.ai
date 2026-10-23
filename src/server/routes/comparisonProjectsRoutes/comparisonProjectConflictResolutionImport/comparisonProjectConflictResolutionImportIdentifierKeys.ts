import type {ComparisonProjectConflictResolutionImportIdentifier} from './comparisonProjectConflictResolutionImportTypes.ts'
import {getTrimmedText} from './comparisonProjectConflictResolutionImportUtils.ts'
import {getNormalizedIdentifierKeys} from './getNormalizedIdentifierKeys.ts'

const doiPrefixPattern = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i

export const normalizeComparisonProjectConflictResolutionImportDoi = (value: string | null | undefined) => {
  const trimmedValue = getTrimmedText(value)
  const normalizedValue = trimmedValue?.toLowerCase().replace(doiPrefixPattern, '').trim() ?? ''

  return normalizedValue.length > 0 ? normalizedValue : null
}

export const getComparisonProjectConflictResolutionImportDoiKeys = (row: {
  arxivId?: string | null
  doi?: string | null
  doiKeys?: readonly (string | null | undefined)[] | null
  identifierKeys?: readonly (string | null | undefined)[] | null
  identifiers?: readonly ComparisonProjectConflictResolutionImportIdentifier[] | null
  legacyDoi?: string | null
  pubmedId?: string | null
}) => {
  return getNormalizedIdentifierKeys(row)
    .filter((identifierKey) => {
      return identifierKey.kind === 'doi'
    })
    .map((identifierKey) => {
      return identifierKey.normalizedValue
    })
}

export const getComparisonProjectConflictResolutionImportIdentifierKeys = (
  row: Parameters<typeof getComparisonProjectConflictResolutionImportDoiKeys>[0],
) => {
  return getNormalizedIdentifierKeys(row).map((identifierKey) => {
    return identifierKey.key
  })
}
