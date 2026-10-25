import {
  type ComparisonProjectCovidenceExportSelection,
  getNormalizedComparisonProjectCovidenceExportAnswer,
} from '../../../../../utils/comparisonProjectCovidenceExportSelection.ts'
import {getIsSameComparisonProjectFilterSelection} from '../../../../../utils/comparisonProjectFilterSelection.ts'

export type CompareProjectCovidenceExportUrlSelection = {
  columnValues: Record<string, string[]>
  conflictResolutionValues: string[]
}

type CompareProjectCovidenceExportSearchValue = {columns?: Record<string, string[]>; conflictResolution?: string[]}

const compareProjectCovidenceExportSearchParam = 'covidenceExport'

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getSearchValues = (value: unknown, normalize: (value: string) => string) => {
  const values = Array.isArray(value) ? value : []

  return Array.from(
    new Set(
      values
        .filter((entry): entry is string => {
          return typeof entry === 'string'
        })
        .map(normalize)
        .filter((entry) => {
          return entry !== ''
        }),
    ),
  )
}

const getTrimmedValue = (value: string) => {
  return value.trim()
}

const getNonEmptyColumnValues = (columnValues: Record<string, string[]>) => {
  return Object.fromEntries(
    Object.entries(columnValues).filter(([, values]) => {
      return values.length > 0
    }),
  )
}

export const getEmptyCompareProjectCovidenceExportSelection = (): CompareProjectCovidenceExportUrlSelection => {
  return {columnValues: {}, conflictResolutionValues: []}
}

export const getInitialCompareProjectCovidenceExportSelection = (
  search: Record<string, unknown>,
): CompareProjectCovidenceExportUrlSelection => {
  const searchValue = search[compareProjectCovidenceExportSearchParam]
  const record = isRecord(searchValue) ? searchValue : {}
  const columns = isRecord(record.columns) ? record.columns : {}

  return {
    columnValues: getNonEmptyColumnValues(
      Object.fromEntries(
        Object.entries(columns).map(([columnId, values]) => {
          return [columnId, getSearchValues(values, getNormalizedComparisonProjectCovidenceExportAnswer)]
        }),
      ),
    ),
    conflictResolutionValues: getSearchValues(record.conflictResolution, getTrimmedValue),
  }
}

export const getCompareProjectCovidenceExportSearchParams = (
  selection: CompareProjectCovidenceExportUrlSelection,
): Record<string, CompareProjectCovidenceExportSearchValue> => {
  const columns = getNonEmptyColumnValues(selection.columnValues)
  const searchValue: CompareProjectCovidenceExportSearchValue = {
    ...(Object.keys(columns).length > 0 ? {columns} : {}),
    ...(selection.conflictResolutionValues.length > 0 ? {conflictResolution: selection.conflictResolutionValues} : {}),
  }

  return Object.keys(searchValue).length > 0 ? {[compareProjectCovidenceExportSearchParam]: searchValue} : {}
}

export const getCompareProjectCovidenceExportRequestBody = (
  selection: CompareProjectCovidenceExportUrlSelection,
  columns: readonly {id: string}[],
  allowConflictResolution: boolean,
): ComparisonProjectCovidenceExportSelection => {
  return {
    columnSelections: columns
      .map((column) => {
        return {columnId: column.id, values: selection.columnValues[column.id] ?? []}
      })
      .filter((columnSelection) => {
        return columnSelection.values.length > 0
      }),
    conflictResolutionValues: allowConflictResolution ? selection.conflictResolutionValues : [],
  }
}

export const getCompareProjectCovidenceExportSelectionWithColumnValues = (
  selection: CompareProjectCovidenceExportUrlSelection,
  columnId: string,
  values: readonly string[],
): CompareProjectCovidenceExportUrlSelection => {
  return getIsSameComparisonProjectFilterSelection(selection.columnValues[columnId] ?? [], values)
    ? selection
    : {...selection, columnValues: getNonEmptyColumnValues({...selection.columnValues, [columnId]: [...values]})}
}

export const getCompareProjectCovidenceExportSelectionWithConflictResolutionValues = (
  selection: CompareProjectCovidenceExportUrlSelection,
  values: readonly string[],
): CompareProjectCovidenceExportUrlSelection => {
  return getIsSameComparisonProjectFilterSelection(selection.conflictResolutionValues, values)
    ? selection
    : {...selection, conflictResolutionValues: [...values]}
}
