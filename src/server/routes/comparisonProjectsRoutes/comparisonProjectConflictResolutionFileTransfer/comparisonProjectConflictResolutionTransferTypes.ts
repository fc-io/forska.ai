import type {HumanJudgmentMode} from '../../../../db/schemaTypes.ts'

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
  sourceResolutionId: string | null
  title?: string | null
  url?: string | null
  resolutionLabel: string | null
  resolutionMode: HumanJudgmentMode
  resolutionValue: string | null
  provenanceContextId?: string | null
  provenanceOrigin?: string | null
  provenanceReviewerDisplayName?: string | null
  provenanceSetAt?: Date | string | null
  comment?: string | null
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
  comment?: string | null
}

export type ComparisonProjectConflictResolutionTransferRowV3 = Omit<
  ComparisonProjectConflictResolutionTransferRowV2,
  'resolution'
> & {resolution: ComparisonProjectConflictResolutionTransferResolutionV1 | null}

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
