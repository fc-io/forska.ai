import type {HumanJudgmentMode} from '../../../../db/schemaTypes.ts'
import type {ArticleStrongIdentifierKind} from '../../../../utils/articleIdentifierNormalization.ts'
import {sourceIdentifierTierOrder} from './comparisonProjectConflictResolutionImportConstants.ts'
import type {
  ComparisonProjectConflictResolutionImportMatchKind,
  ComparisonProjectConflictResolutionImportSkippedRow,
  ComparisonProjectConflictResolutionImportSourceRow,
  ComparisonProjectConflictResolutionImportTargetArticle,
  ComparisonProjectConflictResolutionImportWarning,
} from './comparisonProjectConflictResolutionImportTypes.ts'

export type NormalizedSourceRow = Omit<
  ComparisonProjectConflictResolutionImportSourceRow,
  'doiKeys' | 'identifierKeys' | 'resolutionMode'
> & {
  covidenceIdTitleKey: string | null
  doiKeys: string[]
  identifierKeys: NormalizedIdentifierKey[]
  idTitleKey: string | null
  resolutionMode: HumanJudgmentMode
  resolutionValue: string | null
  titleKey: string | null
}

export type NormalizedTargetArticle = Omit<
  ComparisonProjectConflictResolutionImportTargetArticle,
  'doiKeys' | 'identifierKeys'
> & {
  covidenceIdTitleKey: string | null
  doiKeys: string[]
  identifierKeys: NormalizedIdentifierKey[]
  idTitleKey: string | null
  titleKey: string | null
}

export type ImportCandidateRow = {
  isOverwrite: boolean
  matchKey: string
  matchKind: ComparisonProjectConflictResolutionImportMatchKind
  resolutionValue: string | null
  sourceRow: NormalizedSourceRow
  sourceRowId: string
  targetArticle: NormalizedTargetArticle
  targetArticleId: string
}

export type ImportTargetArticleMatch = {
  identifierKey?: NormalizedIdentifierKey
  matchKey: string
  matchKind: ComparisonProjectConflictResolutionImportMatchKind
  targetArticle: NormalizedTargetArticle
}

export type ImportCandidateRowResult = {
  candidate: ImportCandidateRow | null
  detail: ImportRowMatchDetail | null
  skippedRow: ComparisonProjectConflictResolutionImportSkippedRow | null
  warnings: ComparisonProjectConflictResolutionImportWarning[]
}

export type ImportRowMatchDetail = {
  matchKey: string | null
  matchKind: ComparisonProjectConflictResolutionImportMatchKind | null
  sourceRow: NormalizedSourceRow
  targetArticles: NormalizedTargetArticle[]
}

export type SourceIdentifierTier = (typeof sourceIdentifierTierOrder)[number]

export type NormalizedIdentifierKey = {
  key: string
  kind: ArticleStrongIdentifierKind
  matchKey: string
  normalizedValue: string
  tier?: SourceIdentifierTier
}
