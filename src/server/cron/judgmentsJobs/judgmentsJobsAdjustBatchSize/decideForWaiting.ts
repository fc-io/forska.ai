import {getGPUMultiplier} from './getGPUMultiplier.ts'

export type NextDecision = {nextTotal: number; sleeping: boolean; historyNote: string | null}

export const waitingThreshold = 16 * getGPUMultiplier()

export const decideForWaiting = (
  waitingCount: number,
  prevWaiting: number | null,
  cur: number,
  lastNonZeroTotal: number | null,
): NextDecision | null => {
  return waitingCount <= waitingThreshold
    ? null
    : (() => {
        const firstWait = prevWaiting == null
        const increasedOrSame = firstWait ? true : waitingCount >= prevWaiting

        const remembered = lastNonZeroTotal ?? (cur > 0 ? cur : null)

        return increasedOrSame
          ? {nextTotal: 0, sleeping: true, historyNote: `adjust-batch-size: waiting=${waitingCount} -> sleep`}
          : {
              nextTotal: Math.max(0, (remembered ?? cur) - 1),
              sleeping: false,
              historyNote: `adjust-batch-size: waiting=${waitingCount} < prev=${prevWaiting} -> base-2(${remembered ?? cur}-1)`,
            }
      })()
}
