import {type RowSelectionState} from '@tanstack/solid-table'

export const getTableRowSelectionState = (rowSelection: Record<string, boolean>): RowSelectionState => {
  return Object.fromEntries(
    Object.entries(rowSelection)
      .filter(([, isSelected]) => {
        return isSelected
      })
      .map(([rowId]) => {
        return [rowId, true] as const
      }),
  )
}
