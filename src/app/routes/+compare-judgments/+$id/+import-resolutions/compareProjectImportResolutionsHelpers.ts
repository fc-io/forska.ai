import type {
  ComparisonProjectConflictResolutionImportAnalyzeRowBase,
  ComparisonProjectConflictResolutionImportAnalyzeSummary,
  ComparisonProjectConflictResolutionImportCommitSummary,
  ComparisonProjectConflictResolutionImportSkipReason,
  ComparisonProjectConflictResolutionTransferArtifact,
  ComparisonProjectConflictResolutionTransferMatchKind,
} from '../../../../../services/comparisonProjectsService.ts'

export type ParsedConflictResolutionImportFile = {
  artifact: ComparisonProjectConflictResolutionTransferArtifact
  fileName: string
  rowCount: number
}

export type AnalyzeImportDisabledState = {hasArtifact: boolean; isAnalyzing: boolean; isCommitting: boolean}

export type CommitImportDisabledState = AnalyzeImportDisabledState & {
  analyzeSucceeded: boolean
  hasCommitted: boolean
  importableCount: number
}

export type ImportSummaryStat = {label: string; value: number; description: string}

export const conflictResolutionImportInvalidJsonCopy =
  'Could not parse the selected file as JSON. Choose a valid conflict-resolution export file.'

const getJsonFileExtensionError = (fileName: string) => {
  return fileName.toLowerCase().endsWith('.json') ? null : 'Choose a .json conflict-resolution export file.'
}

export const getOptionalImportValueLabel = (value: string | null | undefined) => {
  return value && value.trim().length > 0 ? value : 'Unknown'
}

const getImportCountLabel = (count: number, singular: string, plural: string) => {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`
}

export const getResolutionCountLabel = (count: number) => {
  return getImportCountLabel(count, 'resolution', 'resolutions')
}

export const getRowCountLabel = (count: number) => {
  return getImportCountLabel(count, 'row', 'rows')
}

export const getImportSummaryStats = (
  summary: ComparisonProjectConflictResolutionImportAnalyzeSummary,
): ImportSummaryStat[] => {
  return [
    {label: 'Scanned', value: summary.scanned, description: 'Rows found in the selected export file.'},
    {label: 'Matched', value: summary.matched, description: 'Source rows matched to target comparison articles.'},
    {label: 'Will import', value: summary.importable, description: 'Safe saved decisions ready to commit.'},
    {label: 'Skipped', value: summary.skipped, description: 'Rows not eligible for import.'},
    {
      label: 'Already resolved',
      value: summary.skippedExisting,
      description: 'Rows with an existing target conflict resolution.',
    },
    {label: 'Deduped', value: summary.deduped, description: 'Duplicate compatible source rows folded into one import.'},
  ]
}

export const getCommitSummaryStats = (
  summary: ComparisonProjectConflictResolutionImportCommitSummary,
): ImportSummaryStat[] => {
  return [
    {label: 'Inserted', value: summary.inserted, description: 'Saved decisions created in this comparison project.'},
    {label: 'Skipped', value: summary.skipped, description: 'Rows the server rechecked and left unchanged.'},
  ]
}

export const getSkipReasonLabel = (reason: ComparisonProjectConflictResolutionImportSkipReason) => {
  const labels: Record<ComparisonProjectConflictResolutionImportSkipReason, string> = {
    'ambiguous-target-match': 'Ambiguous target match',
    'conflicting-identifiers': 'Conflicting identifiers',
    'conflicting-resolution-values': 'Conflicting resolution values',
    'existing-target-resolution': 'Existing target resolution',
    'invalid-target-resolution-value': 'Invalid target resolution value',
    'no-target-match': 'No target match',
    'no-usable-key': 'No usable match key',
    'not-conflicting': 'Target article is not conflicting',
    'unsupported-mode': 'Unsupported resolution mode',
  }

  return labels[reason]
}

export const getMatchKindLabel = (matchKind: ComparisonProjectConflictResolutionTransferMatchKind | null) => {
  const labels: Record<ComparisonProjectConflictResolutionTransferMatchKind, string> = {
    arxiv: 'arXiv',
    doi: 'DOI',
    'id-title': 'External ID + title',
    pmid: 'PMID',
  }

  return matchKind ? labels[matchKind] : 'Unknown'
}

export const getMatchKeyLabel = (
  matchKind: ComparisonProjectConflictResolutionTransferMatchKind | null,
  matchKey: string | null,
) => {
  return matchKind === 'id-title' && matchKey
    ? matchKey.split(String.fromCharCode(31)).join(' / ')
    : getOptionalImportValueLabel(matchKey)
}

export const getArticleIdListLabel = (values: readonly string[]) => {
  return values.length > 0 ? values.join(', ') : 'Unknown'
}

export const getTargetArticleIds = (row: ComparisonProjectConflictResolutionImportAnalyzeRowBase) => {
  return row.targetArticleIds.length > 0 ? row.targetArticleIds : row.targetArticleId ? [row.targetArticleId] : []
}

export const getTargetExternalArticleIds = (row: ComparisonProjectConflictResolutionImportAnalyzeRowBase) => {
  return row.targetExternalArticleIds.length > 0
    ? row.targetExternalArticleIds
    : row.targetExternalArticleId
      ? [row.targetExternalArticleId]
      : []
}

export const getAnalyzeImportDisabledReason = (state: AnalyzeImportDisabledState) => {
  if (!state.hasArtifact) {
    return 'Choose a valid JSON export file first.'
  }

  if (state.isAnalyzing) {
    return 'Analyze import is already running.'
  }

  return state.isCommitting ? 'Commit import is running.' : null
}

export const getCommitImportDisabledReason = (state: CommitImportDisabledState) => {
  if (!state.hasArtifact) {
    return 'Choose a valid JSON export file first.'
  }

  if (state.isAnalyzing) {
    return 'Analyze import is still running.'
  }

  if (state.isCommitting) {
    return 'Commit import is already running.'
  }

  if (state.hasCommitted) {
    return 'Import has already been committed.'
  }

  if (!state.analyzeSucceeded) {
    return 'Analyze the import before committing.'
  }

  return state.importableCount > 0 ? null : 'Analyze found no importable rows.'
}

export const readConflictResolutionImportFile = async (file: File): Promise<ParsedConflictResolutionImportFile> => {
  const extensionError = getJsonFileExtensionError(file.name)

  if (extensionError) {
    throw new Error(extensionError)
  }

  try {
    const artifact = JSON.parse(await file.text()) as ComparisonProjectConflictResolutionTransferArtifact

    return {artifact, fileName: file.name, rowCount: Array.isArray(artifact.rows) ? artifact.rows.length : 0}
  } catch {
    throw new Error(conflictResolutionImportInvalidJsonCopy)
  }
}
