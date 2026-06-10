import {type as arktype} from 'arktype'

import type {HumanJudgmentMode} from '../../../db/schemaTypes.ts'

export const comparisonProjectConflictResolutionTransferFormat = 'forska.comparisonProject.conflictResolution.transfer'
export const comparisonProjectConflictResolutionTransferVersion = 1

export type ComparisonProjectConflictResolutionTransferIdentifierKind = 'arxiv' | 'doi' | 'pmid'
export type ComparisonProjectConflictResolutionTransferMatchKind =
  | ComparisonProjectConflictResolutionTransferIdentifierKind
  | 'id-title'

export type ComparisonProjectConflictResolutionTransferSourceRow = {
  externalArticleId?: string | null
  identifierIsPrimary?: boolean | null
  identifierKind?: string | null
  identifierNormalizedValue?: string | null
  identifierSource?: string | null
  sourceArticleRowId: string
  sourceIdentifierId?: string | null
  sourceResolutionId: string
  title?: string | null
  resolutionLabel: string
  resolutionMode: HumanJudgmentMode
  resolutionValue: string
}

export type ComparisonProjectConflictResolutionTransferIdentifierV1 = {
  sourceIdentifierId: string
  kind: ComparisonProjectConflictResolutionTransferIdentifierKind
  normalizedValue: string
  source: string
  isPrimary: boolean
}

export type ComparisonProjectConflictResolutionTransferResolutionV1 = {
  mode: HumanJudgmentMode
  value: string
  label: string
}

export type ComparisonProjectConflictResolutionTransferRowV1 = {
  sourceResolutionId: string
  sourceArticleRowId: string
  externalArticleId: string | null
  title: string | null
  identifiers: ComparisonProjectConflictResolutionTransferIdentifierV1[]
  resolution: ComparisonProjectConflictResolutionTransferResolutionV1
}

export type ComparisonProjectConflictResolutionTransferSourceV1 = {
  comparisonProjectId: string
  comparisonProjectName: string
  comparisonProjectDescription: string | null
}

export type ComparisonProjectConflictResolutionTransferMatchKey = {
  kind: ComparisonProjectConflictResolutionTransferMatchKind
  value: string
}

const doiPrefixPattern = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i
const idTitleKeySeparator = '\u001F'
const transferArtifactRootKeys = ['exportedAt', 'format', 'rows', 'source', 'version']
const transferIdentifierKinds = new Set<ComparisonProjectConflictResolutionTransferIdentifierKind>([
  'arxiv',
  'doi',
  'pmid',
])

const TransferIdentifierKind = arktype('"arxiv" | "doi" | "pmid"')
const TransferResolutionMode = arktype('"prompt" | "summary"')
const TransferIdentifier = arktype({
  sourceIdentifierId: 'string',
  kind: TransferIdentifierKind,
  normalizedValue: 'string',
  source: 'string',
  isPrimary: 'boolean',
})
const TransferResolution = arktype({mode: TransferResolutionMode, value: 'string', label: 'string'})
const TransferRow = arktype({
  sourceResolutionId: 'string',
  sourceArticleRowId: 'string',
  externalArticleId: 'string | null',
  title: 'string | null',
  identifiers: TransferIdentifier.array(),
  resolution: TransferResolution,
})
const TransferSource = arktype({
  comparisonProjectId: 'string',
  comparisonProjectName: 'string',
  comparisonProjectDescription: 'string | null',
})

export const comparisonProjectConflictResolutionTransferArtifactV1 = arktype({
  format: arktype(`"${comparisonProjectConflictResolutionTransferFormat}"`),
  version: '1',
  exportedAt: 'string',
  source: TransferSource,
  rows: TransferRow.array(),
})

export type ComparisonProjectConflictResolutionTransferArtifactV1 =
  typeof comparisonProjectConflictResolutionTransferArtifactV1.infer

const getTrimmedText = (value: string | null | undefined) => {
  const trimmedValue = value?.trim() ?? ''

  return trimmedValue.length > 0 ? trimmedValue : null
}

const getNormalizedText = (value: string | null | undefined) => {
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

const getComparisonProjectConflictResolutionTransferRowBase = (
  row: ComparisonProjectConflictResolutionTransferSourceRow,
): ComparisonProjectConflictResolutionTransferRowV1 => {
  return {
    sourceResolutionId: row.sourceResolutionId,
    sourceArticleRowId: row.sourceArticleRowId,
    externalArticleId: getTrimmedText(row.externalArticleId),
    title: getTrimmedText(row.title),
    identifiers: [],
    resolution: {mode: row.resolutionMode, value: row.resolutionValue.trim(), label: row.resolutionLabel.trim()},
  }
}

const appendComparisonProjectConflictResolutionTransferIdentifier = (
  currentRow: ComparisonProjectConflictResolutionTransferRowV1,
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

export const getComparisonProjectConflictResolutionTransferRows = (
  rows: readonly ComparisonProjectConflictResolutionTransferSourceRow[],
): ComparisonProjectConflictResolutionTransferRowV1[] => {
  return Array.from(
    rows
      .reduce<Map<string, ComparisonProjectConflictResolutionTransferRowV1>>((rowMap, row) => {
        const currentRow =
          rowMap.get(row.sourceResolutionId) ?? getComparisonProjectConflictResolutionTransferRowBase(row)

        rowMap.set(row.sourceResolutionId, appendComparisonProjectConflictResolutionTransferIdentifier(currentRow, row))
        return rowMap
      }, new Map<string, ComparisonProjectConflictResolutionTransferRowV1>())
      .values(),
  )
}

export const getComparisonProjectConflictResolutionTransferMatchKeys = (
  row: Pick<ComparisonProjectConflictResolutionTransferRowV1, 'externalArticleId' | 'identifiers' | 'title'>,
): ComparisonProjectConflictResolutionTransferMatchKey[] => {
  const identifierMatchKeys = row.identifiers.flatMap<ComparisonProjectConflictResolutionTransferMatchKey>(
    (identifier) => {
      const normalizedValue = normalizeComparisonProjectConflictResolutionTransferIdentifier({
        kind: identifier.kind,
        value: identifier.normalizedValue,
      })

      return normalizedValue ? [{kind: identifier.kind, value: normalizedValue}] : []
    },
  )
  const idTitleKey = getComparisonProjectConflictResolutionTransferIdTitleKey(row)

  return idTitleKey ? [...identifierMatchKeys, {kind: 'id-title', value: idTitleKey}] : identifierMatchKeys
}

const getFilenameSafeName = (value: string) => {
  const safeName = value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)

  return safeName.length > 0 ? safeName : 'comparison_project'
}

const getExportedAtDate = (value: Date | string) => {
  return new Date(value).toISOString()
}

export const getComparisonProjectConflictResolutionTransferFilename = (params: {
  exportedAt?: Date | string
  sourceName: string
}) => {
  const exportedAt = getExportedAtDate(params.exportedAt ?? new Date()).slice(0, 10)

  return `${getFilenameSafeName(params.sourceName)}_conflict_resolutions_${exportedAt}.json`
}

const getUnexpectedRootKeys = (artifact: unknown) => {
  return artifact && typeof artifact === 'object' && !Array.isArray(artifact)
    ? Object.keys(artifact).filter((key) => {
        return !transferArtifactRootKeys.includes(key)
      })
    : []
}

const assertNoUnexpectedRootKeys = (artifact: unknown) => {
  const unexpectedKeys = getUnexpectedRootKeys(artifact)

  if (unexpectedKeys.length > 0) {
    throw new Error(`Unexpected conflict resolution transfer artifact root fields: ${unexpectedKeys.join(', ')}`)
  }
}

export const validateComparisonProjectConflictResolutionTransferArtifact = (
  artifact: unknown,
): ComparisonProjectConflictResolutionTransferArtifactV1 => {
  assertNoUnexpectedRootKeys(artifact)

  return comparisonProjectConflictResolutionTransferArtifactV1.assert(artifact)
}

export const createComparisonProjectConflictResolutionTransferArtifact = (params: {
  exportedAt?: Date | string
  rows: readonly ComparisonProjectConflictResolutionTransferRowV1[]
  source: ComparisonProjectConflictResolutionTransferSourceV1
}): ComparisonProjectConflictResolutionTransferArtifactV1 => {
  return validateComparisonProjectConflictResolutionTransferArtifact({
    format: comparisonProjectConflictResolutionTransferFormat,
    version: comparisonProjectConflictResolutionTransferVersion,
    exportedAt: getExportedAtDate(params.exportedAt ?? new Date()),
    source: params.source,
    rows: [...params.rows],
  })
}
