import type {DuckdbQueueRuntimeMetrics, DuckdbTempSpillMetrics} from './duckdbService.ts'

type ProjectMartLargeRebuildCycleStatus = 'completed' | 'failed' | 'idle' | 'maintenance' | 'progressed'

type ProjectMartLargeRebuildCycleQueueDelta = {
  lastDurationMs: number | null
  lastWaitMs: number | null
  maxQueueDepth: number
  queueDepth: number
  tasksCompleted: number
  tasksCompletedDelta: number
  tasksStarted: number
  tasksStartedDelta: number
  totalDurationMs: number
  totalDurationMsDelta: number
  totalWaitMs: number
  totalWaitMsDelta: number
}

type ProjectMartLargeRebuildCycleMetric = {
  articleCount: number
  committedRowCount?: number
  durationMs: number
  duckdbQueues: {
    background: ProjectMartLargeRebuildCycleQueueDelta
    main: ProjectMartLargeRebuildCycleQueueDelta
  } | null
  endedAt: string
  error: string | null
  lastCommittedCursor?: {articleCreatedAt: string | null; articleId: string} | null
  phase: string | null
  processMemory?: {rssBytes: number}
  projectId: string | null
  queueWaitMs?: number | null
  rowsPerSecond?: number | null
  startedAt: string
  status: ProjectMartLargeRebuildCycleStatus
  tempSpill?: DuckdbTempSpillMetrics | null
  workerId: string
}

type ProjectMartLargeRebuildRuntimeMetrics = {
  perPhase: ProjectMartLargeRebuildPhaseMetric[]
  recentCycles: ProjectMartLargeRebuildCycleMetric[]
  totals: {
    cyclesCompleted: number
    cyclesFailed: number
    cyclesIdle: number
    cyclesProgressed: number
    rowsProcessed: number
  }
}

type ProjectMartLargeRebuildStoredCycleMetric = ProjectMartLargeRebuildCycleMetric & {
  committedRowCount: number
  lastCommittedCursor: {articleCreatedAt: string | null; articleId: string} | null
  processMemory: {rssBytes: number}
  queueWaitMs: number | null
  rowsPerSecond: number | null
  tempSpill: DuckdbTempSpillMetrics | null
}

type ProjectMartLargeRebuildPhaseMetric = {
  committedRowCount: number
  cycleCount: number
  durationMs: number
  lastCommittedCursor: {articleCreatedAt: string | null; articleId: string} | null
  lastEndedAt: string | null
  lastRssBytes: number | null
  lastTempSpill: DuckdbTempSpillMetrics | null
  maxRssBytes: number | null
  maxTempSpillBytes: number | null
  phase: string | null
  queueWaitMs: number | null
  rowsPerSecond: number | null
}

type ProjectMartLargeRebuildRuntimeMetricsState = {
  recentCycles: ProjectMartLargeRebuildStoredCycleMetric[]
  totals: ProjectMartLargeRebuildRuntimeMetrics['totals']
}

declare global {
  var __forskaProjectMartLargeRebuildRuntimeMetricsState: ProjectMartLargeRebuildRuntimeMetricsState | undefined
}

const maxRecentLargeRebuildCycles = 50

const getInitialProjectMartLargeRebuildRuntimeMetricsState = (): ProjectMartLargeRebuildRuntimeMetricsState => {
  return {
    recentCycles: [],
    totals: {cyclesCompleted: 0, cyclesFailed: 0, cyclesIdle: 0, cyclesProgressed: 0, rowsProcessed: 0},
  }
}

const getProjectMartLargeRebuildRuntimeMetricsState = () => {
  globalThis.__forskaProjectMartLargeRebuildRuntimeMetricsState ??=
    getInitialProjectMartLargeRebuildRuntimeMetricsState()
  return globalThis.__forskaProjectMartLargeRebuildRuntimeMetricsState
}

const getRowsPerSecond = (rows: number, durationMs: number) => {
  return rows > 0 && durationMs > 0 ? Number((rows / (durationMs / 1000)).toFixed(2)) : null
}

const getQueueWaitMs = (metric: ProjectMartLargeRebuildCycleMetric) => {
  return metric.queueWaitMs !== undefined
    ? metric.queueWaitMs
    : metric.duckdbQueues === null
      ? null
      : metric.duckdbQueues.background.totalWaitMsDelta + metric.duckdbQueues.main.totalWaitMsDelta
}

const getStoredCycleMetric = (metric: ProjectMartLargeRebuildCycleMetric): ProjectMartLargeRebuildStoredCycleMetric => {
  const committedRowCount = metric.committedRowCount ?? metric.articleCount

  return {
    ...metric,
    committedRowCount,
    lastCommittedCursor: metric.lastCommittedCursor ?? null,
    processMemory: metric.processMemory ?? {rssBytes: process.memoryUsage().rss},
    queueWaitMs: getQueueWaitMs(metric),
    rowsPerSecond: metric.rowsPerSecond ?? getRowsPerSecond(committedRowCount, metric.durationMs),
    tempSpill: metric.tempSpill ?? null,
  }
}

const getMaxNullableNumber = (left: number | null, right: number | null) => {
  return left === null ? right : right === null ? left : Math.max(left, right)
}

const getPhaseMetrics = (metrics: ProjectMartLargeRebuildStoredCycleMetric[]) => {
  return metrics.reduce<ProjectMartLargeRebuildPhaseMetric[]>((phaseMetrics, metric) => {
    const existingMetricIndex = phaseMetrics.findIndex((phaseMetric) => {
      return phaseMetric.phase === metric.phase
    })
    const existingMetric = existingMetricIndex === -1 ? null : (phaseMetrics[existingMetricIndex] ?? null)
    const nextCommittedRowCount = (existingMetric?.committedRowCount ?? 0) + metric.committedRowCount
    const nextDurationMs = (existingMetric?.durationMs ?? 0) + metric.durationMs
    const existingQueueWaitMs = existingMetric?.queueWaitMs ?? null
    const nextQueueWaitMs =
      metric.queueWaitMs === null && existingQueueWaitMs === null
        ? null
        : (existingQueueWaitMs ?? 0) + (metric.queueWaitMs ?? 0)
    const nextMetric = {
      committedRowCount: nextCommittedRowCount,
      cycleCount: (existingMetric?.cycleCount ?? 0) + 1,
      durationMs: nextDurationMs,
      lastCommittedCursor: metric.lastCommittedCursor,
      lastEndedAt: metric.endedAt,
      lastRssBytes: metric.processMemory.rssBytes,
      lastTempSpill: metric.tempSpill,
      maxRssBytes: getMaxNullableNumber(existingMetric?.maxRssBytes ?? null, metric.processMemory.rssBytes),
      maxTempSpillBytes: getMaxNullableNumber(
        existingMetric?.maxTempSpillBytes ?? null,
        metric.tempSpill?.totalBytes ?? null,
      ),
      phase: metric.phase,
      queueWaitMs: nextQueueWaitMs,
      rowsPerSecond: getRowsPerSecond(nextCommittedRowCount, nextDurationMs),
    }

    return existingMetricIndex === -1
      ? [...phaseMetrics, nextMetric]
      : phaseMetrics.map((phaseMetric, phaseMetricIndex) => {
          return phaseMetricIndex === existingMetricIndex ? nextMetric : phaseMetric
        })
  }, [])
}

export const recordProjectMartLargeRebuildCycleMetric = (metric: ProjectMartLargeRebuildCycleMetric) => {
  const projectMartLargeRebuildRuntimeMetricsState = getProjectMartLargeRebuildRuntimeMetricsState()
  const storedMetric = getStoredCycleMetric(metric)

  projectMartLargeRebuildRuntimeMetricsState.recentCycles = [
    ...projectMartLargeRebuildRuntimeMetricsState.recentCycles,
    storedMetric,
  ].slice(-maxRecentLargeRebuildCycles)

  projectMartLargeRebuildRuntimeMetricsState.totals.rowsProcessed += storedMetric.committedRowCount
  projectMartLargeRebuildRuntimeMetricsState.totals.cyclesCompleted += metric.status === 'completed' ? 1 : 0
  projectMartLargeRebuildRuntimeMetricsState.totals.cyclesFailed += metric.status === 'failed' ? 1 : 0
  projectMartLargeRebuildRuntimeMetricsState.totals.cyclesIdle += metric.status === 'idle' ? 1 : 0
  projectMartLargeRebuildRuntimeMetricsState.totals.cyclesProgressed += metric.status === 'progressed' ? 1 : 0
}

export const getProjectMartLargeRebuildCycleQueueDelta = ({
  finished,
  started,
}: {
  finished: DuckdbQueueRuntimeMetrics
  started: DuckdbQueueRuntimeMetrics
}) => {
  const getQueueDelta = ({
    finishedQueue,
    startedQueue,
  }: {
    finishedQueue: DuckdbQueueRuntimeMetrics['background']
    startedQueue: DuckdbQueueRuntimeMetrics['background']
  }): ProjectMartLargeRebuildCycleQueueDelta => {
    return {
      lastDurationMs: finishedQueue.lastDurationMs,
      lastWaitMs: finishedQueue.lastWaitMs,
      maxQueueDepth: finishedQueue.maxQueueDepth,
      queueDepth: finishedQueue.queueDepth,
      tasksCompleted: finishedQueue.tasksCompleted,
      tasksCompletedDelta: finishedQueue.tasksCompleted - startedQueue.tasksCompleted,
      tasksStarted: finishedQueue.tasksStarted,
      tasksStartedDelta: finishedQueue.tasksStarted - startedQueue.tasksStarted,
      totalDurationMs: finishedQueue.totalDurationMs,
      totalDurationMsDelta: finishedQueue.totalDurationMs - startedQueue.totalDurationMs,
      totalWaitMs: finishedQueue.totalWaitMs,
      totalWaitMsDelta: finishedQueue.totalWaitMs - startedQueue.totalWaitMs,
    }
  }

  return {
    background: getQueueDelta({finishedQueue: finished.background, startedQueue: started.background}),
    main: getQueueDelta({finishedQueue: finished.main, startedQueue: started.main}),
  }
}

export const getProjectMartLargeRebuildRuntimeMetrics = (): ProjectMartLargeRebuildRuntimeMetrics => {
  const projectMartLargeRebuildRuntimeMetricsState = getProjectMartLargeRebuildRuntimeMetricsState()

  return {
    perPhase: getPhaseMetrics(projectMartLargeRebuildRuntimeMetricsState.recentCycles),
    recentCycles: [...projectMartLargeRebuildRuntimeMetricsState.recentCycles],
    totals: {...projectMartLargeRebuildRuntimeMetricsState.totals},
  }
}

export const resetProjectMartLargeRebuildRuntimeMetricsForTests = () => {
  globalThis.__forskaProjectMartLargeRebuildRuntimeMetricsState = getInitialProjectMartLargeRebuildRuntimeMetricsState()
}
