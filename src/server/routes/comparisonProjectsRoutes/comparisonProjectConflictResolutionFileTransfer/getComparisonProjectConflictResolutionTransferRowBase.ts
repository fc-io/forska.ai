import {getNormalizedComparisonProjectConflictComment} from '../../../../utils/comparisonProjectConflictResolutionComment.ts'
import {getTrimmedText} from './comparisonProjectConflictResolutionTransferNormalization.ts'
import type {
  ComparisonProjectConflictResolutionTransferProvenanceV2,
  ComparisonProjectConflictResolutionTransferResolutionV1,
  ComparisonProjectConflictResolutionTransferRowV3,
  ComparisonProjectConflictResolutionTransferSourceRow,
} from './comparisonProjectConflictResolutionTransferTypes.ts'

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

const hasComparisonProjectConflictResolutionTransferComment = (
  row: ComparisonProjectConflictResolutionTransferSourceRow,
) => {
  return Object.prototype.hasOwnProperty.call(row, 'comment')
}

const getComparisonProjectConflictResolutionTransferResolution = (
  row: ComparisonProjectConflictResolutionTransferSourceRow,
): ComparisonProjectConflictResolutionTransferResolutionV1 | null => {
  return row.resolutionValue === null
    ? null
    : {
        mode: row.resolutionMode,
        value: row.resolutionValue.trim(),
        label: (row.resolutionLabel ?? row.resolutionValue).trim(),
      }
}

export const getComparisonProjectConflictResolutionTransferRowBase = (
  row: ComparisonProjectConflictResolutionTransferSourceRow,
): ComparisonProjectConflictResolutionTransferRowV3 => {
  const resolution = getComparisonProjectConflictResolutionTransferResolution(row)

  return {
    sourceResolutionId: row.sourceResolutionId,
    sourceArticleRowId: row.sourceArticleRowId,
    externalArticleId: getTrimmedText(row.externalArticleId),
    title: getTrimmedText(row.title),
    ...getComparisonProjectConflictResolutionTransferIdentityFields(row),
    identifiers: [],
    resolution,
    ...(resolution && hasComparisonProjectConflictResolutionTransferProvenance(row)
      ? {provenance: getComparisonProjectConflictResolutionTransferProvenance(row)}
      : {}),
    ...(hasComparisonProjectConflictResolutionTransferComment(row)
      ? {comment: getNormalizedComparisonProjectConflictComment(row.comment)}
      : {}),
  }
}
