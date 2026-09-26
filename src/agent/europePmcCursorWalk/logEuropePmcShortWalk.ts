import {writeRuntimeOperatorLogEvent} from '../../server/utils/runtimeLogger.ts'

export type EuropePmcWalkEndReason = 'hit-count-reached' | 'no-next-cursor' | 'same-cursor'

const europePmcShortWalkMinFetchedRatio = 0.99

const isEuropePmcShortWalk = (input: {fetchedTotal: number | null; hitCount: number}) => {
  return input.fetchedTotal !== null && input.fetchedTotal < input.hitCount * europePmcShortWalkMinFetchedRatio
}

export const logEuropePmcShortWalk = (input: {
  dataSourceId: string | null
  endReason: EuropePmcWalkEndReason
  fetchedTotal: number | null
  fromDate: string
  hitCount: number
  importRoute: string
  pageCount: number
  query: string
  sort: string | null
  toDate: string
}) => {
  const fetchedTotal = input.fetchedTotal ?? 0

  if (isEuropePmcShortWalk(input)) {
    writeRuntimeOperatorLogEvent({
      attrs: {
        dataSourceId: input.dataSourceId,
        endReason: input.endReason,
        fetchedCount: fetchedTotal,
        fromDate: input.fromDate,
        hitCount: input.hitCount,
        importRoute: input.importRoute,
        missingCount: input.hitCount - fetchedTotal,
        pageCount: input.pageCount,
        query: input.query,
        sort: input.sort ?? 'relevance',
        toDate: input.toDate,
      },
      event: 'data-source-import.europe-pmc-short-walk',
      message:
        `[dataSourceImport] Europe PMC walk for ${input.importRoute} (data source ${input.dataSourceId ?? 'unknown'}) `
        + `ended (${input.endReason}) after ${fetchedTotal} of ${input.hitCount} hits`,
      severity: 'WARN',
    })
  }
}
