import {getTokenUseQueryService} from '../../services/tokenUseQueryService.ts'
import {aggregateTokenTimelineRows, type TokenTimelineInterval} from './tokensRoutesTimelineUtils.ts'

type TimelineParams = {interval: TokenTimelineInterval; startDate: string; endDate: string}

export const tokensRoutesGetTimelineAllJobs = async ({interval, startDate, endDate}: TimelineParams) => {
  const rows = await getTokenUseQueryService().getTimelineRowsAllJobs({
    startDate: new Date(startDate),
    endDate: new Date(endDate),
  })
  const {completeData} = aggregateTokenTimelineRows({rows, interval, startDate, endDate})

  return {success: true, data: completeData}
}
