import {getJudgmentJobSqliteService} from '../../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {requireTopologySeedBoundary} from './requireTopologySeedBoundary.ts'

export const judgmentWorkflowTopologyTestRoutesPostClaims = async ({body}: {body: {jobId: string; token: string}}) => {
  requireTopologySeedBoundary(body.token)

  return {data: {claims: await getJudgmentJobSqliteService().getTopologyClaimRows(body.jobId)}, error: null}
}
