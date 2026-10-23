import {runJudgmentJobSqliteBackgroundImport} from '../../cron/judgmentsJobs/judgmentJobSqliteBackgroundImport.ts'
import {getJudgmentJobSqliteService} from '../../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {runReviewServingProjectorWorkerOnce} from '../../workers/reviewServingProjectorWorker.ts'
import {getFixtureIds} from './getFixtureIds.ts'
import {getTopologyVisibleProjectionCount} from './getTopologyVisibleProjectionCount.ts'
import {requireTopologySeedBoundary} from './requireTopologySeedBoundary.ts'

export const judgmentWorkflowTopologyTestRoutesPostDrainReviewServingProjection = async ({
  body,
}: {
  body: {fixtureId: string; maxCycles?: number; token: string}
}) => {
  requireTopologySeedBoundary(body.token)
  const ids = getFixtureIds(body.fixtureId)
  const maxCycles = Math.min(16, Math.max(1, Math.trunc(body.maxCycles ?? 8)))
  const cycles: Array<{
    cycleIndex: number
    importSummary: Awaited<ReturnType<typeof runJudgmentJobSqliteBackgroundImport>>
    projectorResults: Array<{
      chunkStatus: string
      deltaIntakeStatus: string
      dirtyWorkCount: number
      projectId: string
      status: string
    }>
    reconciledCounts: Array<{projectId: string; updatedCount: number}>
    visibleProjectionCount: number
  }> = []
  let visibleProjectionCount = await getTopologyVisibleProjectionCount(body.fixtureId)

  for (let cycleIndex = 0; cycleIndex < maxCycles && visibleProjectionCount < 4; cycleIndex += 1) {
    const importSummary = await runJudgmentJobSqliteBackgroundImport({
      claimedBy: `topology-${body.fixtureId}-sqlite-import`,
    })
    const projectorResults = []

    for (const projectId of ids.projectIds) {
      const projectorResult = await runReviewServingProjectorWorkerOnce({
        maxWakeMs: 5_000,
        rebuildProjectId: projectId,
        workerId: `topology-${body.fixtureId}-projector-${cycleIndex}-${projectId}`,
      })

      projectorResults.push({
        chunkStatus: projectorResult.chunk.status,
        deltaIntakeStatus: projectorResult.deltaIntake.status,
        dirtyWorkCount: projectorResult.deltaIntake.dirtyWorkCount,
        projectId,
        status: projectorResult.status,
      })
    }

    const reconciledCounts = await Promise.all(
      ids.projectIds.map(async (projectId) => {
        return {projectId, updatedCount: await getJudgmentJobSqliteService().reconcileProjectRefreshAcks({projectId})}
      }),
    )
    visibleProjectionCount = await getTopologyVisibleProjectionCount(body.fixtureId)
    cycles.push({cycleIndex, importSummary, projectorResults, reconciledCounts, visibleProjectionCount})
  }

  return {data: {cycles, visibleProjectionCount}, error: null}
}
