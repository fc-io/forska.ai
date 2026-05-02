import {getAppDatabaseService} from './appDatabaseService.ts'
import {runProjectMartLargeRebuildCycle} from './projectMartLargeRebuildRunner.ts'

export type ProjectMartLargeRebuildStopReason =
  | 'completed'
  | 'failed'
  | 'idle'
  | 'max-cycles'
  | 'no-progress'
  | 'paused'
  | 'phase-changed'

export type ProjectMartLargeRebuildUntil = 'completed' | 'failed' | 'idle' | 'phase-change' | 'max-cycles'

export type ProjectMartLargeRebuildCyclesOptions = {
  batchSize?: number
  heartbeatMs?: number
  leaseMs?: number
  maxCycles: number
  maxNoProgressBackoffs?: number
  projectId?: string
  until?: ProjectMartLargeRebuildUntil
  workerId: string
}

export type ProjectMartLargeRebuildCycleSummary =
  | {projectId: null; status: 'idle'; workerId: string}
  | {cleanupRowCount: number; projectId: string | null; status: 'maintenance'; workerId: string}
  | {projectId: string; status: 'completed'; workerId: string}
  | {error: string; projectId: string; status: 'failed'; workerId: string}
  | {
      articleCount: number
      nextCursor: {articleCreatedAt: string | null; articleId: string} | null
      projectId: string
      status: 'progressed'
      workerId: string
    }

export type ProjectMartLargeRebuildCyclesResult = {
  backoffCount: number
  batchSize: number
  completedCycles: number
  cycleResults: ProjectMartLargeRebuildCycleSummary[]
  maxCycles: number
  status: 'completed' | 'failed'
  stopReason: ProjectMartLargeRebuildStopReason
  totalBackoffMs: number
  until: ProjectMartLargeRebuildUntil
  workerId: string
}

type ProjectMartLargeRebuildSnapshot = {rebuildPhase: string | null; refreshStatus: string | null}

type ProjectMartLargeRebuildCyclesDependencies = {
  getSnapshot: (projectId: string | null) => Promise<ProjectMartLargeRebuildSnapshot>
  runCycle: (options: {
    batchSize?: number
    heartbeatMs?: number
    leaseMs?: number
    projectId?: string
    workerId: string
  }) => Promise<Awaited<ReturnType<typeof runProjectMartLargeRebuildCycle>>>
  wait: (ms: number) => Promise<void>
}

const defaultMaxNoProgressBackoffs = 3

const getSnapshot = async (projectId: string | null): Promise<ProjectMartLargeRebuildSnapshot> => {
  if (projectId === null) {
    return {rebuildPhase: null, refreshStatus: null}
  }

  const [row] = await getAppDatabaseService().queryJson<ProjectMartLargeRebuildSnapshot>(`
    SELECT
      rebuild_phase AS rebuildPhase,
      refresh_status AS refreshStatus
    FROM app.project_mart_large_rebuild_state
    WHERE project_id = '${projectId}'
    LIMIT 1
  `)

  return row ?? {rebuildPhase: null, refreshStatus: null}
}

const defaultDependencies: ProjectMartLargeRebuildCyclesDependencies = {
  getSnapshot,
  runCycle: runProjectMartLargeRebuildCycle,
  wait: (ms: number) => {
    return new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  },
}

const getNormalizedUntil = (value?: ProjectMartLargeRebuildUntil) => {
  return value ?? 'max-cycles'
}

const toCycleSummary = (
  result: Awaited<ReturnType<typeof runProjectMartLargeRebuildCycle>>,
): ProjectMartLargeRebuildCycleSummary => {
  return result.status === 'progressed'
    ? {
        articleCount: result.articleCount,
        nextCursor: result.nextCursor
          ? {
              articleCreatedAt:
                result.nextCursor.articleCreatedAt === null ? null : String(result.nextCursor.articleCreatedAt),
              articleId: result.nextCursor.articleId,
            }
          : null,
        projectId: result.projectId,
        status: result.status,
        workerId: result.workerId,
      }
    : result.status === 'failed'
      ? {error: result.error, projectId: result.projectId, status: result.status, workerId: result.workerId}
      : result.status === 'completed'
        ? {projectId: result.projectId, status: result.status, workerId: result.workerId}
        : result.status === 'maintenance'
          ? {
              cleanupRowCount: result.cleanupRowCount,
              projectId: result.projectId,
              status: result.status,
              workerId: result.workerId,
            }
          : {projectId: result.projectId, status: result.status, workerId: result.workerId}
}

const getProgressCursorKey = ({
  currentPhase,
  summary,
}: {
  currentPhase: string | null
  summary: ProjectMartLargeRebuildCycleSummary
}) => {
  return summary.status !== 'progressed'
    ? null
    : `${summary.projectId}:${currentPhase ?? 'null'}:${summary.nextCursor?.articleCreatedAt ?? 'null'}:${summary.nextCursor?.articleId ?? 'null'}:${summary.articleCount}`
}

const shouldStopForUntil = ({
  currentPhase,
  initialPhase,
  summary,
  until,
}: {
  currentPhase: string | null
  initialPhase: string | null
  summary: ProjectMartLargeRebuildCycleSummary
  until: ProjectMartLargeRebuildUntil
}) => {
  return until === 'completed'
    ? summary.status === 'completed'
    : until === 'failed'
      ? summary.status === 'failed'
      : until === 'idle'
        ? summary.status === 'idle'
        : until === 'phase-change'
          ? initialPhase !== null && currentPhase !== null && currentPhase !== initialPhase
          : false
}

const getBackoffMs = (noProgressStreak: number) => {
  return Math.min(2_000, 250 * 2 ** Math.max(0, noProgressStreak - 1))
}

const getResult = ({
  backoffCount,
  batchSize,
  completedCycles,
  cycleResults,
  maxCycles,
  status,
  stopReason,
  totalBackoffMs,
  until,
  workerId,
}: ProjectMartLargeRebuildCyclesResult) => {
  return {
    backoffCount,
    batchSize,
    completedCycles,
    cycleResults,
    maxCycles,
    status,
    stopReason,
    totalBackoffMs,
    until,
    workerId,
  }
}

export const runProjectMartLargeRebuildCycles = async (
  {
    batchSize,
    heartbeatMs,
    leaseMs,
    maxCycles,
    maxNoProgressBackoffs,
    projectId,
    until,
    workerId,
  }: ProjectMartLargeRebuildCyclesOptions,
  dependencies: ProjectMartLargeRebuildCyclesDependencies = defaultDependencies,
): Promise<ProjectMartLargeRebuildCyclesResult> => {
  const cycleResults: ProjectMartLargeRebuildCycleSummary[] = []
  const normalizedUntil = getNormalizedUntil(until)
  const effectiveBatchSize = batchSize ?? 1
  const allowedNoProgressBackoffs = maxNoProgressBackoffs ?? defaultMaxNoProgressBackoffs
  const hasPinnedProjectId = projectId != null
  let stopReason: ProjectMartLargeRebuildStopReason = 'max-cycles'
  let lastCursorKey: string | null = null
  let noProgressStreak = 0
  let backoffCount = 0
  let activeProjectId = projectId ?? null
  let totalBackoffMs = 0

  const initialSnapshot = await dependencies.getSnapshot(activeProjectId)
  let initialPhase = initialSnapshot.rebuildPhase

  if (initialSnapshot.refreshStatus === 'paused') {
    return getResult({
      backoffCount,
      batchSize: effectiveBatchSize,
      completedCycles: 0,
      cycleResults,
      maxCycles,
      status: 'completed',
      stopReason: 'paused',
      totalBackoffMs,
      until: normalizedUntil,
      workerId,
    })
  }
  for (let cycleIndex = 0; cycleIndex < maxCycles; cycleIndex += 1) {
    const result = await dependencies.runCycle({
      batchSize,
      heartbeatMs,
      leaseMs,
      projectId: activeProjectId ?? undefined,
      workerId,
    })
    const summary = toCycleSummary(result)
    cycleResults.push(summary)

    if (!hasPinnedProjectId && activeProjectId === null && summary.status === 'progressed') {
      activeProjectId = summary.projectId
    }

    if (summary.status === 'failed') {
      stopReason = 'failed'
      return getResult({
        backoffCount,
        batchSize: effectiveBatchSize,
        completedCycles: cycleResults.length,
        cycleResults,
        maxCycles,
        status: 'failed',
        stopReason,
        totalBackoffMs,
        until: normalizedUntil,
        workerId,
      })
    }

    if (summary.status === 'idle') {
      stopReason = 'idle'
      return getResult({
        backoffCount,
        batchSize: effectiveBatchSize,
        completedCycles: cycleResults.length,
        cycleResults,
        maxCycles,
        status: 'completed',
        stopReason,
        totalBackoffMs,
        until: normalizedUntil,
        workerId,
      })
    }

    if (summary.status === 'maintenance') {
      continue
    }

    const snapshotProjectId = summary.projectId ?? projectId ?? null
    const snapshot = await dependencies.getSnapshot(snapshotProjectId)
    const currentPhase = snapshot.rebuildPhase

    if (!hasPinnedProjectId && summary.status === 'completed') {
      activeProjectId = null
    }

    if (initialPhase === null && currentPhase !== null) {
      initialPhase = currentPhase
    }

    if (snapshot.refreshStatus === 'paused') {
      stopReason = 'paused'
      return getResult({
        backoffCount,
        batchSize: effectiveBatchSize,
        completedCycles: cycleResults.length,
        cycleResults,
        maxCycles,
        status: 'completed',
        stopReason,
        totalBackoffMs,
        until: normalizedUntil,
        workerId,
      })
    }

    const cursorKey = getProgressCursorKey({currentPhase, summary})

    if (cursorKey !== null && cursorKey === lastCursorKey) {
      noProgressStreak += 1

      if (noProgressStreak > allowedNoProgressBackoffs) {
        stopReason = 'no-progress'
        return getResult({
          backoffCount,
          batchSize: effectiveBatchSize,
          completedCycles: cycleResults.length,
          cycleResults,
          maxCycles,
          status: 'failed',
          stopReason,
          totalBackoffMs,
          until: normalizedUntil,
          workerId,
        })
      }

      const backoffMs = getBackoffMs(noProgressStreak)
      backoffCount += 1
      totalBackoffMs += backoffMs
      await dependencies.wait(backoffMs)
    } else {
      noProgressStreak = 0
    }

    lastCursorKey = cursorKey

    if (shouldStopForUntil({currentPhase, initialPhase, summary, until: normalizedUntil})) {
      stopReason = normalizedUntil === 'phase-change' ? 'phase-changed' : normalizedUntil
      return getResult({
        backoffCount,
        batchSize: effectiveBatchSize,
        completedCycles: cycleResults.length,
        cycleResults,
        maxCycles,
        status: 'completed',
        stopReason,
        totalBackoffMs,
        until: normalizedUntil,
        workerId,
      })
    }
  }

  return getResult({
    backoffCount,
    batchSize: effectiveBatchSize,
    completedCycles: cycleResults.length,
    cycleResults,
    maxCycles,
    status: 'completed',
    stopReason,
    totalBackoffMs,
    until: normalizedUntil,
    workerId,
  })
}

export type {ProjectMartLargeRebuildCyclesDependencies}
