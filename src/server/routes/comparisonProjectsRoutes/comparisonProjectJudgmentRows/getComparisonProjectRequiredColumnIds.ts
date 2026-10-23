import type {ComparisonProjectDifferenceColumn} from '../../../../utils/comparisonProjectDifferenceFilter.ts'

export const getComparisonProjectRequiredColumnIds = (
  columns: readonly ComparisonProjectDifferenceColumn[],
  kind: ComparisonProjectDifferenceColumn['kind'],
) => {
  return new Set(
    columns
      .filter((column) => {
        return column.kind === kind
      })
      .map((column) => {
        return column.id
      }),
  )
}
