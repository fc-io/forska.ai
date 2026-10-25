export const comparisonProjectCovidenceExportAnswerOptions = ['yes', 'no', 'maybe'] as const

export type ComparisonProjectCovidenceExportColumnSelection = {columnId: string; values: string[]}

export type ComparisonProjectCovidenceExportRequest = {
  columnSelections: ComparisonProjectCovidenceExportColumnSelection[]
  conflictResolutionValues?: string[]
}

export type ComparisonProjectCovidenceExportSelection = {
  columnSelections: ComparisonProjectCovidenceExportColumnSelection[]
  conflictResolutionValues: string[]
}

export type ComparisonProjectCovidenceExportCandidateRow = {
  canonicalArticleId: string
  cells: Record<string, string | null>
  conflictResolution?: {label: string} | null
}

type ComparisonProjectCovidenceExportSelectionScope = {allowConflictResolution: boolean; columnIds: readonly string[]}

export const getNormalizedComparisonProjectCovidenceExportAnswer = (value: string) => {
  return value.trim().toLowerCase()
}

const getNormalizedComparisonProjectCovidenceExportValues = (values: readonly string[]) => {
  return Array.from(
    new Set(
      values.map(getNormalizedComparisonProjectCovidenceExportAnswer).filter((value) => {
        return value !== ''
      }),
    ),
  )
}

const getComparisonProjectCovidenceExportCellAnswers = (value: string | null | undefined) => {
  return getNormalizedComparisonProjectCovidenceExportValues((value ?? '').split('\n'))
}

const getComparisonProjectCovidenceExportValuesByColumnId = (
  columnSelections: readonly ComparisonProjectCovidenceExportColumnSelection[],
  columnIds: readonly string[],
) => {
  const knownColumnIds = new Set(columnIds)

  return columnSelections
    .filter((columnSelection) => {
      return knownColumnIds.has(columnSelection.columnId)
    })
    .reduce<Map<string, string[]>>((valuesByColumnId, columnSelection) => {
      valuesByColumnId.set(columnSelection.columnId, [
        ...(valuesByColumnId.get(columnSelection.columnId) ?? []),
        ...columnSelection.values,
      ])
      return valuesByColumnId
    }, new Map<string, string[]>())
}

export const getNormalizedComparisonProjectCovidenceExportSelection = (
  request: ComparisonProjectCovidenceExportRequest,
  scope: ComparisonProjectCovidenceExportSelectionScope,
): ComparisonProjectCovidenceExportSelection => {
  const valuesByColumnId = getComparisonProjectCovidenceExportValuesByColumnId(
    request.columnSelections,
    scope.columnIds,
  )

  return {
    columnSelections: Array.from(valuesByColumnId.entries())
      .map(([columnId, values]) => {
        return {columnId, values: getNormalizedComparisonProjectCovidenceExportValues(values)}
      })
      .filter((columnSelection) => {
        return columnSelection.values.length > 0
      }),
    conflictResolutionValues: scope.allowConflictResolution
      ? getNormalizedComparisonProjectCovidenceExportValues(request.conflictResolutionValues ?? [])
      : [],
  }
}

export const getHasComparisonProjectCovidenceExportSelection = (
  selection: ComparisonProjectCovidenceExportSelection,
) => {
  return selection.columnSelections.length > 0 || selection.conflictResolutionValues.length > 0
}

const getHasSelectedColumnAnswer = (
  row: ComparisonProjectCovidenceExportCandidateRow,
  selection: ComparisonProjectCovidenceExportSelection,
) => {
  return selection.columnSelections.some((columnSelection) => {
    return getComparisonProjectCovidenceExportCellAnswers(row.cells[columnSelection.columnId]).some((answer) => {
      return columnSelection.values.includes(answer)
    })
  })
}

const getHasSelectedConflictResolution = (
  row: ComparisonProjectCovidenceExportCandidateRow,
  selection: ComparisonProjectCovidenceExportSelection,
) => {
  const label = row.conflictResolution?.label

  return (
    label !== undefined
    && selection.conflictResolutionValues.includes(getNormalizedComparisonProjectCovidenceExportAnswer(label))
  )
}

export const getIsComparisonProjectCovidenceExportRowSelected = (
  row: ComparisonProjectCovidenceExportCandidateRow,
  selection: ComparisonProjectCovidenceExportSelection,
) => {
  return getHasSelectedColumnAnswer(row, selection) || getHasSelectedConflictResolution(row, selection)
}

export const getComparisonProjectCovidenceExportSelectedRows = <
  TRow extends ComparisonProjectCovidenceExportCandidateRow,
>(
  rows: readonly TRow[],
  selection: ComparisonProjectCovidenceExportSelection,
  exportedArticleIds: ReadonlySet<string> = new Set<string>(),
) => {
  const seenArticleIds = new Set(exportedArticleIds)

  return rows.filter((row) => {
    const isSelected =
      !seenArticleIds.has(row.canonicalArticleId) && getIsComparisonProjectCovidenceExportRowSelected(row, selection)

    if (isSelected) {
      seenArticleIds.add(row.canonicalArticleId)
    }

    return isSelected
  })
}
