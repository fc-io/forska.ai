import {getJudgmentJobSqliteService} from '../../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {getFixtureIds} from './getFixtureIds.ts'
import {requireTopologySeedBoundary} from './requireTopologySeedBoundary.ts'

export const judgmentWorkflowTopologyTestRoutesPostReconcileProjectRefreshAcks = async ({
  body,
}: {
  body: {fixtureId: string; token: string}
}) => {
  requireTopologySeedBoundary(body.token)
  const ids = getFixtureIds(body.fixtureId)
  const reconciledCounts = await Promise.all(
    ids.projectIds.map(async (projectId) => {
      return {projectId, updatedCount: await getJudgmentJobSqliteService().reconcileProjectRefreshAcks({projectId})}
    }),
  )

  return {data: {reconciledCounts}, error: null}
}
