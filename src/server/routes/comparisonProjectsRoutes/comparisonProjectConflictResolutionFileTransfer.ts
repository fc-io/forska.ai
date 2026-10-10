import {type as arktype} from 'arktype'

import type {HumanJudgmentMode} from '../../../db/schemaTypes.ts'

export const comparisonProjectConflictResolutionTransferFormat = 'forska.comparisonProject.conflictResolution.transfer'
export const comparisonProjectConflictResolutionTransferVersion = 2
export const comparisonProjectConflictResolutionTransferVersions = [1, 2] as const

export type ComparisonProjectConflictResolutionTransferIdentifierKind = 'arxiv' | 'doi' | 'pmid'
export type ComparisonProjectConflictResolutionTransferMatchKind =
  | ComparisonProjectConflictResolutionTransferIdentifierKind
  | 'article-id'
  | 'covidence-id-title'
  | 'id-title'
  | 'title'

export type ComparisonProjectConflictResolutionTransferSourceRow = {
  arxivId?: string | null
  biorxivId?: string | null
  doi?: string | null
  externalArticleId?: string | null
  identifierIsPrimary?: boolean | null
  identifierKind?: string | null
  identifierNormalizedValue?: string | null
  identifierSource?: string | null
  medrxivId?: string | null
  pubmedId?: string | null
  sourceArticleRowId: string
  sourceIdentifierId?: string | null
  sourceResolutionId: string
  title?: string | null
  url?: string | null
  resolutionLabel: string
  resolutionMode: HumanJudgmentMode
  resolutionValue: string
  provenanceContextId?: string | null
  provenanceOrigin?: string | null
  provenanceReviewerDisplayName?: string | null
  provenanceSetAt?: Date | string | null
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
  sourceResolutionId: string | null
  sourceArticleRowId: string | null
  externalArticleId: string | null
  title: string | null
  doi?: string | null
  pubmedId?: string | null
  arxivId?: string | null
  biorxivId?: string | null
  medrxivId?: string | null
  url?: string | null
  identifiers: ComparisonProjectConflictResolutionTransferIdentifierV1[]
  resolution: ComparisonProjectConflictResolutionTransferResolutionV1
}

export type ComparisonProjectConflictResolutionTransferProvenanceV2 = {
  reviewerDisplayName: string | null
  contextId: string | null
  setAt: string | null
  origin: string | null
}

export type ComparisonProjectConflictResolutionTransferRowV2 = ComparisonProjectConflictResolutionTransferRowV1 & {
  provenance?: ComparisonProjectConflictResolutionTransferProvenanceV2 | null
}

export type ComparisonProjectConflictResolutionTransferJudgmentContextV2 = {
  id: string
  context: Record<string, unknown>
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
const transferArtifactRootKeys = ['exportedAt', 'format', 'judgmentContexts', 'rows', 'source', 'version']
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
const TransferProvenance = arktype({
  reviewerDisplayName: 'string | null',
  contextId: 'string | null',
  setAt: 'string | null',
  origin: 'string | null',
})
const TransferJudgmentContext = arktype({id: 'string', context: 'Record<string, unknown>'})
const TransferRow = arktype({
  sourceResolutionId: 'string | null',
  sourceArticleRowId: 'string | null',
  externalArticleId: 'string | null',
  title: 'string | null',
  'doi?': 'string | null',
  'pubmedId?': 'string | null',
  'arxivId?': 'string | null',
  'biorxivId?': 'string | null',
  'medrxivId?': 'string | null',
  'url?': 'string | null',
  identifiers: TransferIdentifier.array(),
  resolution: TransferResolution,
  'provenance?': TransferProvenance.or('null'),
})
const TransferSource = arktype({
  comparisonProjectId: 'string',
  comparisonProjectName: 'string',
  comparisonProjectDescription: 'string | null',
})

export const comparisonProjectConflictResolutionTransferArtifactSchema = arktype({
  format: arktype(`"${comparisonProjectConflictResolutionTransferFormat}"`),
  version: '1 | 2',
  exportedAt: 'string',
  source: TransferSource,
  rows: TransferRow.array(),
  'judgmentContexts?': TransferJudgmentContext.array(),
})

export const comparisonProjectConflictResolutionTransferArtifactV1 =
  comparisonProjectConflictResolutionTransferArtifactSchema

export type ComparisonProjectConflictResolutionTransferArtifact =
  typeof comparisonProjectConflictResolutionTransferArtifactSchema.infer

export type ComparisonProjectConflictResolutionTransferArtifactV1 = ComparisonProjectConflictResolutionTransferArtifact

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

export const getComparisonProjectConflictResolutionTransferTitleKey = (params: {title?: string | null}) => {
  return normalizeComparisonProjectConflictResolutionTransferTitle(params.title)
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

const hasComparisonProjectConflictResolutionTransferSourceField = (
  row: ComparisonProjectConflictResolutionTransferSourceRow,
  field: keyof Pick<
    ComparisonProjectConflictResolutionTransferSourceRow,
    'arxivId' | 'biorxivId' | 'doi' | 'medrxivId' | 'pubmedId' | 'url'
  >,
) => {
  return Object.prototype.hasOwnProperty.call(row, field)
}

const getComparisonProjectConflictResolutionTransferIdentityFields = (
  row: ComparisonProjectConflictResolutionTransferSourceRow,
) => {
  return {
    ...(hasComparisonProjectConflictResolutionTransferSourceField(row, 'doi') ? {doi: getTrimmedText(row.doi)} : {}),
    ...(hasComparisonProjectConflictResolutionTransferSourceField(row, 'pubmedId')
      ? {pubmedId: getTrimmedText(row.pubmedId)}
      : {}),
    ...(hasComparisonProjectConflictResolutionTransferSourceField(row, 'arxivId')
      ? {arxivId: getTrimmedText(row.arxivId)}
      : {}),
    ...(hasComparisonProjectConflictResolutionTransferSourceField(row, 'biorxivId')
      ? {biorxivId: getTrimmedText(row.biorxivId)}
      : {}),
    ...(hasComparisonProjectConflictResolutionTransferSourceField(row, 'medrxivId')
      ? {medrxivId: getTrimmedText(row.medrxivId)}
      : {}),
    ...(hasComparisonProjectConflictResolutionTransferSourceField(row, 'url') ? {url: getTrimmedText(row.url)} : {}),
  }
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

const getComparisonProjectConflictResolutionTransferSetAt = (value: Date | string | null | undefined) => {
  const date = value === null || value === undefined ? null : new Date(value)

  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null
}

const getComparisonProjectConflictResolutionTransferProvenance = (
  row: ComparisonProjectConflictResolutionTransferSourceRow,
): ComparisonProjectConflictResolutionTransferProvenanceV2 => {
  return {
    reviewerDisplayName: getTrimmedText(row.provenanceReviewerDisplayName),
    contextId: getTrimmedText(row.provenanceContextId),
    setAt: getComparisonProjectConflictResolutionTransferSetAt(row.provenanceSetAt),
    origin: getTrimmedText(row.provenanceOrigin),
  }
}

const hasComparisonProjectConflictResolutionTransferProvenance = (
  row: ComparisonProjectConflictResolutionTransferSourceRow,
) => {
  return Object.prototype.hasOwnProperty.call(row, 'provenanceSetAt')
}

const getComparisonProjectConflictResolutionTransferRowBase = (
  row: ComparisonProjectConflictResolutionTransferSourceRow,
): ComparisonProjectConflictResolutionTransferRowV2 => {
  return {
    sourceResolutionId: row.sourceResolutionId,
    sourceArticleRowId: row.sourceArticleRowId,
    externalArticleId: getTrimmedText(row.externalArticleId),
    title: getTrimmedText(row.title),
    ...getComparisonProjectConflictResolutionTransferIdentityFields(row),
    identifiers: [],
    resolution: {mode: row.resolutionMode, value: row.resolutionValue.trim(), label: row.resolutionLabel.trim()},
    ...(hasComparisonProjectConflictResolutionTransferProvenance(row)
      ? {provenance: getComparisonProjectConflictResolutionTransferProvenance(row)}
      : {}),
  }
}

const appendComparisonProjectConflictResolutionTransferIdentifier = (
  currentRow: ComparisonProjectConflictResolutionTransferRowV2,
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
): ComparisonProjectConflictResolutionTransferRowV2[] => {
  return Array.from(
    rows
      .reduce<Map<string, ComparisonProjectConflictResolutionTransferRowV2>>((rowMap, row) => {
        const currentRow =
          rowMap.get(row.sourceResolutionId) ?? getComparisonProjectConflictResolutionTransferRowBase(row)

        rowMap.set(row.sourceResolutionId, appendComparisonProjectConflictResolutionTransferIdentifier(currentRow, row))
        return rowMap
      }, new Map<string, ComparisonProjectConflictResolutionTransferRowV2>())
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
  const titleKey = getComparisonProjectConflictResolutionTransferTitleKey(row)

  return idTitleKey
    ? [...identifierMatchKeys, {kind: 'id-title', value: idTitleKey}]
    : titleKey
      ? [...identifierMatchKeys, {kind: 'title', value: titleKey}]
      : identifierMatchKeys
}

export const getComparisonProjectConflictResolutionTransferFilename = (comparisonProjectId: string) => {
  return `conflict-resolutions-${comparisonProjectId}.json`
}

const getExportedAtDate = (value: Date | string) => {
  return new Date(value).toISOString()
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
): ComparisonProjectConflictResolutionTransferArtifact => {
  assertNoUnexpectedRootKeys(artifact)

  return comparisonProjectConflictResolutionTransferArtifactSchema.assert(artifact)
}

export const createComparisonProjectConflictResolutionTransferArtifact = (params: {
  exportedAt?: Date | string
  judgmentContexts?: readonly ComparisonProjectConflictResolutionTransferJudgmentContextV2[]
  rows: readonly ComparisonProjectConflictResolutionTransferRowV2[]
  source: ComparisonProjectConflictResolutionTransferSourceV1
}): ComparisonProjectConflictResolutionTransferArtifact => {
  return validateComparisonProjectConflictResolutionTransferArtifact({
    format: comparisonProjectConflictResolutionTransferFormat,
    version: comparisonProjectConflictResolutionTransferVersion,
    exportedAt: getExportedAtDate(params.exportedAt ?? new Date()),
    source: params.source,
    rows: [...params.rows],
    ...(params.judgmentContexts && params.judgmentContexts.length > 0
      ? {judgmentContexts: [...params.judgmentContexts]}
      : {}),
  })
}
