import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {HttpError} from '../utils/httpError.ts'
import {
  projectReviewServingHumanStatusRanges,
  type ReviewServingHumanStatusProjectorDatabase,
} from './reviewServingHumanStatusProjector.ts'

type SnapshotManifestRow = {
  componentStateJson: unknown
  reviewConfigHash: string | null
  snapshotId: string
  snapshotStatus: string
}

type SnapshotGenerationRow = {baseGeneration: number | string; snapshotId: string}

type HumanStatusCountRow = {
  answered: number | string | null
  noStatus: number | string | null
  reviewConfigHash: string | null
  rows: number | string | null
  snapshotId: string
  unanswered: number | string | null
}

export type ReviewServingHumanStatusCounts = {answered: number; noStatus: number; rows: number; unanswered: number}

export type ReviewServingHumanStatusReprojectSnapshot = {
  after: ReviewServingHumanStatusCounts
  baseGenerations: number[]
  before: ReviewServingHumanStatusCounts
  projectionIdentity: string
  reviewConfigHash: string | null
  snapshotId: string
  snapshotStatus: string
}

export type ReviewServingHumanStatusReprojectResult = {
  answered: number
  durationMs: number
  humanJudgmentMode: 'prompt' | 'summary'
  noStatus: number
  projectId: string
  rangeCount: number
  rowsUpdated: number
  snapshots: ReviewServingHumanStatusReprojectSnapshot[]
  unanswered: number
}

const reprojectListModeKeys = ['human', 'both'] as const
const emptyCounts: ReviewServingHumanStatusCounts = {answered: 0, noStatus: 0, rows: 0, unanswered: 0}

const parseJson = (value: unknown) => {
  if (typeof value !== 'string') {
    return value
  }

  try {
    return JSON.parse(value) as unknown
  } catch (_error) {
    return null
  }
}

const getHumanStatusProjectionIdentity = (componentStateJson: unknown) => {
  const componentState = parseJson(componentStateJson)

  if (componentState === null || typeof componentState !== 'object') {
    return null
  }

  const entries = ['required', 'optional'].flatMap((group) => {
    const value = (componentState as Record<string, unknown>)[group]

    return Array.isArray(value) ? (value as unknown[]) : []
  })
  const humanStatusEntry = entries.find((entry) => {
    return (
      entry !== null
      && typeof entry === 'object'
      && (entry as Record<string, unknown>).component === 'humanStatus'
      && typeof (entry as Record<string, unknown>).projectionIdentity === 'string'
    )
  }) as {projectionIdentity: string} | undefined

  return humanStatusEntry?.projectionIdentity ?? null
}

const getHumanStatusCounts = async (
  input: {projectId: string; snapshotIds: readonly string[]},
  database: ReviewServingHumanStatusProjectorDatabase,
) => {
  const rows =
    input.snapshotIds.length === 0
      ? []
      : await database.queryJson<HumanStatusCountRow>(`
          SELECT
            state.snapshot_id AS snapshotId,
            state.review_config_hash AS reviewConfigHash,
            COUNT(*) AS rows,
            COUNT(*) FILTER (WHERE state.human_status = 'answered') AS answered,
            COUNT(*) FILTER (WHERE state.human_status = 'unanswered') AS unanswered,
            COUNT(*) FILTER (WHERE state.human_status IS NULL) AS noStatus
          FROM mart.review_article_serving_list_mode_state_v4 state
          WHERE state.project_id = ${getSqlLiteral(input.projectId)}
            AND state.snapshot_id IN (${input.snapshotIds.map(getSqlLiteral).join(', ')})
          GROUP BY state.snapshot_id, state.review_config_hash
        `)

  return new Map(
    rows.map((row) => {
      return [
        `${row.snapshotId}\u0000${row.reviewConfigHash ?? ''}`,
        {
          answered: Number(row.answered ?? 0),
          noStatus: Number(row.noStatus ?? 0),
          rows: Number(row.rows ?? 0),
          unanswered: Number(row.unanswered ?? 0),
        },
      ]
    }),
  )
}

// Re-derives human_status for every served article of one project through the set-based range replacement
// used by config-hash rebuild chunks. human_patch_watermark is left as is: the range replacement only
// raises it (GREATEST(existing, 0)), later patches still GREATEST() their claim watermark into it, and no
// reader gates on it, so neither direction can regress or block a later write.
export const reprojectReviewServingHumanStatus = async (
  input: {projectId: string},
  database: ReviewServingHumanStatusProjectorDatabase = getAppDatabaseService() as ReviewServingHumanStatusProjectorDatabase,
): Promise<ReviewServingHumanStatusReprojectResult> => {
  const startedAtMs = Date.now()
  const [project] = await database.queryJson<{humanJudgmentMode: string | null}>(`
    SELECT COALESCE(project.human_judgment_mode, 'prompt') AS humanJudgmentMode
    FROM app.project project
    WHERE project.id = ${getSqlLiteral(input.projectId)}
    LIMIT 1
  `)

  if (project === undefined) {
    throw new HttpError(404, 'Project not found')
  }

  const snapshotRows = await database.queryJson<SnapshotManifestRow>(`
    SELECT
      snapshot.snapshot_id AS snapshotId,
      snapshot.snapshot_status AS snapshotStatus,
      snapshot.review_config_hash AS reviewConfigHash,
      snapshot.component_state_json AS componentStateJson
    FROM app.review_serving_snapshot_manifest snapshot
    WHERE snapshot.project_id = ${getSqlLiteral(input.projectId)}
      AND snapshot.snapshot_status IN ('candidate', 'active')
    ORDER BY snapshot.snapshot_id
  `)
  const snapshots = snapshotRows.flatMap((row) => {
    const projectionIdentity = getHumanStatusProjectionIdentity(row.componentStateJson)

    return projectionIdentity === null ? [] : [{...row, projectionIdentity}]
  })
  const snapshotIds = snapshots.map((snapshot) => {
    return snapshot.snapshotId
  })
  const generationRows =
    snapshotIds.length === 0
      ? []
      : await database.queryJson<SnapshotGenerationRow>(`
          SELECT DISTINCT serving.snapshot_id AS snapshotId, serving.base_generation AS baseGeneration
          FROM mart.review_article_serving_base_v4 serving
          WHERE serving.project_id = ${getSqlLiteral(input.projectId)}
            AND serving.snapshot_id IN (${snapshotIds.map(getSqlLiteral).join(', ')})
          ORDER BY serving.snapshot_id, serving.base_generation
        `)
  const baseGenerationsBySnapshot = new Map<string, number[]>()

  generationRows.forEach((row) => {
    baseGenerationsBySnapshot.set(row.snapshotId, [
      ...(baseGenerationsBySnapshot.get(row.snapshotId) ?? []),
      Number(row.baseGeneration),
    ])
  })

  const ranges = [
    ...new Map(
      snapshots.flatMap((snapshot) => {
        return (baseGenerationsBySnapshot.get(snapshot.snapshotId) ?? []).map((baseGeneration) => {
          return [
            `${snapshot.projectionIdentity}\u0000${baseGeneration}`,
            {baseGeneration, projectionIdentity: snapshot.projectionIdentity},
          ] as const
        })
      }),
    ).values(),
  ]
  const before = await getHumanStatusCounts({projectId: input.projectId, snapshotIds}, database)

  // Each (projection identity, base generation) pair is one writer transaction holding one UPDATE.
  await ranges.reduce<Promise<void>>(async (previous, range) => {
    await previous
    await projectReviewServingHumanStatusRanges(
      {
        ranges: [
          {
            acknowledgeClaims: false,
            baseGeneration: range.baseGeneration,
            chunkEndArticleId: null,
            chunkStartArticleId: null,
            claims: [],
            definitionVersion: 'human-status-reproject',
            listModeKeys: reprojectListModeKeys,
            projectId: input.projectId,
            projectionIdentity: range.projectionIdentity,
          },
        ],
      },
      database,
    )
  }, Promise.resolve())

  const after = await getHumanStatusCounts({projectId: input.projectId, snapshotIds}, database)
  const snapshotResults = snapshots.map((snapshot): ReviewServingHumanStatusReprojectSnapshot => {
    const key = `${snapshot.snapshotId}\u0000${snapshot.reviewConfigHash ?? ''}`

    return {
      after: after.get(key) ?? emptyCounts,
      baseGenerations: baseGenerationsBySnapshot.get(snapshot.snapshotId) ?? [],
      before: before.get(key) ?? emptyCounts,
      projectionIdentity: snapshot.projectionIdentity,
      reviewConfigHash: snapshot.reviewConfigHash,
      snapshotId: snapshot.snapshotId,
      snapshotStatus: snapshot.snapshotStatus,
    }
  })
  const sum = (field: keyof ReviewServingHumanStatusCounts) => {
    return snapshotResults.reduce((total, snapshot) => {
      return total + snapshot.after[field]
    }, 0)
  }

  return {
    answered: sum('answered'),
    durationMs: Math.max(0, Date.now() - startedAtMs),
    humanJudgmentMode: project.humanJudgmentMode === 'summary' ? 'summary' : 'prompt',
    noStatus: sum('noStatus'),
    projectId: input.projectId,
    rangeCount: ranges.length,
    rowsUpdated: sum('rows'),
    snapshots: snapshotResults,
    unanswered: sum('unanswered'),
  }
}
