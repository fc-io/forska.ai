import {getJsonValue, getSqlLiteral} from '../../services/appQueryHelpers.ts'

const defaultTrackingReconcileScheduleMonths = [3, 12, 24, 36]
const maxTrackingReconcileScheduleMonth = 120

export const getTrackingReconcileScheduleMonths = (value: unknown): number[] => {
  const parsed = getJsonValue(value)

  if (!Array.isArray(parsed)) {
    return defaultTrackingReconcileScheduleMonths
  }

  const months = Array.from(
    new Set(
      parsed.filter((entry): entry is number => {
        return Number.isInteger(entry) && entry > 0 && entry <= maxTrackingReconcileScheduleMonth
      }),
    ),
  )

  return months.length > 0
    ? months.sort((left, right) => {
        return left - right
      })
    : defaultTrackingReconcileScheduleMonths
}

export const normalizeTrackingReconcileScheduleMonthsForWrite = (months?: number[]) => {
  if (months === undefined || months.length === 0) {
    return defaultTrackingReconcileScheduleMonths
  }

  for (const month of months) {
    if (!Number.isInteger(month) || month <= 0 || month > maxTrackingReconcileScheduleMonth) {
      throw new Error(
        `Reconciliation schedule months must be integers between 1 and ${maxTrackingReconcileScheduleMonth}`,
      )
    }
  }

  return Array.from(new Set(months)).sort((left, right) => {
    return left - right
  })
}

export const getTrackingReconcileScheduleMonthsSqlLiteral = (months?: number[]) => {
  return getSqlLiteral(JSON.stringify(normalizeTrackingReconcileScheduleMonthsForWrite(months)))
}
