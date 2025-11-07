export const getWarmupTarget = (
  isFirstRun: boolean,
  inWarmup: boolean,
  lastTotal: number | null,
  warmupStart: number,
  warmupMax: number,
): number | undefined => {
  return isFirstRun ? warmupStart : inWarmup && lastTotal != null ? Math.min(lastTotal + 2, warmupMax) : undefined
}
