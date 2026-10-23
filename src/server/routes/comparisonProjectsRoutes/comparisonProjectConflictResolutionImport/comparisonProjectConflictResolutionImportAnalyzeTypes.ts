import type {
  ComparisonProjectConflictResolutionImportCommentChangeKind,
  ComparisonProjectConflictResolutionImportMatchKind,
  ComparisonProjectConflictResolutionImportSkipReason,
  ComparisonProjectConflictResolutionImportWarning,
} from './comparisonProjectConflictResolutionImportTypes.ts'

export type ComparisonProjectConflictResolutionImportSummary = {
  deduped: number
  scanned: number
  matched: number
  imported: number
  skipped: number
  skippedAmbiguousTarget: number
  skippedConflictingIdentifiers: number
  skippedConflicting: number
  skippedExistingTargetResolution: number
  skippedInvalidValue: number
  skippedNoTargetMatch: number
  skippedNoUsableKey: number
  skippedNotConflicting: number
  skippedUnsupportedMode: number
  sameValue: number
  overwriteCandidates: number
  warnings: ComparisonProjectConflictResolutionImportWarning[]
}

export type ComparisonProjectConflictResolutionImportAnalyzeSource = {
  comparisonProjectId: string
  comparisonProjectName: string
  comparisonProjectDescription: string | null
  exportedAt: string
  format: string
  importKind?: 'json' | 'pdf'
  pdfUndecidedMode?: 'clear' | 'ignore'
  pdfUndecidedRowCount?: number
  pdfWarnings?: string[]
  reviewer?: {displayName: string | null; instanceId: string | null}
  version: number
  rowCount: number
}

export type ComparisonProjectConflictResolutionImportAnalyzeSummary = {
  scanned: number
  matched: number
  importable: number
  deduped: number
  skipped: number
  skippedExisting: number
  skippedUnsupportedMode: number
  skippedNoUsableKey: number
  skippedNoTargetMatch: number
  skippedNotConflicting: number
  skippedAmbiguousTarget: number
  skippedConflicting: number
  skippedInvalidValue: number
  sameValue: number
  overwriteCandidates: number
  commentsAdded: number
  commentsKept: number
  commentsReplaced: number
}

export type ComparisonProjectConflictResolutionImportAnalyzeRowReason =
  | 'importable'
  | 'same-value'
  | 'overwrite-candidate'
  | ComparisonProjectConflictResolutionImportSkipReason

export type ComparisonProjectConflictResolutionImportAnalyzeRow = {
  sourceTitle: string | null
  sourceArticleRowId: string
  sourceExternalArticleId: string | null
  sourceResolutionId: string
  sourceComparisonProjectId: string
  sourceComparisonProjectName: string
  targetTitle: string | null
  targetArticleId: string | null
  targetArticleIds: string[]
  targetExternalArticleId: string | null
  targetExternalArticleIds: string[]
  selectedResolution: string
  matchKind: ComparisonProjectConflictResolutionImportMatchKind | null
  matchKey: string | null
  reason: ComparisonProjectConflictResolutionImportAnalyzeRowReason
  commentChange?: ComparisonProjectConflictResolutionImportCommentChangeKind
}

export type ComparisonProjectConflictResolutionImportAnalyzeResult = {
  source: ComparisonProjectConflictResolutionImportAnalyzeSource
  summary: ComparisonProjectConflictResolutionImportAnalyzeSummary
  importableRows: ComparisonProjectConflictResolutionImportAnalyzeRow[]
  skippedRows: ComparisonProjectConflictResolutionImportAnalyzeRow[]
  warnings: ComparisonProjectConflictResolutionImportWarning[]
}

export type ComparisonProjectConflictResolutionImportCommitSummary =
  ComparisonProjectConflictResolutionImportAnalyzeSummary & {cleared: number; inserted: number}

export type ComparisonProjectConflictResolutionImportCommitResult = Omit<
  ComparisonProjectConflictResolutionImportAnalyzeResult,
  'summary'
> & {summary: ComparisonProjectConflictResolutionImportCommitSummary}
