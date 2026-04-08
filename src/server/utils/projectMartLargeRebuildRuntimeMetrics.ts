type ProjectMartLargeRebuildCycleStatus = 'completed' | 'failed' | 'idle' | 'progressed'

type ProjectMartLargeRebuildCycleMetric = {
  articleCount: number
  durationMs: number
  endedAt: string
  error: string | null
  phase: string | null
  projectId: string | null
  startedAt: string
  status: ProjectMartLargeRebuildCycleStatus
  workerId: string
}

type ProjectMartLargeRebuildRuntimeMetrics = {
  recentCycles: ProjectMartLargeRebuildCycleMetric[]
  totals: {
    cyclesCompleted: number
    cyclesFailed: number
    cyclesIdle: number
    cyclesProgressed: number
    rowsProcessed: number
  }
}

type ProjectMartLargeRebuildRuntimeMetricsState = ProjectMartLargeRebuildRuntimeMetrics

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

export const recordProjectMartLargeRebuildCycleMetric = (metric: ProjectMartLargeRebuildCycleMetric) => {
  const projectMartLargeRebuildRuntimeMetricsState = getProjectMartLargeRebuildRuntimeMetricsState()

  projectMartLargeRebuildRuntimeMetricsState.recentCycles = [
    ...projectMartLargeRebuildRuntimeMetricsState.recentCycles,
    metric,
  ].slice(-maxRecentLargeRebuildCycles)

  projectMartLargeRebuildRuntimeMetricsState.totals.rowsProcessed += metric.articleCount
  projectMartLargeRebuildRuntimeMetricsState.totals.cyclesCompleted += metric.status === 'completed' ? 1 : 0
  projectMartLargeRebuildRuntimeMetricsState.totals.cyclesFailed += metric.status === 'failed' ? 1 : 0
  projectMartLargeRebuildRuntimeMetricsState.totals.cyclesIdle += metric.status === 'idle' ? 1 : 0
  projectMartLargeRebuildRuntimeMetricsState.totals.cyclesProgressed += metric.status === 'progressed' ? 1 : 0
}

export const getProjectMartLargeRebuildRuntimeMetrics = (): ProjectMartLargeRebuildRuntimeMetrics => {
  const projectMartLargeRebuildRuntimeMetricsState = getProjectMartLargeRebuildRuntimeMetricsState()

  return {
    recentCycles: [...projectMartLargeRebuildRuntimeMetricsState.recentCycles],
    totals: {...projectMartLargeRebuildRuntimeMetricsState.totals},
  }
}

export const resetProjectMartLargeRebuildRuntimeMetricsForTests = () => {
  globalThis.__forskaProjectMartLargeRebuildRuntimeMetricsState = getInitialProjectMartLargeRebuildRuntimeMetricsState()
}
