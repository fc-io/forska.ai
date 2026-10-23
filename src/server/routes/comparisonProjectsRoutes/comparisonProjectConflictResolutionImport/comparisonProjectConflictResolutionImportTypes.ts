import type {HumanJudgmentMode} from '../../../../db/schemaTypes.ts'
import type {ArticleStrongIdentifierKind} from '../../../../utils/articleIdentifierNormalization.ts'

export type ComparisonProjectConflictResolutionImportMatchKind =
  | ArticleStrongIdentifierKind
  | 'article-id'
  | 'covidence-id-title'
  | 'id-title'
  | 'title'

export type ComparisonProjectConflictResolutionImportIdentifier = {
  kind: ArticleStrongIdentifierKind
  normalizedValue: string
}

export type ComparisonProjectConflictResolutionImportSourceProvenance = {
  judgmentContextId: string | null
  reviewerDisplayName: string | null
  reviewerUserId: string | null
}

export type ComparisonProjectConflictResolutionImportSourceRow = {
  arxivId?: string | null
  doi?: string | null
  doiKeys?: readonly (string | null | undefined)[] | null
  externalArticleId?: string | null
  identifierKeys?: readonly (string | null | undefined)[] | null
  identifiers?: readonly ComparisonProjectConflictResolutionImportIdentifier[] | null
  pubmedId?: string | null
  resolutionMode?: HumanJudgmentMode | null
  resolutionValue: string | null
  sourceArticleId: string
  sourceArticleTitle?: string | null
  sourceComment?: string | null
  sourceCommentAuthorDisplayName?: string | null
  sourceCommentAuthorUserId?: string | null
  sourceComparisonProjectId: string
  sourceComparisonProjectName: string
  sourceExternalArticleId?: string | null
  sourceProvenance?: ComparisonProjectConflictResolutionImportSourceProvenance | null
  sourceResolutionId: string
  sourceRowId: string
  title?: string | null
}

export type ComparisonProjectConflictResolutionImportTargetArticle = {
  articleId: string
  arxivId?: string | null
  doi?: string | null
  doiKeys?: readonly (string | null | undefined)[] | null
  externalArticleId?: string | null
  hasExistingResolution?: boolean
  existingResolutionValue?: string | null
  identifierKeys?: readonly (string | null | undefined)[] | null
  identifiers?: readonly ComparisonProjectConflictResolutionImportIdentifier[] | null
  legacyDoi?: string | null
  isConflictResolutionEligible: boolean
  pubmedId?: string | null
  title?: string | null
}

export type ComparisonProjectConflictResolutionImportMode = 'all-matched' | 'conflicting-only'
export type ComparisonProjectConflictResolutionImportOverwriteMode = 'skip-existing' | 'overwrite-different'

export type ComparisonProjectConflictResolutionImportCandidateSource = {
  matchKey: string
  matchKind: ComparisonProjectConflictResolutionImportMatchKind
  sourceRowId: string
}

export type ComparisonProjectConflictResolutionImportCandidate = {
  resolutionValue: string | null
  sourceRows: ComparisonProjectConflictResolutionImportCandidateSource[]
  targetArticleId: string
}

export type ComparisonProjectConflictResolutionImportSkipReason =
  | 'ambiguous-target-match'
  | 'conflicting-identifiers'
  | 'conflicting-resolution-values'
  | 'existing-target-resolution'
  | 'invalid-target-resolution-value'
  | 'no-usable-key'
  | 'no-target-match'
  | 'not-conflicting'
  | 'same-value'
  | 'unsupported-mode'

export type ComparisonProjectConflictResolutionImportSkippedRow = {
  reason: ComparisonProjectConflictResolutionImportSkipReason
  sourceRowId: string
}

export type ComparisonProjectConflictResolutionImportSkipCounts = {
  ambiguousTarget: number
  conflictingIdentifiers: number
  conflicting: number
  existingTargetResolution: number
  invalidValue: number
  noTargetMatch: number
  noUsableKey: number
  notConflicting: number
  unsupportedMode: number
  sameValue: number
}

export type ComparisonProjectConflictResolutionImportErrorCode =
  | 'duplicate-source-doi-key'
  | 'duplicate-source-id-title-key'
  | 'conflicting-source-resolution-values'
  | 'invalid-source-resolution-value'

export type ComparisonProjectConflictResolutionImportError = {
  code: ComparisonProjectConflictResolutionImportErrorCode
  key?: string
  message: string
  sourceRowIds?: string[]
  targetArticleId?: string
  targetArticleIds?: string[]
  value?: string
  values?: string[]
}

export type ComparisonProjectConflictResolutionImportWarningCode =
  | 'ambiguous-target-match'
  | 'conflicting-identifiers'
  | 'conflicting-resolution-values'
  | 'invalid-target-resolution-value'

export type ComparisonProjectConflictResolutionImportWarningSourceRow = {
  articleId: string
  articleTitle: string | null
  compareProjectId: string
  compareProjectName: string
  externalArticleId: string | null
  resolutionAnswer: string
  sourceResolutionId: string
  sourceRowId: string
}

export type ComparisonProjectConflictResolutionImportWarningTargetArticle = {
  articleId: string
  articleTitle: string | null
  doiKeys: string[]
  externalArticleId: string | null
  identifierKeys: string[]
}

export type ComparisonProjectConflictResolutionImportWarning = {
  code: ComparisonProjectConflictResolutionImportWarningCode
  matchKey?: string
  matchKeys?: string[]
  matchKind?: ComparisonProjectConflictResolutionImportMatchKind
  matchKinds?: ComparisonProjectConflictResolutionImportMatchKind[]
  message: string
  sourceRows: ComparisonProjectConflictResolutionImportWarningSourceRow[]
  targetArticles: ComparisonProjectConflictResolutionImportWarningTargetArticle[]
  value?: string
  values?: string[]
}

export type ComparisonProjectConflictResolutionImportCommentSource = {
  authorDisplayName: string | null
  authorUserId: string | null
  comment: string
  sourceRowId: string
  targetArticleId: string
}

export type ComparisonProjectConflictResolutionImportCommentChangeKind = 'add' | 'keep' | 'replace'

export type ComparisonProjectConflictResolutionImportCommentChange =
  ComparisonProjectConflictResolutionImportCommentSource & {
    change: ComparisonProjectConflictResolutionImportCommentChangeKind
  }

export type ComparisonProjectConflictResolutionImportPlan = {
  candidates: ComparisonProjectConflictResolutionImportCandidate[]
  commentSources: ComparisonProjectConflictResolutionImportCommentSource[]
  dedupedCount: number
  errors: ComparisonProjectConflictResolutionImportError[]
  skipCounts: ComparisonProjectConflictResolutionImportSkipCounts
  skippedRows: ComparisonProjectConflictResolutionImportSkippedRow[]
  warnings: ComparisonProjectConflictResolutionImportWarning[]
}

export type ComparisonProjectConflictResolutionImportPlanParams = {
  importMode?: ComparisonProjectConflictResolutionImportMode
  overwriteMode?: ComparisonProjectConflictResolutionImportOverwriteMode
  sourceRows: readonly ComparisonProjectConflictResolutionImportSourceRow[]
  targetArticles: readonly ComparisonProjectConflictResolutionImportTargetArticle[]
  targetSummaryOptionValues: readonly string[]
}
