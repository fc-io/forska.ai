import {getDateValue, getJsonValue} from '../../services/appQueryHelpers.ts'
import type {PromptSelection} from './comparisonProjectRouteTypes.ts'

export const getRequestedPositiveInteger = (value: string | number | null | undefined, fallback: number) => {
  const parsedValue = Number.parseInt(String(value ?? ''), 10)

  return Number.isNaN(parsedValue) ? fallback : parsedValue
}

export const getRequiredDateValue = (value: unknown) => {
  const parsedDate = getDateValue(value)
  return parsedDate ?? new Date(0)
}

export const getStringArrayRowValue = <TRow extends Record<string, unknown>>(row: TRow, key: keyof TRow) => {
  const value = getJsonValue(row[key])
  return Array.isArray(value)
    ? value.filter((entry): entry is string => {
        return typeof entry === 'string'
      })
    : null
}

export const isDefined = <T>(value: T | null | undefined): value is T => {
  return value !== null && value !== undefined
}

export const getUniqueStringValues = (values: string[]) => {
  return Array.from(
    new Set(
      values
        .map((value) => {
          return value.trim()
        })
        .filter((value) => {
          return value !== ''
        }),
    ),
  )
}

export const getUniquePromptSelections = (promptSelections: PromptSelection[]) => {
  const uniqueSelections = promptSelections.reduce<Map<string, PromptSelection>>((selectionMap, selection) => {
    if (!selectionMap.has(selection.promptId)) {
      selectionMap.set(selection.promptId, selection)
    }

    return selectionMap
  }, new Map<string, PromptSelection>())

  return Array.from(uniqueSelections.values()).sort((left, right) => {
    return left.order - right.order
  })
}

export const getPromptLabel = (promptHeading: string | null, order: number) => {
  const trimmedHeading = promptHeading?.trim() ?? ''

  return trimmedHeading || `Prompt ${order + 1}`
}
