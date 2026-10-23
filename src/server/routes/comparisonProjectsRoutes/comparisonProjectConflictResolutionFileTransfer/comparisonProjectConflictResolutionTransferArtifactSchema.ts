import {type as arktype} from 'arktype'

import {comparisonProjectConflictResolutionTransferFormat} from './comparisonProjectConflictResolutionTransferFormat.ts'

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
  resolution: TransferResolution.or('null'),
  'provenance?': TransferProvenance.or('null'),
  'comment?': 'string | null',
})
const TransferSource = arktype({
  comparisonProjectId: 'string',
  comparisonProjectName: 'string',
  comparisonProjectDescription: 'string | null',
})

export const comparisonProjectConflictResolutionTransferArtifactSchema = arktype({
  format: arktype(`"${comparisonProjectConflictResolutionTransferFormat}"`),
  version: '1 | 2 | 3',
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
