import {getJudgmentJobSqliteService} from '../../cron/judgmentsJobs/judgmentJobSqliteService.ts'
import {
  getJudgmentJobSqliteHealthProjectionService,
  type JudgmentJobSqliteHealthProjectionReader,
  type JudgmentJobSqliteHealthProjectionRecord,
} from '../../services/judgmentJobSqliteHealthProjectionService.ts'
import {canCurrentServerOwnDuckdb, shouldCurrentServerRunJudgingLoops} from '../../utils/serverRuntimeRole.ts'
import {getMaintenanceUnavailableError} from './getMaintenanceUnavailableError.ts'
import type {JudgmentJobSqliteHealthSnapshot} from './judgmentJobHealthTypes.ts'

type JudgmentJobSqliteHealthReadableJob = {id: string; storageState: string}

const getProjectedSqliteHealth = (
  projection: JudgmentJobSqliteHealthProjectionRecord,
): JudgmentJobSqliteHealthSnapshot => {
  return {
    claimedOutboxCount: projection.claimedOutboxCount,
    hasOutboxRows: projection.hasOutboxRows,
    hasPendingCompletionAck: projection.hasPendingCompletionAck,
    hasQueueRows: projection.hasQueueRows,
    lastAckSeq: projection.lastAckSeq,
    oldestUnackedCompletionAgeMs: projection.oldestUnackedCompletionAgeMs,
    oldestUnexportedAgeMs: projection.oldestUnexportedAgeMs,
    orphanedJudgedRowCount: projection.orphanedJudgedRowCount,
    outboxRowCount: projection.outboxRowCount,
    pendingCompletionAckCount: projection.pendingCompletionAckCount,
    healthProjection: {
      freshUntilAt: projection.freshUntilAt,
      projectedAt: projection.projectedAt,
      projectedBy: projection.projectedBy,
      source: projection.projectionSource,
    },
    promptCounts: projection.promptCounts,
    retainedRowCount: projection.retainedRowCount,
    sqliteFileBytes: projection.sqliteFileBytes,
    walBytes: projection.walBytes,
  }
}

const getEmptySqliteHealthSnapshot = (): JudgmentJobSqliteHealthSnapshot => {
  return {
    claimedOutboxCount: 0,
    hasOutboxRows: false,
    hasPendingCompletionAck: false,
    hasQueueRows: false,
    lastAckSeq: null,
    oldestUnackedCompletionAgeMs: null,
    oldestUnexportedAgeMs: null,
    orphanedJudgedRowCount: 0,
    outboxRowCount: 0,
    pendingCompletionAckCount: 0,
    promptCounts: {claimed: 0, judged: 0, ready: 0, running: 0, skipped: 0},
    retainedRowCount: 0,
    sqliteFileBytes: null,
    walBytes: 0,
  }
}

const getReadableJobSqliteHealthFallback = (
  job: Pick<JudgmentJobSqliteHealthReadableJob, 'storageState'> | undefined,
) => {
  return job?.storageState === 'drained' ? getEmptySqliteHealthSnapshot() : null
}

const getReadableJobSqliteHealthFallbackEntries = (jobs: JudgmentJobSqliteHealthReadableJob[]) => {
  return jobs.flatMap((job) => {
    const fallback = getReadableJobSqliteHealthFallback(job)

    return fallback ? [[job.id, fallback] as const] : []
  })
}

const getSqliteHealthFromFreshProjection = async ({
  db,
  jobId,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobId: string
}): Promise<JudgmentJobSqliteHealthSnapshot> => {
  const projection = await getJudgmentJobSqliteHealthProjectionService().getFreshJudgmentJobSqliteHealthProjection({
    db,
    jobId,
  })

  if (!projection) {
    throw getMaintenanceUnavailableError(`fresh SQLite health projection is unavailable for judgment job ${jobId}`)
  }

  return getProjectedSqliteHealth(projection)
}

export const getSqliteHealthForReadableRoute = async ({
  db,
  job,
  jobId,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  job?: Pick<JudgmentJobSqliteHealthReadableJob, 'storageState'>
  jobId: string
}): Promise<JudgmentJobSqliteHealthSnapshot> => {
  return shouldCurrentServerRunJudgingLoops()
    ? getJudgmentJobSqliteService().getHealthSnapshot(jobId)
    : getSqliteHealthFromFreshProjection({db, jobId}).catch((error: unknown) => {
        const fallback = getReadableJobSqliteHealthFallback(job)

        return canCurrentServerOwnDuckdb()
          ? getJudgmentJobSqliteService().getHealthSnapshot(jobId)
          : fallback
            ? Promise.resolve(fallback)
            : Promise.reject(error)
      })
}

export const getSqliteHealthMapForReadableRoute = async ({
  db,
  jobs,
}: {
  db: JudgmentJobSqliteHealthProjectionReader
  jobs: JudgmentJobSqliteHealthReadableJob[]
}) => {
  const jobIds = jobs.map((job) => {
    return job.id
  })

  if (shouldCurrentServerRunJudgingLoops()) {
    const entries = await Promise.all(
      jobIds.map(async (jobId) => {
        return [jobId, await getJudgmentJobSqliteService().getHealthSnapshot(jobId)] as const
      }),
    )

    return new Map(entries)
  }

  const projections = await getJudgmentJobSqliteHealthProjectionService().getFreshJudgmentJobSqliteHealthProjections({
    db,
    jobIds,
  })
  const missingJobs = jobs.filter((job) => {
    return !projections.has(job.id)
  })

  if (missingJobs.length > 0) {
    if (!canCurrentServerOwnDuckdb()) {
      const fallbackEntries = getReadableJobSqliteHealthFallbackEntries(missingJobs)
      const fallbackJobIds = new Set(
        fallbackEntries.map(([jobId]) => {
          return jobId
        }),
      )
      const missingJobIds = missingJobs
        .filter((job) => {
          return !fallbackJobIds.has(job.id)
        })
        .map((job) => {
          return job.id
        })

      if (missingJobIds.length > 0) {
        throw getMaintenanceUnavailableError(
          `fresh SQLite health projection is unavailable for judgment jobs ${missingJobIds.join(', ')}`,
        )
      }

      return new Map([
        ...Array.from(projections.entries()).map(([jobId, projection]) => {
          return [jobId, getProjectedSqliteHealth(projection)] as const
        }),
        ...fallbackEntries,
      ])
    }

    const missingEntries = await Promise.all(
      missingJobs.map(async (job) => {
        const jobId = job.id

        return [jobId, await getJudgmentJobSqliteService().getHealthSnapshot(jobId)] as const
      }),
    )

    return new Map([
      ...Array.from(projections.entries()).map(([jobId, projection]) => {
        return [jobId, getProjectedSqliteHealth(projection)] as const
      }),
      ...missingEntries,
    ])
  }

  return new Map(
    Array.from(projections.entries()).map(([jobId, projection]) => {
      return [jobId, getProjectedSqliteHealth(projection)] as const
    }),
  )
}
