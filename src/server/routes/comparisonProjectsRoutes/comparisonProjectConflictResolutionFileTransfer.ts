import {appendComparisonProjectConflictResolutionTransferIdentifier} from './comparisonProjectConflictResolutionFileTransfer/appendComparisonProjectConflictResolutionTransferIdentifier.ts'
import type {ComparisonProjectConflictResolutionTransferArtifact} from './comparisonProjectConflictResolutionFileTransfer/comparisonProjectConflictResolutionTransferArtifactSchema.ts'
import {
  comparisonProjectConflictResolutionTransferFormat,
  comparisonProjectConflictResolutionTransferVersion,
} from './comparisonProjectConflictResolutionFileTransfer/comparisonProjectConflictResolutionTransferFormat.ts'
import {
  getComparisonProjectConflictResolutionTransferIdTitleKey,
  getComparisonProjectConflictResolutionTransferTitleKey,
  normalizeComparisonProjectConflictResolutionTransferIdentifier,
} from './comparisonProjectConflictResolutionFileTransfer/comparisonProjectConflictResolutionTransferNormalization.ts'
import type {
  ComparisonProjectConflictResolutionTransferJudgmentContextV2,
  ComparisonProjectConflictResolutionTransferMatchKey,
  ComparisonProjectConflictResolutionTransferRowV1,
  ComparisonProjectConflictResolutionTransferRowV3,
  ComparisonProjectConflictResolutionTransferSourceRow,
  ComparisonProjectConflictResolutionTransferSourceV1,
} from './comparisonProjectConflictResolutionFileTransfer/comparisonProjectConflictResolutionTransferTypes.ts'
import {getComparisonProjectConflictResolutionTransferRowBase} from './comparisonProjectConflictResolutionFileTransfer/getComparisonProjectConflictResolutionTransferRowBase.ts'
import {validateComparisonProjectConflictResolutionTransferArtifact} from './comparisonProjectConflictResolutionFileTransfer/validateComparisonProjectConflictResolutionTransferArtifact.ts'

export type {
  ComparisonProjectConflictResolutionTransferArtifact,
  ComparisonProjectConflictResolutionTransferArtifactV1,
} from './comparisonProjectConflictResolutionFileTransfer/comparisonProjectConflictResolutionTransferArtifactSchema.ts'
export {
  comparisonProjectConflictResolutionTransferArtifactSchema,
  comparisonProjectConflictResolutionTransferArtifactV1,
} from './comparisonProjectConflictResolutionFileTransfer/comparisonProjectConflictResolutionTransferArtifactSchema.ts'
export {
  comparisonProjectConflictResolutionTransferFormat,
  comparisonProjectConflictResolutionTransferVersion,
  comparisonProjectConflictResolutionTransferVersions,
} from './comparisonProjectConflictResolutionFileTransfer/comparisonProjectConflictResolutionTransferFormat.ts'
export {
  getComparisonProjectConflictResolutionTransferIdTitleKey,
  getComparisonProjectConflictResolutionTransferTitleKey,
  normalizeComparisonProjectConflictResolutionTransferDoi,
  normalizeComparisonProjectConflictResolutionTransferExternalArticleId,
  normalizeComparisonProjectConflictResolutionTransferIdentifier,
  normalizeComparisonProjectConflictResolutionTransferTitle,
} from './comparisonProjectConflictResolutionFileTransfer/comparisonProjectConflictResolutionTransferNormalization.ts'
export type {
  ComparisonProjectConflictResolutionTransferIdentifierKind,
  ComparisonProjectConflictResolutionTransferIdentifierV1,
  ComparisonProjectConflictResolutionTransferJudgmentContextV2,
  ComparisonProjectConflictResolutionTransferMatchKey,
  ComparisonProjectConflictResolutionTransferMatchKind,
  ComparisonProjectConflictResolutionTransferProvenanceV2,
  ComparisonProjectConflictResolutionTransferResolutionV1,
  ComparisonProjectConflictResolutionTransferRowV1,
  ComparisonProjectConflictResolutionTransferRowV2,
  ComparisonProjectConflictResolutionTransferRowV3,
  ComparisonProjectConflictResolutionTransferSourceRow,
  ComparisonProjectConflictResolutionTransferSourceV1,
} from './comparisonProjectConflictResolutionFileTransfer/comparisonProjectConflictResolutionTransferTypes.ts'
export {
  comparisonProjectConflictResolutionTransferJudgmentContextMaxBytes,
  validateComparisonProjectConflictResolutionTransferArtifact,
} from './comparisonProjectConflictResolutionFileTransfer/validateComparisonProjectConflictResolutionTransferArtifact.ts'

const getComparisonProjectConflictResolutionTransferSourceRowKey = (
  row: ComparisonProjectConflictResolutionTransferSourceRow,
) => {
  return row.sourceResolutionId ?? `comment:${row.sourceArticleRowId}`
}

export const getComparisonProjectConflictResolutionTransferRows = (
  rows: readonly ComparisonProjectConflictResolutionTransferSourceRow[],
): ComparisonProjectConflictResolutionTransferRowV3[] => {
  return Array.from(
    rows
      .reduce<Map<string, ComparisonProjectConflictResolutionTransferRowV3>>((rowMap, row) => {
        const rowKey = getComparisonProjectConflictResolutionTransferSourceRowKey(row)
        const currentRow = rowMap.get(rowKey) ?? getComparisonProjectConflictResolutionTransferRowBase(row)

        rowMap.set(rowKey, appendComparisonProjectConflictResolutionTransferIdentifier(currentRow, row))
        return rowMap
      }, new Map<string, ComparisonProjectConflictResolutionTransferRowV3>())
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

export const createComparisonProjectConflictResolutionTransferArtifact = (params: {
  exportedAt?: Date | string
  judgmentContexts?: readonly ComparisonProjectConflictResolutionTransferJudgmentContextV2[]
  rows: readonly ComparisonProjectConflictResolutionTransferRowV3[]
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
