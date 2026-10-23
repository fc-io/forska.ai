import {getJudgmentJobSqliteService} from '../../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {judgmentJobServerId} from './judgmentJobServerId.ts'

type JudgmentWorkerHeartbeatBody = {claimedBy?: string; jobIds?: string[]}

export const recordJudgmentJobWorkerHeartbeat = async (body: JudgmentWorkerHeartbeatBody | undefined) => {
  const claimedBy = body?.claimedBy ?? judgmentJobServerId
  const jobIds = Array.from(new Set(body?.jobIds ?? []))
  const recorded = await Promise.all(
    jobIds.map((jobId) => {
      return getJudgmentJobSqliteService().recordWorkerHeartbeat(jobId, claimedBy)
    }),
  )
  const recordedJobIds = jobIds.filter((_jobId, index) => {
    return recorded[index] === true
  })

  return {data: {jobIds: recordedJobIds}, error: null}
}
