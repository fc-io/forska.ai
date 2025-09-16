export const CRON_INTERVAL_MS = 15_000
export const P95_TARGET_MS = Math.floor((CRON_INTERVAL_MS * 2) / 3)
export const MAX_BATCH = 16
export const MIN_BATCH = 1

let currentBatch = 1
let nextAllowedRunAt: number | null = null

export const getCurrentBatch = (): number => {
  return currentBatch
}
export const setCurrentBatch = (value: number): void => {
  currentBatch = value
}

export const getNextAllowedRunAt = (): number | null => {
  return nextAllowedRunAt
}
export const setNextAllowedRunAt = (value: number | null): void => {
  nextAllowedRunAt = value
}
