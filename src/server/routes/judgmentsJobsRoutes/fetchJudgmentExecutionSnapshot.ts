import {getJudgmentJobSqliteService} from '../../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {getJudgmentExecutionSnapshot} from '../../services/judgmentExecutionSnapshotService.ts'
import {HttpError} from '../../utils/httpError.ts'

type JudgmentSnapshotQuery = {executionSnapshotHash?: string; hash?: string; jobId?: string}

export const fetchJudgmentExecutionSnapshot = async (executionSnapshotId: string, query: JudgmentSnapshotQuery) => {
  const executionSnapshotHash = query.executionSnapshotHash ?? query.hash

  if (!executionSnapshotHash) {
    throw new HttpError(400, 'executionSnapshotHash is required')
  }

  // Snapshots prepared by the refill are served from the job SQLite store without a DuckDB read.
  const preparedSnapshot = query.jobId
    ? await getJudgmentJobSqliteService().getPreparedExecutionSnapshotRecord({
        executionSnapshotHash,
        executionSnapshotId,
        jobId: query.jobId,
      })
    : null
  const snapshot =
    preparedSnapshot ?? (await getJudgmentExecutionSnapshot({executionSnapshotHash, executionSnapshotId}))

  if (!snapshot) {
    throw new HttpError(404, 'judgment execution snapshot not found')
  }

  return {data: snapshot, error: null}
}
