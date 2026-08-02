import {
  getReviewServingRebuildTimingDiagnostics,
  type ReviewServingChunkManifestRepositoryDatabase,
  type ReviewServingChunkManifestRepositoryTransaction,
} from '../src/server/reviewServing/reviewServingChunkManifestRepository.ts'
import {getReviewServingPhysicalShapeDiagnostics} from '../src/server/reviewServing/reviewServingPhysicalShapeDiagnostics.ts'
import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'
import {getMaintenanceDuckdbWorkloadContext} from '../src/server/utils/duckdbService.ts'

type CliOptions = {limit: number; projectId: string | null; requestId: string | null}

const workloadContext = getMaintenanceDuckdbWorkloadContext('inspectReviewServingRebuildTimings')

const getArgValue = (names: string[]) => {
  const matchedArgument = process.argv.slice(2).find((argument) => {
    return names.some((name) => {
      return argument.startsWith(`${name}=`)
    })
  })

  return matchedArgument?.slice(matchedArgument.indexOf('=') + 1).trim()
}

const getPositiveIntegerOption = (value: string | undefined, fallback: number) => {
  const parsedValue = value === undefined ? Number.NaN : Number(value)

  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallback
}

const getCliOptions = (): CliOptions => {
  return {
    limit: getPositiveIntegerOption(getArgValue(['--limit']), 50),
    projectId: getArgValue(['--project-id', '--projectId']) ?? null,
    requestId: getArgValue(['--request-id', '--requestId']) ?? null,
  }
}

const getTimestampDurationMs = (start: string | null, end: string | null) => {
  if (!start || !end) {
    return null
  }

  const startMs = new Date(start).getTime()
  const endMs = new Date(end).getTime()

  return Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null
}

const getOperatorTimelineReadout = (
  diagnostics: Awaited<ReturnType<typeof getReviewServingRebuildTimingDiagnostics>>,
) => {
  return diagnostics.timeline.map((timeline) => {
    return {
      activeSnapshotPromotedAt: timeline.activeSnapshotPromotedAt,
      admittedAt: timeline.admittedAt,
      componentCounts: timeline.componentCounts,
      createdAt: timeline.createdAt,
      defaultReadableAt: timeline.defaultReadableAt,
      durationsMs: {
        admittedToFirstChunk: getTimestampDurationMs(timeline.admittedAt.value, timeline.firstChunkStartedAt.value),
        admittedToPromotion: getTimestampDurationMs(timeline.admittedAt.value, timeline.activeSnapshotPromotedAt.value),
        createdToAdmitted: getTimestampDurationMs(timeline.createdAt.value, timeline.admittedAt.value),
        createdToPromotion: getTimestampDurationMs(timeline.createdAt.value, timeline.activeSnapshotPromotedAt.value),
        firstChunkToPromotion: getTimestampDurationMs(
          timeline.firstChunkStartedAt.value,
          timeline.activeSnapshotPromotedAt.value,
        ),
      },
      firstChunkStartedAt: timeline.firstChunkStartedAt,
      fullyEnrichedAt: timeline.fullyEnrichedAt,
      projectId: timeline.projectId,
      relationships: timeline.relationships,
      reviewConfigHash: timeline.reviewConfigHash,
      rootRequestId: timeline.rootRequestId,
      snapshotId: timeline.snapshotId,
      status: timeline.status,
    }
  })
}

const inspectReviewServingRebuildTimingsCli = async () => {
  const options = getCliOptions()

  await withDuckdbMaintenanceAccess('inspect review-serving rebuild timings', async () => {
    const database = getAppDatabaseService()
    const databaseAccess: ReviewServingChunkManifestRepositoryDatabase = {
      ...database,
      queryJson: <T>(statement: string) => {
        return database.queryJson<T>(statement, workloadContext)
      },
      run: (statement: string) => {
        return database.run(statement, workloadContext)
      },
      transaction: async <T>(
        operation: (tx: ReviewServingChunkManifestRepositoryTransaction) => Promise<T>,
      ): Promise<T> => {
        return database.transaction(operation, workloadContext) as Promise<T>
      },
    }
    const diagnostics = await getReviewServingRebuildTimingDiagnostics(options, databaseAccess)
    const physicalShape = options.projectId
      ? await getReviewServingPhysicalShapeDiagnostics(options.projectId, {queryJson: databaseAccess.queryJson})
      : null
    const operatorReadout = getOperatorTimelineReadout(diagnostics)

    const output = physicalShape ? {...diagnostics, operatorReadout, physicalShape} : {...diagnostics, operatorReadout}

    console.log(JSON.stringify(output, null, 2))
  })
}

await inspectReviewServingRebuildTimingsCli()
