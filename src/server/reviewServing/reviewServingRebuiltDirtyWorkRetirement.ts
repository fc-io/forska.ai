import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getJsonValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import type {ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import {
  completeReviewServingDirtyWorkRebuiltByChunks,
  getReviewServingDirtyWorkRecordFromRow,
  getReviewServingDirtyWorkRecordSelectSql,
  type ReviewServingDirtyWorkDatabase,
} from './reviewServingDirtyWorkService.ts'
import {getReviewServingJsonRowsSql} from './reviewServingJsonRowSource.ts'

// A bootstrap rebuild re-reads every article of a component from source, but per-article dirty work queued before the
// rebuild ran stays pending, because rebuild watermarks only cover the source partitions the request knew about. On
// one project ~5M enrichment rows (posting, summary, search, payload, judgment input) queued behind a rebuild that
// rewrote all of them, draining through incremental patches at a few thousand rows an hour. Once the rebuilt snapshot
// is active and no candidate also carries the component, a pending row whose article a completed chunk started to
// rebuild after the row last changed is complete: the chunk read the change.

const retirementSelectLimit = 16_384
const retirementCompletionBatchSize = 4_096
const idleRecheckIntervalMs = 60_000
// A chunk that completed while the previous scan ran may not have been visible to it; later scans look back this far.
const retirementCursorSlackMs = 5 * 60_000

// Pending rows only become retirable when a covering chunk completes (or its snapshot becomes the only one carrying the
// component), so each target remembers when it was last drained and later scans only consider chunks completed since.
const retirementCursorAtMsByTarget = new Map<string, number>()
let lastIdleRetirementCheckAtMs: number | null = null

type ReviewServingRetirementDatabase = Pick<ReviewServingDirtyWorkDatabase, 'queryJson' | 'transaction'>

type SnapshotManifestRow = {
  componentStateJson: unknown
  optionalComponentsJson: unknown
  projectId: string
  requiredComponentsJson: unknown
  snapshotId: string
  snapshotStatus: string
}

type RetirementTarget = {
  baseGeneration: number
  component: ReviewServingProjectionComponent
  projectId: string
  projectionIdentity: string
  snapshotId: string
}

const getRetirementTargetKey = (target: RetirementTarget) => {
  return [target.projectId, target.snapshotId, target.component, target.projectionIdentity, target.baseGeneration].join(
    '\u0000',
  )
}

const getComponentList = (value: unknown) => {
  const parsed = getJsonValue(value)

  return Array.isArray(parsed)
    ? parsed.flatMap((entry) => {
        const component =
          typeof entry === 'string'
            ? entry
            : entry !== null && typeof entry === 'object' && 'component' in entry
              ? (entry as {component: unknown}).component
              : null

        return typeof component === 'string' ? [component] : []
      })
    : []
}

const getComponentStates = (value: unknown) => {
  const parsed = getJsonValue(value)

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return []
  }

  const {optional, required} = parsed as {optional?: unknown; required?: unknown}
  const states: unknown[] = [
    ...(Array.isArray(required) ? (required as unknown[]) : []),
    ...(Array.isArray(optional) ? (optional as unknown[]) : []),
  ]

  return states.flatMap((state: unknown) => {
    if (state === null || typeof state !== 'object') {
      return []
    }

    const {baseGeneration, component, projectionIdentity} = state as Record<string, unknown>
    const generation = Number(baseGeneration)

    return typeof component === 'string' && typeof projectionIdentity === 'string' && Number.isFinite(generation)
      ? [{baseGeneration: generation, component: component as ReviewServingProjectionComponent, projectionIdentity}]
      : []
  })
}

// Components of active snapshots that no candidate of the same project also carries: patches for them only go to the
// active snapshot, so its own rebuild coverage decides whether a pending row still needs one.
const getRetirementTargets = async (
  input: {projectId?: string | null},
  database: ReviewServingRetirementDatabase,
): Promise<readonly RetirementTarget[]> => {
  const rows = await database.queryJson<SnapshotManifestRow>(`
    SELECT
      project_id AS projectId,
      snapshot_id AS snapshotId,
      snapshot_status AS snapshotStatus,
      component_state_json AS componentStateJson,
      required_components_json AS requiredComponentsJson,
      optional_components_json AS optionalComponentsJson
    FROM app.review_serving_snapshot_manifest
    WHERE snapshot_status IN ('active', 'candidate')
      ${input.projectId ? `AND project_id = ${getSqlLiteral(input.projectId)}` : ''}
  `)
  const candidateComponentsByProject = rows
    .filter((row) => {
      return row.snapshotStatus === 'candidate'
    })
    .reduce((components, row) => {
      const projectComponents = components.get(row.projectId) ?? new Set<string>()

      ;[...getComponentList(row.requiredComponentsJson), ...getComponentList(row.optionalComponentsJson)].forEach(
        (component) => {
          projectComponents.add(component)
        },
      )

      return components.set(row.projectId, projectComponents)
    }, new Map<string, Set<string>>())

  return rows
    .filter((row) => {
      return row.snapshotStatus === 'active'
    })
    .flatMap((row) => {
      const candidateComponents = candidateComponentsByProject.get(row.projectId)

      return getComponentStates(row.componentStateJson)
        .filter((state) => {
          return candidateComponents?.has(state.component) !== true
        })
        .map((state) => {
          return {...state, projectId: row.projectId, snapshotId: row.snapshotId}
        })
    })
}

const getRebuiltRangeCteSql = (targets: readonly RetirementTarget[]) => {
  return `
    retirement_target AS (
      ${getReviewServingJsonRowsSql({
        columns: [
          {name: 'project_id', type: 'VARCHAR'},
          {name: 'snapshot_id', type: 'VARCHAR'},
          {name: 'projection_component', type: 'VARCHAR'},
          {name: 'projection_identity', type: 'VARCHAR'},
          {name: 'output_base_generation', type: 'BIGINT'},
          {name: 'completed_after', type: 'TIMESTAMPTZ'},
        ],
        rows: targets.map((target) => {
          const cursorAtMs = retirementCursorAtMsByTarget.get(getRetirementTargetKey(target))

          return [
            target.projectId,
            target.snapshotId,
            target.component,
            target.projectionIdentity,
            target.baseGeneration,
            cursorAtMs === undefined ? null : new Date(cursorAtMs),
          ]
        }),
      })}
    ),
    rebuilt_range AS (
      SELECT
        target.project_id,
        target.snapshot_id,
        target.projection_component,
        target.projection_identity,
        target.output_base_generation,
        chunk.chunk_start_key,
        chunk.chunk_end_key,
        chunk.started_at
      FROM app.review_rebuild_chunk_manifest chunk
      INNER JOIN retirement_target target
        ON target.project_id = chunk.project_id
        AND target.projection_component = chunk.projection_component
        AND target.projection_identity = chunk.projection_identity
        AND target.output_base_generation = chunk.output_base_generation
        AND (chunk.snapshot_id IS NULL OR chunk.snapshot_id = target.snapshot_id)
      WHERE chunk.status = 'completed'
        AND chunk.started_at IS NOT NULL
        AND (target.completed_after IS NULL OR chunk.completed_at >= target.completed_after)
        AND COALESCE(chunk.checksum, '') NOT LIKE 'split:%'
        AND COALESCE(chunk.last_error, '') NOT LIKE 'superseded%'
        AND COALESCE(chunk.last_error, '') NOT LIKE 'coalesced%'
    )
  `
}

// Targets with chunks completed since their cursor; only those need a dirty-work scan.
const getTargetsWithRebuiltRanges = async (
  targets: readonly RetirementTarget[],
  database: ReviewServingRetirementDatabase,
) => {
  if (targets.length === 0) {
    return []
  }

  const rows = await database.queryJson<{
    baseGeneration: number | string
    component: ReviewServingProjectionComponent
    projectId: string
    projectionIdentity: string
    snapshotId: string
  }>(`
    WITH ${getRebuiltRangeCteSql(targets)}
    SELECT DISTINCT
      project_id AS projectId,
      snapshot_id AS snapshotId,
      projection_component AS component,
      projection_identity AS projectionIdentity,
      output_base_generation AS baseGeneration
    FROM rebuilt_range
  `)
  const rebuiltTargetKeys = new Set(
    rows.map((row) => {
      return getRetirementTargetKey({...row, baseGeneration: Number(row.baseGeneration)})
    }),
  )

  return targets.filter((target) => {
    return rebuiltTargetKeys.has(getRetirementTargetKey(target))
  })
}

// Rows older than the newest covering chunk of their component are narrowed first, then matched to a chunk range that
// started after them.
const getRetirableDirtyWorkSql = (targets: readonly RetirementTarget[]) => {
  return `
    WITH ${getRebuiltRangeCteSql(targets)},
    rebuilt_component AS (
      SELECT project_id, projection_component, projection_identity, MAX(started_at) AS latest_started_at
      FROM rebuilt_range
      GROUP BY project_id, projection_component, projection_identity
    ),
    older_dirty_work AS (
      SELECT
        dirty_work.dirty_work_id,
        dirty_work.project_id,
        dirty_work.projection_component,
        dirty_work.projection_identity,
        dirty_work.article_id,
        dirty_work.updated_at
      FROM app.review_serving_dirty_work dirty_work
      INNER JOIN rebuilt_component
        ON rebuilt_component.project_id = dirty_work.project_id
        AND rebuilt_component.projection_component = dirty_work.projection_component
        AND rebuilt_component.projection_identity = dirty_work.projection_identity
        AND dirty_work.updated_at < rebuilt_component.latest_started_at
      WHERE dirty_work.status IN ('pending', 'blocked_by_rebuild')
        AND dirty_work.article_id IS NOT NULL
    ),
    retirable AS (
      SELECT DISTINCT older_dirty_work.dirty_work_id
      FROM older_dirty_work
      INNER JOIN rebuilt_range
        ON rebuilt_range.project_id = older_dirty_work.project_id
        AND rebuilt_range.projection_component = older_dirty_work.projection_component
        AND rebuilt_range.projection_identity = older_dirty_work.projection_identity
        AND older_dirty_work.article_id >= rebuilt_range.chunk_start_key
        AND older_dirty_work.article_id <= rebuilt_range.chunk_end_key
        AND older_dirty_work.updated_at < rebuilt_range.started_at
      LIMIT ${retirementSelectLimit}
    )
    ${getReviewServingDirtyWorkRecordSelectSql('dirty_work')}
    WHERE dirty_work.dirty_work_id IN (SELECT dirty_work_id FROM retirable)
      AND dirty_work.status IN ('pending', 'blocked_by_rebuild')
  `
}

export type RetireReviewServingRebuiltDirtyWorkResult = {retiredCount: number; scanned: boolean}

export const retireReviewServingDirtyWorkRebuiltByChunks = async (
  input: {nowMs?: number; projectId?: string | null} = {},
  database: ReviewServingRetirementDatabase = getAppDatabaseService() as ReviewServingRetirementDatabase,
): Promise<RetireReviewServingRebuiltDirtyWorkResult> => {
  const nowMs = input.nowMs ?? Date.now()

  if (lastIdleRetirementCheckAtMs !== null && nowMs - lastIdleRetirementCheckAtMs < idleRecheckIntervalMs) {
    return {retiredCount: 0, scanned: false}
  }

  const targets = await getRetirementTargets(input, database)
  const rebuiltTargets = await getTargetsWithRebuiltRanges(targets, database)
  const rows =
    rebuiltTargets.length === 0 ? [] : await database.queryJson<unknown>(getRetirableDirtyWorkSql(rebuiltTargets))
  const claims = rows.map(getReviewServingDirtyWorkRecordFromRow)

  if (claims.length < retirementSelectLimit) {
    targets.forEach((target) => {
      retirementCursorAtMsByTarget.set(getRetirementTargetKey(target), nowMs - retirementCursorSlackMs)
    })
  }

  lastIdleRetirementCheckAtMs = claims.length === 0 ? nowMs : null

  let retiredCount = 0

  for (let offset = 0; offset < claims.length; offset += retirementCompletionBatchSize) {
    const batch = claims.slice(offset, offset + retirementCompletionBatchSize)
    const completion = await database.transaction((tx) => {
      return completeReviewServingDirtyWorkRebuiltByChunks(batch, tx)
    })

    retiredCount += completion.completedCount
  }

  return {retiredCount, scanned: true}
}

export const resetReviewServingRebuiltDirtyWorkRetirementForTests = () => {
  lastIdleRetirementCheckAtMs = null
  retirementCursorAtMsByTarget.clear()
}
