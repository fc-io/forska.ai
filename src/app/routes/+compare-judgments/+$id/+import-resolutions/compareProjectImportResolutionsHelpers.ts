import type {
  ComparisonProjectConflictResolutionImportAnalyzeRowBase,
  ComparisonProjectConflictResolutionImportAnalyzeSummary,
  ComparisonProjectConflictResolutionImportCommentChange,
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
export type ConflictResolutionImportFileKind = 'json' | 'pdf'

export type AnalyzeImportDisabledState = {hasArtifact: boolean; isAnalyzing: boolean; isCommitting: boolean}

export type CommitImportDisabledState = AnalyzeImportDisabledState & {
  analyzeSucceeded: boolean
  hasCommitted: boolean
  importableCount: number
}

export type ImportSummaryStat = {label: string; value: number; description: string; unit: 'comment' | 'resolution'}

export const conflictResolutionImportInvalidJsonCopy =
  'Could not parse the selected file as JSON. Choose a valid conflict-resolution export file.'

export const getConflictResolutionImportFileKind = (file: File): ConflictResolutionImportFileKind | null => {
  const fileName = file.name.toLowerCase()

  if (file.type === 'application/pdf' || fileName.endsWith('.pdf')) {
    return 'pdf'
  }

  if (file.type === 'application/json' || fileName.endsWith('.json')) {
    return 'json'
  }

  return null
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

export const getCommentCountLabel = (count: number) => {
  return getImportCountLabel(count, 'comment', 'comments')
}

export const getImportSummaryStatValueLabel = (stat: ImportSummaryStat) => {
  return stat.unit === 'comment' ? getCommentCountLabel(stat.value) : getResolutionCountLabel(stat.value)
}

export const getImportCommentChangeCount = (
  summary: Pick<ComparisonProjectConflictResolutionImportAnalyzeSummary, 'commentsAdded' | 'commentsReplaced'>,
) => {
  return summary.commentsAdded + summary.commentsReplaced
}

export const getEmptyImportableRowsLabel = (
  summary: Pick<ComparisonProjectConflictResolutionImportAnalyzeSummary, 'commentsAdded' | 'commentsReplaced'>,
) => {
  const commentChangeCount = getImportCommentChangeCount(summary)

  return commentChangeCount > 0
    ? `No resolutions will be imported. ${getCommentCountLabel(commentChangeCount)} will still be added or replaced from the rows listed under "Rows that will not be imported".`
    : 'No rows will be imported.'
}

export const getImportCommentChangeLabel = (change: ComparisonProjectConflictResolutionImportCommentChange) => {
  const labels: Record<ComparisonProjectConflictResolutionImportCommentChange, string> = {
    add: 'Adds comment',
    keep: 'Keeps target comment',
    replace: 'Replaces comment',
  }

  return labels[change]
}

const getCommentSummaryStats = (
  summary: Pick<
    ComparisonProjectConflictResolutionImportAnalyzeSummary,
    'commentsAdded' | 'commentsKept' | 'commentsReplaced'
  >,
): ImportSummaryStat[] => {
  return [
    {
      label: 'Comments added',
      value: summary.commentsAdded,
      description: 'Conflict comments written where the target article has none.',
      unit: 'comment',
    },
    {
      label: 'Comments replaced',
      value: summary.commentsReplaced,
      description: 'Target comments replaced by different source text. Comments are never removed.',
      unit: 'comment',
    },
    {
      label: 'Comments kept',
      value: summary.commentsKept,
      description: 'Different target comments kept because existing target data is skipped.',
      unit: 'comment',
    },
  ]
}

export const getImportSummaryStats = (
  summary: ComparisonProjectConflictResolutionImportAnalyzeSummary,
): ImportSummaryStat[] => {
  return [
    {
      label: 'Scanned',
      value: summary.scanned,
      description: 'Rows found in the selected export file.',
      unit: 'resolution',
    },
    {
      label: 'Matched',
      value: summary.matched,
      description: 'Source rows matched to target comparison articles.',
      unit: 'resolution',
    },
    {
      label: 'Will import',
      value: summary.importable,
      description: 'Safe saved decisions ready to commit.',
      unit: 'resolution',
    },
    {label: 'Skipped', value: summary.skipped, description: 'Rows not eligible for import.', unit: 'resolution'},
    {
      label: 'Already resolved',
      value: summary.skippedExisting,
      description: 'Rows with an existing target conflict resolution.',
      unit: 'resolution',
    },
    {
      label: 'Same value',
      value: summary.sameValue,
      description: 'Rows already saved with the same conflict-resolution value.',
      unit: 'resolution',
    },
    {
      label: 'Will overwrite',
      value: summary.overwriteCandidates,
      description: 'Existing target decisions that will be replaced when committed.',
      unit: 'resolution',
    },
    {
      label: 'Deduped',
      value: summary.deduped,
      description: 'Duplicate compatible source rows folded into one import.',
      unit: 'resolution',
    },
    ...getCommentSummaryStats(summary),
  ]
}

export const getCommitSummaryStats = (
  summary: ComparisonProjectConflictResolutionImportCommitSummary,
): ImportSummaryStat[] => {
  return [
    {
      label: 'Inserted',
      value: summary.inserted,
      description: 'Saved decisions created in this comparison project.',
      unit: 'resolution',
    },
    {
      label: 'Cleared',
      value: summary.cleared ?? 0,
      description: 'Existing decisions cleared by undecided PDF selections.',
      unit: 'resolution',
    },
    {
      label: 'Skipped',
      value: summary.skipped,
      description: 'Rows the server rechecked and left unchanged.',
      unit: 'resolution',
    },
    ...getCommentSummaryStats(summary),
  ]
}

export const getSkipReasonLabel = (reason: ComparisonProjectConflictResolutionImportSkipReason) => {
  const labels: Record<ComparisonProjectConflictResolutionImportSkipReason, string> = {
    'ambiguous-target-match': 'Ambiguous target match',
    'conflicting-identifiers': 'Conflicting identifiers',
    'conflicting-resolution-values': 'Conflicting resolution values',
    'existing-target-resolution': 'Skipped because target already has a resolution',
    'invalid-target-resolution-value': 'Invalid target resolution value',
    'no-target-match': 'No target match',
    'no-usable-key': 'No usable match key',
    'not-conflicting': 'Target article is not conflicting',
    'same-value': 'Same target resolution',
    'unsupported-mode': 'Unsupported resolution mode',
  }

  return labels[reason]
}

export const getMatchKindLabel = (matchKind: ComparisonProjectConflictResolutionTransferMatchKind | null) => {
  const labels: Record<ComparisonProjectConflictResolutionTransferMatchKind, string> = {
    arxiv: 'arXiv',
    'article-id': 'Article ID',
    'covidence-id-title': 'Covidence ID + title',
    doi: 'DOI',
    'id-title': 'External ID + title',
    pmid: 'PMID',
    title: 'Title',
  }

  return matchKind ? labels[matchKind] : 'Unknown'
}

export const getMatchKeyLabel = (
  matchKind: ComparisonProjectConflictResolutionTransferMatchKind | null,
  matchKey: string | null,
) => {
  return (matchKind === 'id-title' || matchKind === 'covidence-id-title') && matchKey
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
    return 'Choose a valid JSON or PDF export file first.'
  }

  if (state.isAnalyzing) {
    return 'Analyze import is already running.'
  }

  return state.isCommitting ? 'Commit import is running.' : null
}

export const getCommitImportDisabledReason = (state: CommitImportDisabledState) => {
  if (!state.hasArtifact) {
    return 'Choose a valid JSON or PDF export file first.'
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

  return state.importableCount > 0 ? null : 'Analyze found no importable rows or comments.'
}

export const readConflictResolutionImportFile = async (file: File): Promise<ParsedConflictResolutionImportFile> => {
  if (getConflictResolutionImportFileKind(file) !== 'json') {
    throw new Error('Choose a .json or .pdf conflict-resolution export file.')
  }

  try {
    const artifact = JSON.parse(await file.text()) as ComparisonProjectConflictResolutionTransferArtifact

    return {artifact, fileName: file.name, rowCount: Array.isArray(artifact.rows) ? artifact.rows.length : 0}
  } catch {
    throw new Error(conflictResolutionImportInvalidJsonCopy)
  }
}
