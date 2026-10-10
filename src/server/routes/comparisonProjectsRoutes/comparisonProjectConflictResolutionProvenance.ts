import {createHash} from 'node:crypto'

import type {ComparisonProjectConflictResolutionProvenanceFilter} from '../../../utils/comparisonProjectConflictResolutionFilter.ts'
import {getDateValue, getSqlLiteral} from '../../services/appQueryHelpers.ts'

export type {ComparisonProjectConflictResolutionProvenanceFilter}

export type ComparisonProjectConflictResolutionOrigin = 'file-import' | 'pdf-import' | 'project-import' | 'ui'

export type ComparisonProjectConflictResolutionWriteProvenance = {
  judgmentContextId: string | null
  origin: ComparisonProjectConflictResolutionOrigin
  originRef: string | null
  reviewerDisplayName: string | null
  reviewerUserId: string | null
  servingGeneration: number | null
}

export type ComparisonProjectConflictResolutionReviewer = {displayName: string | null; userId: string}

export type ComparisonProjectConflictResolutionProvenance = {
  contextId: string | null
  generation: number | null
  origin: ComparisonProjectConflictResolutionOrigin | null
  setAt: Date | null
}

export type ComparisonProjectConflictResolutionProvenanceRow = {
  judgmentContextId: string | null
  origin: string | null
  reviewerDisplayName: string | null
  reviewerUserId: string | null
  servingGeneration: unknown
  setAt: unknown
}

export const comparisonProjectConflictResolutionInsertColumnsSql = `
  id,
  comparison_project_id,
  article_id,
  prompt_id,
  answer_value,
  reviewer_user_id,
  judgment_context_id,
  serving_generation,
  reviewer_display_name,
  origin,
  origin_ref
`

const transferReviewerIdPrefix = 'transfer:'
const comparisonProjectConflictResolutionOrigins = new Set<string>([
  'file-import',
  'pdf-import',
  'project-import',
  'ui',
])

const getComparisonProjectConflictResolutionOriginValue = (
  value: string | null | undefined,
): ComparisonProjectConflictResolutionOrigin | null => {
  return value && comparisonProjectConflictResolutionOrigins.has(value)
    ? (value as ComparisonProjectConflictResolutionOrigin)
    : null
}

const getTrimmedText = (value: string | null | undefined) => {
  const trimmedValue = value?.trim() ?? ''

  return trimmedValue.length > 0 ? trimmedValue : null
}

const getServingGenerationValue = (value: unknown) => {
  const generation = typeof value === 'bigint' ? Number(value) : Number(value ?? Number.NaN)

  return Number.isSafeInteger(generation) && generation > 0 ? generation : null
}

export const getComparisonProjectConflictResolutionInsertValuesSql = (params: {
  answerValue: string | null
  articleId: string
  comparisonProjectId: string
  id: string
  promptId: string | null
  provenance: ComparisonProjectConflictResolutionWriteProvenance
}) => {
  return `(
          ${getSqlLiteral(params.id)},
          ${getSqlLiteral(params.comparisonProjectId)},
          ${getSqlLiteral(params.articleId)},
          ${getSqlLiteral(params.promptId)},
          ${getSqlLiteral(params.answerValue)},
          ${getSqlLiteral(params.provenance.reviewerUserId)},
          ${getSqlLiteral(params.provenance.judgmentContextId)},
          ${getSqlLiteral(getServingGenerationValue(params.provenance.servingGeneration))},
          ${getSqlLiteral(getTrimmedText(params.provenance.reviewerDisplayName))},
          ${getSqlLiteral(params.provenance.origin)},
          ${getSqlLiteral(params.provenance.originRef)}
        )`
}

export const getComparisonProjectConflictResolutionOriginRef = (params: {
  sourceComparisonProjectId: string
  sourceResolutionId: string
}) => {
  const prefix = `${params.sourceComparisonProjectId}:`

  return params.sourceResolutionId.startsWith(prefix)
    ? params.sourceResolutionId
    : `${prefix}${params.sourceResolutionId}`
}

export const getTransferReviewerUserId = (displayName: string) => {
  return `${transferReviewerIdPrefix}${createHash('sha256').update(displayName.trim(), 'utf8').digest('hex')}`
}

export const getTransferReviewerDisplayNames = (displayNames: ReadonlyArray<string | null | undefined>) => {
  return Array.from(
    new Set(
      displayNames
        .map((displayName) => {
          return getTrimmedText(displayName)
        })
        .filter((displayName): displayName is string => {
          return displayName !== null
        }),
    ),
  ).sort()
}

export const getUpsertTransferReviewersSql = (displayNames: readonly string[]) => {
  return `
    INSERT INTO app.user_config (id, name, email, role, full_text_conversion_model_id, unpaywall_email)
    VALUES ${displayNames
      .map((displayName) => {
        const reviewerId = getTransferReviewerUserId(displayName)

        return `(
      ${getSqlLiteral(reviewerId)},
      ${getSqlLiteral(displayName.trim())},
      ${getSqlLiteral(`${reviewerId}@transfer.forska.local`)},
      NULL,
      NULL,
      NULL
    )`
      })
      .join(',\n')}
    ON CONFLICT(id) DO NOTHING
  `
}

export const getComparisonProjectConflictResolutionReviewer = (
  row: Pick<ComparisonProjectConflictResolutionProvenanceRow, 'reviewerDisplayName' | 'reviewerUserId'>,
): ComparisonProjectConflictResolutionReviewer | null => {
  return row.reviewerUserId ? {displayName: getTrimmedText(row.reviewerDisplayName), userId: row.reviewerUserId} : null
}

const hasComparisonProjectConflictResolutionProvenance = (row: ComparisonProjectConflictResolutionProvenanceRow) => {
  return Boolean(row.origin || row.judgmentContextId || getServingGenerationValue(row.servingGeneration) !== null)
}

export const getComparisonProjectConflictResolutionProvenance = (
  row: ComparisonProjectConflictResolutionProvenanceRow,
): ComparisonProjectConflictResolutionProvenance | null => {
  return hasComparisonProjectConflictResolutionProvenance(row)
    ? {
        contextId: row.judgmentContextId ?? null,
        generation: getServingGenerationValue(row.servingGeneration),
        origin: getComparisonProjectConflictResolutionOriginValue(row.origin),
        setAt: getDateValue(row.setAt),
      }
    : null
}

export const getComparisonProjectConflictResolutionProvenanceMatchesCurrent = (
  judgmentContextId: string | null | undefined,
  currentJudgmentContextId: string | null | undefined,
) => {
  return judgmentContextId && currentJudgmentContextId ? judgmentContextId === currentJudgmentContextId : null
}

const getComparisonProjectConflictResolutionProvenanceFilterPredicate = (
  filter: ComparisonProjectConflictResolutionProvenanceFilter,
  currentJudgmentContextLiteral: string,
) => {
  return filter === 'current'
    ? `conflict_resolution.judgment_context_id = ${currentJudgmentContextLiteral}`
    : filter === 'outdated'
      ? `conflict_resolution.judgment_context_id <> ${currentJudgmentContextLiteral}`
      : `(conflict_resolution.judgment_context_id IS NULL OR ${currentJudgmentContextLiteral} IS NULL)`
}

export const getComparisonProjectConflictResolutionProvenanceFilterPredicateSql = (params: {
  currentJudgmentContextId: string | null
  filters: readonly ComparisonProjectConflictResolutionProvenanceFilter[]
}) => {
  const currentJudgmentContextLiteral = `CAST(${getSqlLiteral(params.currentJudgmentContextId)} AS VARCHAR)`
  const predicates = params.filters.map((filter) => {
    return getComparisonProjectConflictResolutionProvenanceFilterPredicate(filter, currentJudgmentContextLiteral)
  })

  return predicates.length === 0
    ? 'TRUE'
    : `(article.has_conflict AND conflict_resolution.article_id IS NOT NULL AND (${predicates.join(' OR ')}))`
}
