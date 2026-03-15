import {getTokenUseQueryService} from '../../services/tokenUseQueryService.ts'
import {aggregateTokenTimelineRows, type TokenTimelineInterval} from './tokensRoutesTimelineUtils.ts'

type TimelineParams = {projectId: string; interval: TokenTimelineInterval; startDate: string; endDate: string}

export const tokensRoutesGetTimeline = async ({projectId, interval, startDate, endDate}: TimelineParams) => {
  const rows = await getTokenUseQueryService().getTimelineRowsForProject({
    projectId,
    startDate: new Date(startDate),
    endDate: new Date(endDate),
  })

  if (rows.length === 0) {
    return {success: true, data: []}
  }

  const {completeData} = aggregateTokenTimelineRows({rows, interval, startDate, endDate})

  return {success: true, data: completeData}
}
