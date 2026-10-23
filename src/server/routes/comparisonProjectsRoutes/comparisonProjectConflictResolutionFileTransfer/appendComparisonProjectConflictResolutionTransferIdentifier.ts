import {
  getNormalizedText,
  getTrimmedText,
  idTitleKeySeparator,
  normalizeComparisonProjectConflictResolutionTransferIdentifier,
} from './comparisonProjectConflictResolutionTransferNormalization.ts'
import type {
  ComparisonProjectConflictResolutionTransferIdentifierKind,
  ComparisonProjectConflictResolutionTransferIdentifierV1,
  ComparisonProjectConflictResolutionTransferRowV3,
  ComparisonProjectConflictResolutionTransferSourceRow,
} from './comparisonProjectConflictResolutionTransferTypes.ts'

const transferIdentifierKinds = new Set<ComparisonProjectConflictResolutionTransferIdentifierKind>([
  'arxiv',
  'doi',
  'pmid',
])

const getComparisonProjectConflictResolutionTransferIdentifierKind = (value: string | null | undefined) => {
  const normalizedValue = getNormalizedText(value)

  return normalizedValue
    && transferIdentifierKinds.has(normalizedValue as ComparisonProjectConflictResolutionTransferIdentifierKind)
    ? (normalizedValue as ComparisonProjectConflictResolutionTransferIdentifierKind)
    : null
}

const getComparisonProjectConflictResolutionTransferIdentifier = (
  row: ComparisonProjectConflictResolutionTransferSourceRow,
): ComparisonProjectConflictResolutionTransferIdentifierV1 | null => {
  const kind = getComparisonProjectConflictResolutionTransferIdentifierKind(row.identifierKind)
  const normalizedValue = kind
    ? normalizeComparisonProjectConflictResolutionTransferIdentifier({kind, value: row.identifierNormalizedValue})
    : null
  const sourceIdentifierId = getTrimmedText(row.sourceIdentifierId)
  const source = getTrimmedText(row.identifierSource)

  return kind && normalizedValue && sourceIdentifierId && source
    ? {sourceIdentifierId, kind, normalizedValue, source, isPrimary: row.identifierIsPrimary === true}
    : null
}

const getComparisonProjectConflictResolutionTransferIdentifierKey = (
  identifier: ComparisonProjectConflictResolutionTransferIdentifierV1,
) => {
  return [identifier.sourceIdentifierId, identifier.kind, identifier.normalizedValue, identifier.source].join(
    idTitleKeySeparator,
  )
}

const getUniqueComparisonProjectConflictResolutionTransferIdentifiers = (
  identifiers: readonly ComparisonProjectConflictResolutionTransferIdentifierV1[],
) => {
  return Array.from(
    identifiers
      .reduce<Map<string, ComparisonProjectConflictResolutionTransferIdentifierV1>>((identifierMap, identifier) => {
        return identifierMap.has(getComparisonProjectConflictResolutionTransferIdentifierKey(identifier))
          ? identifierMap
          : identifierMap.set(getComparisonProjectConflictResolutionTransferIdentifierKey(identifier), identifier)
      }, new Map<string, ComparisonProjectConflictResolutionTransferIdentifierV1>())
      .values(),
  ).sort((left, right) => {
    return getComparisonProjectConflictResolutionTransferIdentifierKey(left).localeCompare(
      getComparisonProjectConflictResolutionTransferIdentifierKey(right),
    )
  })
}

export const appendComparisonProjectConflictResolutionTransferIdentifier = (
  currentRow: ComparisonProjectConflictResolutionTransferRowV3,
  row: ComparisonProjectConflictResolutionTransferSourceRow,
) => {
  const identifier = getComparisonProjectConflictResolutionTransferIdentifier(row)

  return identifier
    ? {
        ...currentRow,
        identifiers: getUniqueComparisonProjectConflictResolutionTransferIdentifiers([
          ...currentRow.identifiers,
          identifier,
        ]),
      }
    : currentRow
}
