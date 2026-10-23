import type {HumanJudgmentMode} from '../../../../db/schemaTypes.ts'
import type {ComparisonProjectConflictResolutionTransferIdentifierV1} from '../comparisonProjectConflictResolutionFileTransfer.ts'

export type ParsedPdfConflictResolutionImportArticle = {
  fieldName: string
  sourceArticleRowId: string | null
  canonicalArticleId: string | null
  externalArticleId: string | null
  title: string | null
  identifiers: ComparisonProjectConflictResolutionTransferIdentifierV1[]
}

export type ParsedPdfConflictResolutionImport = {
  source: {
    comparisonProjectId: string | null
    comparisonProjectName: string | null
    exportedAt: string | null
    formatVersion: number | null
    humanJudgmentMode: HumanJudgmentMode | null
    judgmentContextId?: string | null
  }
  reviewer: {displayName: string | null; instanceId: null}
  rows: Array<ParsedPdfConflictResolutionImportArticle & {resolutionValue: string; comment: string | null}>
  undecidedRows: Array<
    ParsedPdfConflictResolutionImportArticle & {resolutionValue: typeof pdfConflictResolutionNotSetValue}
  >
  commentOnlyRows: Array<ParsedPdfConflictResolutionImportArticle & {resolutionValue: null; comment: string}>
  warnings: string[]
}

export const pdfConflictResolutionNotSetValue = '__forska_conflict_resolution_not_set__'
