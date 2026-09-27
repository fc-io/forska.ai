import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {createRateLimitedLogger} from '../utils/rateLimitedLogger.ts'
import {
  type ReviewServingProjectionComponent,
  visibilityReviewServingProjectionComponents,
} from './reviewServingContracts.ts'

type VisibilityComponent = (typeof visibilityReviewServingProjectionComponents)[number]

type VisibilityComponentCounts = Record<VisibilityComponent, number>

type VisibilityBacklogRow = {
  component: ReviewServingProjectionComponent
  pendingCount: number | string
  projectId: string
  projectedCount: number | string
}

export type ReviewServingVisibilityBacklogProject = {
  madeVisibleCount: number
  pendingCounts: VisibilityComponentCounts
  pendingTotal: number
  projectId: string
  projectedCounts: VisibilityComponentCounts
}

export type ReviewServingVisibilityBacklogReportDatabase = {queryJson: <T>(statement: string) => Promise<T[]>}

export const reviewServingVisibilityBacklogReportIntervalMs = 60_000
export const reviewServingVisibilityBacklogReportProjectLimit = 5

const reviewServingVisibilityBacklogLogger = createRateLimitedLogger({
  sink: 'file-only',
  windowMs: reviewServingVisibilityBacklogReportIntervalMs,
})

let lastVisibilityBacklogReportAtMs: number | null = null
let lastVisibilityBacklogPendingTotal: number | null = null

const getTimestampSql = (value: Date) => {
  return `TIMESTAMPTZ ${getSqlLiteral(value.toISOString())}`
}

export const getReviewServingVisibilityBacklogSql = (input: {since: Date}) => {
  return `
    SELECT
      state.project_id AS projectId,
      state.projection_component AS component,
      CAST(COUNT(*) FILTER (WHERE state.status <> 'completed') AS BIGINT) AS pendingCount,
      CAST(COUNT(*) FILTER (
        WHERE state.status = 'completed'
          AND state.lifecycle_reason = 'projected'
          AND state.updated_at >= ${getTimestampSql(input.since)}
      ) AS BIGINT) AS projectedCount
    FROM app.review_serving_dirty_work_claim_state state
    WHERE state.projection_component IN (${visibilityReviewServingProjectionComponents.map(getSqlLiteral).join(', ')})
      AND (state.status <> 'completed' OR state.updated_at >= ${getTimestampSql(input.since)})
    GROUP BY ALL
  `
}

const getComponentCounts = (
  rows: readonly VisibilityBacklogRow[],
  count: (row: VisibilityBacklogRow) => number,
): VisibilityComponentCounts => {
  return Object.fromEntries(
    visibilityReviewServingProjectionComponents.map((component) => {
      return [
        component,
        rows
          .filter((row) => {
            return row.component === component
          })
          .reduce((total, row) => {
            return total + count(row)
          }, 0),
      ]
    }),
  ) as VisibilityComponentCounts
}

const getVisibilityBacklogProject = (
  projectId: string,
  rows: readonly VisibilityBacklogRow[],
): ReviewServingVisibilityBacklogProject => {
  const pendingCounts = getComponentCounts(rows, (row) => {
    return Number(row.pendingCount)
  })
  const projectedCounts = getComponentCounts(rows, (row) => {
    return Number(row.projectedCount)
  })

  return {
    madeVisibleCount: projectedCounts.selectedImport,
    pendingCounts,
    pendingTotal: Object.values(pendingCounts).reduce((total, value) => {
      return total + value
    }, 0),
    projectId,
    projectedCounts,
  }
}

export const getReviewServingVisibilityBacklogProjects = (rows: readonly VisibilityBacklogRow[], limit: number) => {
  const rowsByProject = rows.reduce((grouped, row) => {
    return grouped.set(row.projectId, [...(grouped.get(row.projectId) ?? []), row])
  }, new Map<string, VisibilityBacklogRow[]>())

  return [...rowsByProject.entries()]
    .map(([projectId, projectRows]) => {
      return getVisibilityBacklogProject(projectId, projectRows)
    })
    .filter((project) => {
      return project.pendingTotal > 0
    })
    .toSorted((left, right) => {
      return right.pendingTotal - left.pendingTotal || left.projectId.localeCompare(right.projectId)
    })
    .slice(0, limit)
}

const logReviewServingVisibilityBacklog = async (
  input: {database: ReviewServingVisibilityBacklogReportDatabase; nowMs: number},
  since: Date,
) => {
  const rows = await input.database.queryJson<VisibilityBacklogRow>(getReviewServingVisibilityBacklogSql({since}))
  const projects = getReviewServingVisibilityBacklogProjects(rows, reviewServingVisibilityBacklogReportProjectLimit)

  lastVisibilityBacklogPendingTotal = projects[0]?.pendingTotal ?? 0

  reviewServingVisibilityBacklogLogger.log(
    'review-serving-projector-worker:visibility-backlog',
    '[reviewServingProjectorWorker] visibility backlog',
    {
      component: 'reviewServingProjectorWorker',
      event: 'visibilityBacklog',
      intervalMs: input.nowMs - since.getTime(),
      projects,
    },
  )

  return projects
}

export const reportReviewServingVisibilityBacklog = async (input: {
  database: ReviewServingVisibilityBacklogReportDatabase
  nowMs: number
}) => {
  const lastReportAtMs = lastVisibilityBacklogReportAtMs

  if (lastReportAtMs !== null && input.nowMs - lastReportAtMs < reviewServingVisibilityBacklogReportIntervalMs) {
    return null
  }

  lastVisibilityBacklogReportAtMs = input.nowMs

  return logReviewServingVisibilityBacklog(
    input,
    new Date(lastReportAtMs ?? input.nowMs - reviewServingVisibilityBacklogReportIntervalMs),
  )
}

export const getReviewServingVisibilityBacklogPendingTotal = () => {
  return lastVisibilityBacklogPendingTotal
}

export const resetReviewServingVisibilityBacklogReportForTests = () => {
  lastVisibilityBacklogReportAtMs = null
  lastVisibilityBacklogPendingTotal = null
}
