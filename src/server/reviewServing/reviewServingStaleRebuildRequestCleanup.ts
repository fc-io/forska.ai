import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getReviewServingRebuildRequestReadmittableChunksSql} from './reviewServingChunkManifestRepository.ts'
import {isReviewServingProjectionComponent, type ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import {defaultReviewServingDirtyWorkBlockedByRebuildRequeueSeconds} from './reviewServingDirtyWorkService.ts'
import {getActiveReviewServingSnapshotManifest} from './reviewServingManifestRepository.ts'
import {getCurrentReviewServingReviewConfigHash} from './reviewServingReviewConfig.ts'
import {getReviewServingClosedRebuildRequestLastErrorSql} from './reviewServingSupersededRebuildChunk.ts'

// Rebuild requests that can never do useful work any more are closed here, so they stop holding snapshots from the
// purge, dirty-work claims from requeueing and chunk rows in every claim scan.
//
// - A request of an archived, delete-pending or deleted project never runs: chunk claims skip such projects. Once the
//   project has stayed that way for the settle window, every request that could still run or be readmitted is closed,
//   except one whose chunks all completed (finalization promotes its candidate) or one with a running chunk (closed
//   once it finished). Unarchiving keeps working: the project's dirty work is kept and requests again what it needs,
//   and the warnings route asks for components the active snapshot does not serve.
// - A request of a live project that was never admitted (blocked over budget, or pending admission, which nothing
//   admits) is only re-evaluated when a dirty-work claim or a page poll plans the same request again: planning updates
//   the row it lands on and re-runs admission against the budget of that moment, and a claim parked on a blocked request
//   is requeued, and plans again, once the request is older than the blocked-request reuse window. A never-admitted
//   request past that window is therefore nobody's path to anything. It is still only closed when it is provably
//   superseded: it was planned for a review config that is no longer current, or the active snapshot of the current
//   config serves every component it asked for and none of those components has open dirty work.
//
// A closed request fails with a last error starting with 'superseded', which readmission, trains, the purge and the
// live-candidate checks all treat as closed for good. It is failed rather than cancelled: availability reads a
// cancelled request's chunk groups as never built, which would hide the components a closed train already built into a
// snapshot that has since been promoted. Its unstarted chunks fail with it (so do pending chunks left behind by requests
// that were closed some other way, which still read as work in progress); candidates no live request builds any more
// fail too, so the purge reclaims them. Planning the same request id again reopens the row as before.
//
// Chunk rows of closed requests that never completed are deleted once nothing can read them: chunks without a snapshot
// (availability joins chunks to their snapshot) and chunks whose snapshot is gone. Completed chunks without a snapshot
// stay, since dirty-work retirement still reads them as evidence of what was rebuilt, and chunks of existing snapshots
// stay for availability until the purge drops them with their snapshot or a newer rebuild of the active snapshot drops
// the older groups.

type StaleRebuildRequestCleanupTransaction = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
}

export type StaleRebuildRequestCleanupDatabase = StaleRebuildRequestCleanupTransaction & {
  transaction: <T>(operation: (tx: StaleRebuildRequestCleanupTransaction) => Promise<T>) => Promise<T>
}

export type StaleRebuildRequestCloseReason =
  | 'componentsServed'
  | 'projectArchived'
  | 'projectDeleted'
  | 'projectDeletePending'
  | 'reviewConfigChanged'

export type ClosedStaleRebuildRequest = {
  previousStatus: string
  projectId: string
  reason: StaleRebuildRequestCloseReason
  requestId: string
}

export type CloseStaleReviewServingRebuildRequestsInput = {
  maxChunkRows?: number
  maxProjects?: number
  maxRequests?: number
  nowMs?: () => number
  projectId?: string | null
  settleSeconds?: number
  shouldYield?: () => boolean
}

export type CloseStaleReviewServingRebuildRequestsResult = {
  closedRequests: readonly ClosedStaleRebuildRequest[]
  deletedChunkRows: number
  elapsedMs: number
  failedChunkRows: number
  failedSnapshots: readonly {projectId: string; snapshotId: string}[]
  keptRequestIds: readonly string[]
  stopReason: 'complete' | 'yield'
}

type CloseCandidate = {
  previousStatus: string
  projectId: string
  reason: StaleRebuildRequestCloseReason
  requestId: string
}

type NeverAdmittedRequestRow = {
  projectId: string
  requestedComponentsJson: unknown
  requestId: string
  reviewConfigHash: string | null
  status: string
}

type CleanupRun = {
  maxChunkRows: number
  maxProjects: number
  maxRequests: number
  projectId: string | null
  settleSeconds: number
  shouldYield: () => boolean
}

export const staleReviewServingRebuildRequestLastErrors = {
  componentsServed: 'superseded: the active snapshot serves every component it asked for',
  projectArchived: 'superseded: project archived',
  projectDeleted: 'superseded: project deleted',
  projectDeletePending: 'superseded: project delete pending',
  reviewConfigChanged: 'superseded: review config changed',
} as const satisfies Record<StaleRebuildRequestCloseReason, string>

const closedRequestsCandidateLastError = 'superseded: the rebuild requests building it were closed'
const closedRequestChunkLastError = 'superseded: its rebuild request was closed'
const defaultMaxChunkRows = 100_000
const defaultMaxProjects = 4
const defaultMaxRequests = 64
// Live projects whose never-admitted requests were all kept are looked at again after this long.
const keptProjectRecheckMs = 10 * 60_000
const openRequestStatuses = ['pending_admission', 'admitted', 'running', 'blocked_over_budget', 'quarantined'] as const
const neverAdmittedRequestStatuses = ['pending_admission', 'blocked_over_budget'] as const

let lastKeptProjectCheckAtMs = new Map<string, number>()

export const resetStaleReviewServingRebuildRequestCleanupForTests = () => {
  lastKeptProjectCheckAtMs = new Map()
}

const getSqlList = (values: readonly string[]) => {
  return values.map(getSqlLiteral).join(', ')
}

const getPositiveLimit = (value: number | undefined, fallback: number) => {
  return value === undefined || !Number.isFinite(value) || value < 1 ? fallback : Math.trunc(value)
}

const getProjectFilterSql = (column: string, projectId: string | null) => {
  return projectId === null ? '' : `AND ${column} = ${getSqlLiteral(projectId)}`
}

const getActiveProjectSql = (projectIdSql: string) => {
  return `EXISTS (
    SELECT 1
    FROM app.project active_project
    WHERE active_project.id = ${projectIdSql}
      AND NOT active_project.archived
      AND active_project.delete_pending_at IS NULL
  )`
}

// A project archived (or marked for deletion) a moment ago may be restored just as quickly: its in-flight rebuilds and
// candidates are left alone until it has stayed that way for the settle window (archiving touches updated_at).
const getSettledInactiveProjectSql = (projectIdSql: string, settleSeconds: number) => {
  return `(
    NOT ${getActiveProjectSql(projectIdSql)}
    AND NOT EXISTS (
      SELECT 1
      FROM app.project recently_changed_project
      WHERE recently_changed_project.id = ${projectIdSql}
        AND recently_changed_project.updated_at > current_timestamp - to_seconds(${getSqlLiteral(settleSeconds)})
    )
  )`
}

const getReadmittableFailedRequestSql = (requestAlias: string) => {
  return `(
    ${requestAlias}.status = 'failed'
    AND ${requestAlias}.admission_state = 'admitted'
    AND NOT ${getReviewServingClosedRebuildRequestLastErrorSql(requestAlias)}
    AND ${getReviewServingRebuildRequestReadmittableChunksSql(requestAlias)}
  )`
}

const getClosedRequestSql = (requestAlias: string) => {
  return `(
    ${requestAlias}.status IN ('completed', 'cancelled')
    OR (${requestAlias}.status = 'failed' AND NOT ${getReadmittableFailedRequestSql(requestAlias)})
  )`
}

const getOpenRequestSql = (requestAlias: string) => {
  return `(
    ${requestAlias}.status IN (${getSqlList(openRequestStatuses)})
    OR ${getReadmittableFailedRequestSql(requestAlias)}
  )`
}

// Requests of a project that no longer runs work: any that could still run or be readmitted, except admitted ones
// whose chunks all completed (finalization still promotes their candidate) and ones with a chunk running right now.
const getInactiveProjectClosableRequestSql = (requestAlias: string, settleSeconds: number) => {
  return `(
    ${getSettledInactiveProjectSql(`${requestAlias}.project_id`, settleSeconds)}
    AND (
      ${requestAlias}.status IN ('pending_admission', 'blocked_over_budget', 'quarantined')
      OR (
        ${requestAlias}.status IN ('admitted', 'running')
        AND NOT (
          EXISTS (
            SELECT 1
            FROM app.review_rebuild_chunk_manifest any_chunk
            WHERE any_chunk.request_id = ${requestAlias}.request_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM app.review_rebuild_chunk_manifest unfinished_chunk
            WHERE unfinished_chunk.request_id = ${requestAlias}.request_id
              AND unfinished_chunk.status <> 'completed'
          )
        )
      )
      OR ${getReadmittableFailedRequestSql(requestAlias)}
    )
    AND NOT EXISTS (
      SELECT 1
      FROM app.review_rebuild_chunk_manifest running_chunk
      WHERE running_chunk.request_id = ${requestAlias}.request_id
        AND running_chunk.status = 'running'
    )
  )`
}

const getSettledNeverAdmittedRequestSql = (requestAlias: string, settleSeconds: number) => {
  return `(
    ${getActiveProjectSql(`${requestAlias}.project_id`)}
    AND ${requestAlias}.status IN (${getSqlList(neverAdmittedRequestStatuses)})
    AND ${requestAlias}.updated_at <= current_timestamp - to_seconds(${getSqlLiteral(settleSeconds)})
  )`
}

const getInactiveProjectCloseCandidates = async (run: CleanupRun, database: StaleRebuildRequestCleanupDatabase) => {
  return database.queryJson<CloseCandidate>(`
    SELECT
      request.request_id AS requestId,
      request.project_id AS projectId,
      request.status AS previousStatus,
      CASE
        WHEN project.id IS NULL THEN 'projectDeleted'
        WHEN project.delete_pending_at IS NOT NULL THEN 'projectDeletePending'
        ELSE 'projectArchived'
      END AS reason
    FROM app.review_rebuild_request request
    LEFT JOIN app.project project
      ON project.id = request.project_id
    WHERE ${getInactiveProjectClosableRequestSql('request', run.settleSeconds)}
      ${getProjectFilterSql('request.project_id', run.projectId)}
    ORDER BY request.updated_at ASC, request.request_id ASC
    LIMIT ${getSqlLiteral(run.maxRequests)}
  `)
}

// Candidates of inactive projects and candidates of the requests just closed, unless something still builds them: an
// unfinished chunk, a request that is open or would be readmitted, or a requestless bootstrap naming it.
const failUnbuiltCandidateSnapshots = async (
  input: {closedRequestIds: readonly string[]; projectId: string | null; settleSeconds: number},
  tx: StaleRebuildRequestCleanupTransaction,
) => {
  const {closedRequestIds} = input
  const closedRequestChunkSql =
    closedRequestIds.length === 0
      ? 'FALSE'
      : `EXISTS (
        SELECT 1
        FROM app.review_rebuild_chunk_manifest closed_chunk
        WHERE closed_chunk.project_id = snapshot.project_id
          AND closed_chunk.snapshot_id = snapshot.snapshot_id
          AND closed_chunk.request_id IN (${getSqlList(closedRequestIds)})
      )`

  return tx.queryJson<{projectId: string; snapshotId: string}>(`
    UPDATE app.review_serving_snapshot_manifest AS snapshot
    SET
      snapshot_status = 'failed',
      failed_at = current_timestamp,
      last_error = CASE
        WHEN NOT EXISTS (SELECT 1 FROM app.project project WHERE project.id = snapshot.project_id)
          THEN ${getSqlLiteral(staleReviewServingRebuildRequestLastErrors.projectDeleted)}
        WHEN EXISTS (
          SELECT 1 FROM app.project project WHERE project.id = snapshot.project_id AND project.delete_pending_at IS NOT NULL
        )
          THEN ${getSqlLiteral(staleReviewServingRebuildRequestLastErrors.projectDeletePending)}
        WHEN EXISTS (SELECT 1 FROM app.project project WHERE project.id = snapshot.project_id AND project.archived)
          THEN ${getSqlLiteral(staleReviewServingRebuildRequestLastErrors.projectArchived)}
        ELSE ${getSqlLiteral(closedRequestsCandidateLastError)}
      END,
      updated_at = current_timestamp
    WHERE snapshot.snapshot_status = 'candidate'
      AND (${getSettledInactiveProjectSql('snapshot.project_id', input.settleSeconds)} OR ${closedRequestChunkSql})
      ${getProjectFilterSql('snapshot.project_id', input.projectId)}
      AND NOT EXISTS (
        SELECT 1
        FROM app.review_rebuild_chunk_manifest builder_chunk
        LEFT JOIN app.review_rebuild_request builder_request
          ON builder_request.request_id = builder_chunk.request_id
        WHERE builder_chunk.project_id = snapshot.project_id
          AND builder_chunk.snapshot_id = snapshot.snapshot_id
          AND (builder_chunk.status IN ('pending', 'running') OR ${getOpenRequestSql('builder_request')})
      )
      AND NOT EXISTS (
        SELECT 1
        FROM app.review_rebuild_request identity_request
        WHERE identity_request.project_id = snapshot.project_id
          AND json_extract_string(identity_request.identity_json, '$.snapshotId') = snapshot.snapshot_id
          AND ${getOpenRequestSql('identity_request')}
      )
    RETURNING snapshot.project_id AS projectId, snapshot.snapshot_id AS snapshotId
  `)
}

const closeRequestsForReason = async (
  input: {closableSql: string; reason: StaleRebuildRequestCloseReason; requestIds: readonly string[]},
  tx: StaleRebuildRequestCleanupTransaction,
) => {
  const lastError = staleReviewServingRebuildRequestLastErrors[input.reason]
  const closed = await tx.queryJson<{requestId: string}>(`
    UPDATE app.review_rebuild_request AS request
    SET
      status = 'failed',
      failed_at = COALESCE(request.failed_at, current_timestamp),
      last_error = ${getSqlLiteral(lastError)} || COALESCE(' (was: ' || request.last_error || ')', ''),
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = current_timestamp
    WHERE request.request_id IN (${getSqlList(input.requestIds)})
      AND ${input.closableSql}
    RETURNING request.request_id AS requestId
  `)
  const closedRequestIds = closed.map((row) => {
    return row.requestId
  })

  if (closedRequestIds.length > 0) {
    await tx.run(`
      UPDATE app.review_rebuild_chunk_manifest
      SET
        status = 'failed',
        last_error = ${getSqlLiteral(lastError)},
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = current_timestamp
      WHERE request_id IN (${getSqlList(closedRequestIds)})
        AND status = 'pending'
    `)
  }

  return closedRequestIds
}

// One transaction per batch: requests fail with their unstarted chunks, then the candidates nobody builds any more
// (which also catches candidates of inactive projects that no request names at all).
const closeRequests = async (
  input: {candidates: readonly CloseCandidate[]; closableSql: string; projectId: string | null; settleSeconds: number},
  database: StaleRebuildRequestCleanupDatabase,
) => {
  const reasons = [
    ...new Set(
      input.candidates.map((candidate) => {
        return candidate.reason
      }),
    ),
  ]

  return database.transaction(async (tx) => {
    const closedRequestIds = await reasons.reduce<Promise<string[]>>(async (previous, reason) => {
      const closedSoFar = await previous
      const requestIds = input.candidates.flatMap((candidate) => {
        return candidate.reason === reason ? [candidate.requestId] : []
      })

      return [
        ...closedSoFar,
        ...(await closeRequestsForReason({closableSql: input.closableSql, reason, requestIds}, tx)),
      ]
    }, Promise.resolve([]))
    const failedSnapshots = await failUnbuiltCandidateSnapshots(
      {closedRequestIds, projectId: input.projectId, settleSeconds: input.settleSeconds},
      tx,
    )
    const closedRequestIdSet = new Set(closedRequestIds)

    return {
      closedRequests: input.candidates.filter((candidate) => {
        return closedRequestIdSet.has(candidate.requestId)
      }),
      failedSnapshots,
    }
  })
}

const getLiveProjectIdsToCheck = async (
  run: CleanupRun,
  nowMs: number,
  database: StaleRebuildRequestCleanupDatabase,
) => {
  lastKeptProjectCheckAtMs = new Map(
    [...lastKeptProjectCheckAtMs.entries()].filter(([, checkedAtMs]) => {
      return nowMs - checkedAtMs < keptProjectRecheckMs
    }),
  )

  const recentlyKeptProjectIds = [...lastKeptProjectCheckAtMs.keys()]
  const rows = await database.queryJson<{projectId: string}>(`
    SELECT request.project_id AS projectId
    FROM app.review_rebuild_request request
    WHERE ${getSettledNeverAdmittedRequestSql('request', run.settleSeconds)}
      ${getProjectFilterSql('request.project_id', run.projectId)}
      ${recentlyKeptProjectIds.length === 0 ? '' : `AND request.project_id NOT IN (${getSqlList(recentlyKeptProjectIds)})`}
    GROUP BY request.project_id
    ORDER BY MIN(request.updated_at) ASC, request.project_id ASC
    LIMIT ${getSqlLiteral(run.maxProjects)}
  `)

  return rows.map((row) => {
    return row.projectId
  })
}

const getNeverAdmittedRequests = async (
  input: {projectIds: readonly string[]; settleSeconds: number},
  database: StaleRebuildRequestCleanupDatabase,
) => {
  return database.queryJson<NeverAdmittedRequestRow>(`
    SELECT
      request.request_id AS requestId,
      request.project_id AS projectId,
      request.status,
      request.requested_components_json AS requestedComponentsJson,
      json_extract_string(request.identity_json, '$.reviewConfigHash') AS reviewConfigHash
    FROM app.review_rebuild_request request
    WHERE request.project_id IN (${getSqlList(input.projectIds)})
      AND ${getSettledNeverAdmittedRequestSql('request', input.settleSeconds)}
    ORDER BY request.updated_at ASC, request.request_id ASC
  `)
}

const getOpenDirtyWorkComponents = async (
  projectIds: readonly string[],
  database: StaleRebuildRequestCleanupDatabase,
) => {
  const rows = await database.queryJson<{component: string; projectId: string}>(`
    SELECT project_id AS projectId, projection_component AS component
    FROM app.review_serving_dirty_work
    WHERE project_id IN (${getSqlList(projectIds)})
      AND status <> 'completed'
    GROUP BY project_id, projection_component
  `)

  return rows.reduce((components, row) => {
    return components.set(row.projectId, new Set([...(components.get(row.projectId) ?? []), row.component]))
  }, new Map<string, Set<string>>())
}

// A request planned before review configs were recorded carries none; like the planner's request reuse, it counts as
// planned for the current config only when one of its chunks builds a snapshot of that config.
const getRequestIdsWithChunksOfReviewConfig = async (
  input: {requestIds: readonly string[]; reviewConfigHash: string},
  database: StaleRebuildRequestCleanupDatabase,
) => {
  const rows =
    input.requestIds.length === 0
      ? []
      : await database.queryJson<{requestId: string}>(`
        SELECT DISTINCT chunk.request_id AS requestId
        FROM app.review_rebuild_chunk_manifest chunk
        INNER JOIN app.review_serving_snapshot_manifest snapshot
          ON snapshot.project_id = chunk.project_id
          AND snapshot.snapshot_id = chunk.snapshot_id
        WHERE chunk.request_id IN (${getSqlList(input.requestIds)})
          AND snapshot.review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
      `)

  return new Set(
    rows.map((row) => {
      return row.requestId
    }),
  )
}

const getRequestedComponents = (value: unknown): ReviewServingProjectionComponent[] => {
  const parsed = getJsonValue(value)

  return Array.isArray(parsed)
    ? parsed.filter((component): component is ReviewServingProjectionComponent => {
        return typeof component === 'string' && isReviewServingProjectionComponent(component)
      })
    : []
}

const getServedComponents = async (
  input: {projectId: string; reviewConfigHash: string},
  database: StaleRebuildRequestCleanupDatabase,
) => {
  const active = await getActiveReviewServingSnapshotManifest(
    {componentStateMode: 'available', projectId: input.projectId, reviewConfigHash: input.reviewConfigHash},
    database,
  )

  return new Set(
    [...(active?.componentState.required ?? []), ...(active?.componentState.optional ?? [])].map((state) => {
      return state.component
    }),
  )
}

const getSupersededReason = (input: {
  currentConfigRequestIds: ReadonlySet<string>
  openDirtyComponents: ReadonlySet<string>
  request: NeverAdmittedRequestRow
  reviewConfigHash: string
  servedComponents: ReadonlySet<string>
}): StaleRebuildRequestCloseReason | null => {
  const plannedForCurrentConfig =
    input.request.reviewConfigHash === null
      ? input.currentConfigRequestIds.has(input.request.requestId)
      : input.request.reviewConfigHash === input.reviewConfigHash
  const requestedComponents = getRequestedComponents(input.request.requestedComponentsJson)
  const served = requestedComponents.every((component) => {
    return input.servedComponents.has(component) && !input.openDirtyComponents.has(component)
  })

  return !plannedForCurrentConfig ? 'reviewConfigChanged' : served ? 'componentsServed' : null
}

const getProjectCloseCandidates = async (
  input: {openDirtyComponents: ReadonlySet<string>; projectId: string; requests: readonly NeverAdmittedRequestRow[]},
  database: StaleRebuildRequestCleanupDatabase,
) => {
  const reviewConfigHash = await getCurrentReviewServingReviewConfigHash(input.projectId, database)

  if (reviewConfigHash === null) {
    return {
      closeCandidates: [],
      keptRequestIds: input.requests.map((request) => {
        return request.requestId
      }),
    }
  }

  const [servedComponents, currentConfigRequestIds] = await Promise.all([
    getServedComponents({projectId: input.projectId, reviewConfigHash}, database),
    getRequestIdsWithChunksOfReviewConfig(
      {
        requestIds: input.requests.flatMap((request) => {
          return request.reviewConfigHash === null ? [request.requestId] : []
        }),
        reviewConfigHash,
      },
      database,
    ),
  ])
  const classified = input.requests.map((request) => {
    return {
      reason: getSupersededReason({
        currentConfigRequestIds,
        openDirtyComponents: input.openDirtyComponents,
        request,
        reviewConfigHash,
        servedComponents,
      }),
      request,
    }
  })

  return {
    closeCandidates: classified.flatMap(({reason, request}): CloseCandidate[] => {
      return reason === null
        ? []
        : [{previousStatus: request.status, projectId: request.projectId, reason, requestId: request.requestId}]
    }),
    keptRequestIds: classified.flatMap(({reason, request}) => {
      return reason === null ? [request.requestId] : []
    }),
  }
}

const getLiveProjectCloseCandidates = async (
  run: CleanupRun,
  nowMs: number,
  database: StaleRebuildRequestCleanupDatabase,
) => {
  const projectIds = await getLiveProjectIdsToCheck(run, nowMs, database)

  if (projectIds.length === 0) {
    return {closeCandidates: [], keptRequestIds: []}
  }

  const [requests, openDirtyComponents] = await Promise.all([
    getNeverAdmittedRequests({projectIds, settleSeconds: run.settleSeconds}, database),
    getOpenDirtyWorkComponents(projectIds, database),
  ])

  return projectIds.reduce<Promise<{closeCandidates: CloseCandidate[]; keptRequestIds: string[]}>>(
    async (previous, projectId) => {
      const result = await previous
      const project = await getProjectCloseCandidates(
        {
          openDirtyComponents: openDirtyComponents.get(projectId) ?? new Set(),
          projectId,
          requests: requests.filter((request) => {
            return request.projectId === projectId
          }),
        },
        database,
      )

      if (project.keptRequestIds.length > 0) {
        lastKeptProjectCheckAtMs.set(projectId, nowMs)
      }

      return {
        closeCandidates: [...result.closeCandidates, ...project.closeCandidates],
        keptRequestIds: [...result.keptRequestIds, ...project.keptRequestIds],
      }
    },
    Promise.resolve({closeCandidates: [], keptRequestIds: []}),
  )
}

// Never-built chunk rows without a snapshot, and every chunk row whose snapshot is gone, of requests that are closed.
const deleteUnreadableClosedRequestChunks = async (run: CleanupRun, database: StaleRebuildRequestCleanupDatabase) => {
  const [row] = await database.queryJson<{Count: number | string}>(`
    DELETE FROM app.review_rebuild_chunk_manifest
    WHERE rowid IN (
      SELECT chunk.rowid
      FROM app.review_rebuild_chunk_manifest chunk
      INNER JOIN app.review_rebuild_request request
        ON request.request_id = chunk.request_id
      LEFT JOIN app.review_serving_snapshot_manifest snapshot
        ON snapshot.project_id = chunk.project_id
        AND snapshot.snapshot_id = chunk.snapshot_id
      WHERE ${getClosedRequestSql('request')}
        AND chunk.status <> 'running'
        AND (
          (chunk.snapshot_id IS NULL AND chunk.status <> 'completed')
          OR (chunk.snapshot_id IS NOT NULL AND snapshot.snapshot_id IS NULL)
        )
        ${getProjectFilterSql('chunk.project_id', run.projectId)}
      LIMIT ${getSqlLiteral(run.maxChunkRows)}
    )
  `)

  return Number(row?.Count ?? 0)
}

// Pending chunks of closed requests never run (claims need an admitted request, readmission skips closed ones), but
// candidate cleanup, the in-flight checks and the purge all read a pending chunk as work in progress on its snapshot.
const failUnstartedClosedRequestChunks = async (run: CleanupRun, database: StaleRebuildRequestCleanupDatabase) => {
  const [row] = await database.queryJson<{Count: number | string}>(`
    UPDATE app.review_rebuild_chunk_manifest
    SET
      status = 'failed',
      last_error = COALESCE(last_error, ${getSqlLiteral(closedRequestChunkLastError)}),
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = current_timestamp
    WHERE rowid IN (
      SELECT chunk.rowid
      FROM app.review_rebuild_chunk_manifest chunk
      INNER JOIN app.review_rebuild_request request
        ON request.request_id = chunk.request_id
      WHERE chunk.status = 'pending'
        AND ${getClosedRequestSql('request')}
        ${getProjectFilterSql('chunk.project_id', run.projectId)}
      LIMIT ${getSqlLiteral(run.maxChunkRows)}
    )
  `)

  return Number(row?.Count ?? 0)
}

export const closeStaleReviewServingRebuildRequests = async (
  input: CloseStaleReviewServingRebuildRequestsInput = {},
  database: StaleRebuildRequestCleanupDatabase = getAppDatabaseService(),
): Promise<CloseStaleReviewServingRebuildRequestsResult> => {
  const nowMs = input.nowMs ?? Date.now
  const startedAtMs = nowMs()
  const run: CleanupRun = {
    maxChunkRows: getPositiveLimit(input.maxChunkRows, defaultMaxChunkRows),
    maxProjects: getPositiveLimit(input.maxProjects, defaultMaxProjects),
    maxRequests: getPositiveLimit(input.maxRequests, defaultMaxRequests),
    projectId: input.projectId ?? null,
    settleSeconds: getPositiveLimit(input.settleSeconds, defaultReviewServingDirtyWorkBlockedByRebuildRequeueSeconds),
    shouldYield:
      input.shouldYield
      ?? (() => {
        return false
      }),
  }
  const failedChunkRows = await failUnstartedClosedRequestChunks(run, database)
  const inactive = await closeRequests(
    {
      candidates: await getInactiveProjectCloseCandidates(run, database),
      closableSql: getInactiveProjectClosableRequestSql('request', run.settleSeconds),
      projectId: run.projectId,
      settleSeconds: run.settleSeconds,
    },
    database,
  )
  const liveCandidates = run.shouldYield() ? null : await getLiveProjectCloseCandidates(run, startedAtMs, database)
  const live =
    liveCandidates === null || liveCandidates.closeCandidates.length === 0
      ? {closedRequests: [], failedSnapshots: []}
      : await closeRequests(
          {
            candidates: liveCandidates.closeCandidates,
            closableSql: getSettledNeverAdmittedRequestSql('request', run.settleSeconds),
            projectId: run.projectId,
            settleSeconds: run.settleSeconds,
          },
          database,
        )
  const deletedChunkRows =
    liveCandidates === null || run.shouldYield() ? null : await deleteUnreadableClosedRequestChunks(run, database)

  return {
    closedRequests: [...inactive.closedRequests, ...live.closedRequests],
    deletedChunkRows: deletedChunkRows ?? 0,
    elapsedMs: Math.max(0, nowMs() - startedAtMs),
    failedChunkRows,
    failedSnapshots: [...inactive.failedSnapshots, ...live.failedSnapshots],
    keptRequestIds: liveCandidates?.keptRequestIds ?? [],
    stopReason: deletedChunkRows === null ? 'yield' : 'complete',
  }
}
