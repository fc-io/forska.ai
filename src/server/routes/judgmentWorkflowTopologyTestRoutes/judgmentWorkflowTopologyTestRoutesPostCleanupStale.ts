import {existsSync} from 'node:fs'

import {getJudgmentJobLeasePath, getJudgmentJobSqlitePath} from '../../cron/judgmentsJobs/judgmentJobPaths.ts'
import {judgmentsJobsCleanupStale} from '../../cron/judgmentsJobs/judgmentsJobsCleanupStale.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {requireTopologySeedBoundary} from './requireTopologySeedBoundary.ts'

export const judgmentWorkflowTopologyTestRoutesPostCleanupStale = async ({
  body,
}: {
  body: {jobIds?: string[]; token: string}
}) => {
  requireTopologySeedBoundary(body.token)
  await judgmentsJobsCleanupStale()
  const jobIds = body.jobIds ?? []
  const storageStates =
    jobIds.length === 0
      ? []
      : await getAppDatabaseService().queryJson<{jobId: string; storageState: string}>(`
              SELECT id AS jobId, storage_state AS storageState
              FROM app.judgment_job
              WHERE id IN (${jobIds.map(getSqlLiteral).join(', ')})
            `)
  const storageStateByJobId = new Map(
    storageStates.map((state) => {
      return [state.jobId, state.storageState]
    }),
  )
  const jobs = jobIds.map((jobId) => {
    const sqlitePath = getJudgmentJobSqlitePath(jobId)

    return {
      artifacts: {
        lease: existsSync(getJudgmentJobLeasePath(jobId)),
        shm: existsSync(`${sqlitePath}-shm`),
        sqlite: existsSync(sqlitePath),
        wal: existsSync(`${sqlitePath}-wal`),
      },
      jobId,
      storageState: storageStateByJobId.get(jobId) ?? null,
    }
  })

  return {data: {jobs, ok: true}, error: null}
}
