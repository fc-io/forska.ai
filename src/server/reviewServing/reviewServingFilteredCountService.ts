import {createHash} from 'node:crypto'

import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson} from './reviewProjectionIdentity.ts'
import {
  filteredCountIdentityReviewServingComponents,
  isReviewServingProjectionComponent,
  type ReviewServingProjectionComponent,
} from './reviewServingContracts.ts'
import {getReviewServingFilterSignature, type ReviewServingFilterSignatureValue} from './reviewServingCursor.ts'
import type {ReviewServingSnapshotManifest} from './reviewServingManifestRepository.ts'
import type {ReviewServingReaderDatabase} from './reviewServingReader.ts'

type ReviewServingFilteredCountRow = {
  count_found?: boolean | null
  count_value?: number | null
  countFound?: boolean | null
  countValue?: number | null
}

type ReviewServingFilteredCountComponentIdentityState = {
  baseGeneration: string
  patchWatermark: string
  projectionIdentity: string
}

type ReviewServingFilteredCountComponentRevisionRow = {
  baseGeneration?: number | string | null
  component?: string | null
  manifestPatchWatermark?: number | string | null
  projectionIdentity?: string | null
  projectionInputWatermark?: number | string | null
  projectionInputWatermarksJson?: unknown
  projectionPatchWatermark?: number | string | null
  servingRevision?: number | string | null
  servingSourceHighWaterMark?: number | string | null
}

export type ReviewServingFilteredCountDatabase = ReviewServingReaderDatabase & {
  run?: (statement: string) => Promise<void>
}

export type ReviewServingFilteredCountComponentIdentities = {componentIdentity: string}

export type ReviewServingFilteredCountLookup = ReviewServingFilteredCountComponentIdentities & {
  filterSignature: string
  listModeKey: string
  projectId: string
  reviewConfigHash: string
  snapshotId: string
}

export type GetReviewServingFilteredCountInput = ReviewServingFilteredCountLookup & {
  computeCount: () => Promise<number>
  database: ReviewServingFilteredCountDatabase
  maxRowsPerScope?: number
}

const defaultMaxRowsPerScope = 2048

const executeCountServingStatement = async (database: ReviewServingFilteredCountDatabase, statement: string) => {
  if (database.run) {
    await database.run(statement)
    return
  }

  await database.queryJson<unknown>(statement)
}

export const getReviewServingFilteredCountSignature = (input: ReviewServingFilterSignatureValue) => {
  return getReviewServingFilterSignature(input)
}

const encodeReviewServingFilteredCountComponentIdentity = (
  entries: readonly (readonly [ReviewServingProjectionComponent, Record<string, unknown>])[],
) => {
  return Buffer.from(getStableReviewServingJson(Object.fromEntries(entries)), 'utf8').toString('base64url')
}

export const getReviewServingFilteredCountComponentIdentities = (
  manifest: ReviewServingSnapshotManifest,
  components: readonly ReviewServingProjectionComponent[],
): ReviewServingFilteredCountComponentIdentities => {
  const countIdentityComponents = new Set<ReviewServingProjectionComponent>(
    filteredCountIdentityReviewServingComponents,
  )
  const componentEntries = components
    .filter((component) => {
      return countIdentityComponents.has(component)
    })
    .map((component) => {
      const state = [...manifest.componentState.required, ...manifest.componentState.optional].find((entry) => {
        return entry.component === component
      })

      return [
        component,
        {
          baseGeneration: state?.baseGeneration ?? '',
          patchWatermark: state?.patchWatermark ?? '',
          projectionIdentity: state?.projectionIdentity ?? '',
        },
      ] as const
    })
    .sort(([leftComponent], [rightComponent]) => {
      return leftComponent.localeCompare(rightComponent)
    })
  const componentIdentity = encodeReviewServingFilteredCountComponentIdentity(componentEntries)

  return {componentIdentity}
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const getNonNegativeIntegerString = (value: unknown) => {
  const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN

  return Number.isFinite(numberValue) && numberValue >= 0 ? String(Math.trunc(numberValue)) : ''
}

const getComponentIdentityStateString = (value: unknown) => {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

const decodeReviewServingFilteredCountComponentIdentity = (
  componentIdentity: string,
): Partial<Record<ReviewServingProjectionComponent, ReviewServingFilteredCountComponentIdentityState>> | null => {
  try {
    const decoded = JSON.parse(Buffer.from(componentIdentity, 'base64url').toString('utf8')) as unknown

    if (!isRecord(decoded)) {
      return null
    }

    return Object.fromEntries(
      Object.entries(decoded)
        .filter(([component, value]) => {
          return isReviewServingProjectionComponent(component) && isRecord(value)
        })
        .map(([component, value]) => {
          return [
            component,
            {
              baseGeneration: getComponentIdentityStateString(value.baseGeneration),
              patchWatermark: getComponentIdentityStateString(value.patchWatermark),
              projectionIdentity: getComponentIdentityStateString(value.projectionIdentity),
            },
          ]
        }),
    )
  } catch (_error) {
    return null
  }
}

const parseJsonValue = (value: unknown) => {
  if (typeof value !== 'string') {
    return value
  }

  try {
    return JSON.parse(value) as unknown
  } catch (_error) {
    return null
  }
}

const getRevisionDigest = (value: unknown) => {
  return createHash('sha256')
    .update(getStableReviewServingJson(value ?? null))
    .digest('base64url')
}

const getComponentRevisionValuesSql = (
  states: Partial<Record<ReviewServingProjectionComponent, ReviewServingFilteredCountComponentIdentityState>>,
) => {
  return Object.entries(states)
    .filter((entry): entry is [ReviewServingProjectionComponent, ReviewServingFilteredCountComponentIdentityState] => {
      const [component, state] = entry

      return (
        isReviewServingProjectionComponent(component)
        && state.projectionIdentity.trim().length > 0
        && getNonNegativeIntegerString(state.baseGeneration).length > 0
      )
    })
    .map(([component, state]) => {
      return `(${getSqlLiteral(component)}, ${getSqlLiteral(state.projectionIdentity)}, ${getSqlLiteral(
        state.baseGeneration,
      )}, ${getSqlLiteral(state.patchWatermark)})`
    })
    .join(', ')
}

export const getReviewServingFilteredCountComponentRevisionReadSql = (input: ReviewServingFilteredCountLookup) => {
  const componentStates = decodeReviewServingFilteredCountComponentIdentity(input.componentIdentity)
  const componentValuesSql = componentStates === null ? '' : getComponentRevisionValuesSql(componentStates)

  if (componentValuesSql.length === 0) {
    return null
  }

  return `
    WITH requested_component(component, projection_identity, base_generation, manifest_patch_watermark) AS (
      SELECT * FROM (VALUES ${componentValuesSql})
    )
    SELECT
      requested.component,
      requested.projection_identity AS projectionIdentity,
      requested.base_generation AS baseGeneration,
      requested.manifest_patch_watermark AS manifestPatchWatermark,
      projection.patch_watermark AS projectionPatchWatermark,
      projection.input_watermark AS projectionInputWatermark,
      projection.input_watermarks_json AS projectionInputWatermarksJson,
      MAX(component_revision.revision) AS servingRevision,
      MAX(component_revision.source_high_water_mark) AS servingSourceHighWaterMark
    FROM requested_component requested
    LEFT JOIN app.review_projection_identity_manifest projection
      ON projection.project_id IS NOT DISTINCT FROM ${getSqlLiteral(input.projectId)}
      AND projection.projection_component = requested.component
      AND projection.projection_identity = requested.projection_identity
      AND projection.base_generation = TRY_CAST(requested.base_generation AS BIGINT)
    LEFT JOIN app.review_serving_component_revision component_revision
      ON component_revision.project_id IS NOT DISTINCT FROM ${getSqlLiteral(input.projectId)}
      AND component_revision.review_config_hash IS NOT DISTINCT FROM ${getSqlLiteral(input.reviewConfigHash)}
      AND component_revision.snapshot_id IS NOT DISTINCT FROM ${getSqlLiteral(input.snapshotId)}
      AND component_revision.list_mode_key IS NOT DISTINCT FROM ${getSqlLiteral(input.listModeKey)}
      AND component_revision.projection_component = requested.component
      AND component_revision.projection_identity = requested.projection_identity
    GROUP BY
      requested.component,
      requested.projection_identity,
      requested.base_generation,
      requested.manifest_patch_watermark,
      projection.patch_watermark,
      projection.input_watermark,
      projection.input_watermarks_json
    ORDER BY requested.component ASC
  `
}

const getRevisionRowComponent = (row: ReviewServingFilteredCountComponentRevisionRow) => {
  return typeof row.component === 'string' && isReviewServingProjectionComponent(row.component) ? row.component : null
}

const getReviewServingFilteredCountRevisionedLookup = async (
  input: ReviewServingFilteredCountLookup & {database: ReviewServingFilteredCountDatabase},
): Promise<ReviewServingFilteredCountLookup> => {
  const componentStates = decodeReviewServingFilteredCountComponentIdentity(input.componentIdentity)
  const revisionReadSql = getReviewServingFilteredCountComponentRevisionReadSql(input)

  if (componentStates === null || revisionReadSql === null) {
    return input
  }

  const revisionRows = await input.database.queryJson<ReviewServingFilteredCountComponentRevisionRow>(revisionReadSql)
  const revisionsByComponent = new Map<
    ReviewServingProjectionComponent,
    ReviewServingFilteredCountComponentRevisionRow
  >()

  revisionRows.forEach((row) => {
    const component = getRevisionRowComponent(row)

    if (component !== null) {
      revisionsByComponent.set(component, row)
    }
  })

  const componentEntries = Object.entries(componentStates)
    .filter((entry): entry is [ReviewServingProjectionComponent, ReviewServingFilteredCountComponentIdentityState] => {
      return isReviewServingProjectionComponent(entry[0])
    })
    .map(([component, state]) => {
      const revision = revisionsByComponent.get(component)
      const projectionInputWatermarksJson = parseJsonValue(revision?.projectionInputWatermarksJson)
      const projectionInputWatermarksDigest =
        revision === undefined ? '' : getRevisionDigest(projectionInputWatermarksJson ?? {})

      return [
        component,
        {
          baseGeneration: getNonNegativeIntegerString(revision?.baseGeneration) || state.baseGeneration,
          manifestPatchWatermark: state.patchWatermark,
          patchWatermark: getNonNegativeIntegerString(revision?.projectionPatchWatermark) || state.patchWatermark,
          projectionIdentity: state.projectionIdentity,
          projectionInputWatermark: getNonNegativeIntegerString(revision?.projectionInputWatermark),
          projectionInputWatermarksDigest,
          servingRevision: getNonNegativeIntegerString(revision?.servingRevision),
          servingSourceHighWaterMark: getNonNegativeIntegerString(revision?.servingSourceHighWaterMark),
        },
      ] as const
    })
    .sort(([leftComponent], [rightComponent]) => {
      return leftComponent.localeCompare(rightComponent)
    })

  return {...input, componentIdentity: encodeReviewServingFilteredCountComponentIdentity(componentEntries)}
}

export const getReviewServingFilteredCountReadSql = (input: ReviewServingFilteredCountLookup) => {
  return `
    SELECT TRUE AS countFound, count_value AS countValue
    FROM mart.review_filtered_count_serving_v4
    WHERE project_id = ${getSqlLiteral(input.projectId)}
      AND review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
      AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
      AND list_mode_key = ${getSqlLiteral(input.listModeKey)}
      AND filter_signature = ${getSqlLiteral(input.filterSignature)}
      AND component_identity = ${getSqlLiteral(input.componentIdentity)}
    LIMIT 1
  `
}

export const getReviewServingFilteredCountWriteSqls = (
  input: ReviewServingFilteredCountLookup & {countValue: number},
) => {
  const keyPredicate = `
    project_id = ${getSqlLiteral(input.projectId)}
      AND review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
      AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
      AND list_mode_key = ${getSqlLiteral(input.listModeKey)}
      AND filter_signature = ${getSqlLiteral(input.filterSignature)}
      AND component_identity = ${getSqlLiteral(input.componentIdentity)}
  `

  return [
    `
    DELETE FROM mart.review_filtered_count_serving_v4
    WHERE ${keyPredicate}
  `,
    `
    INSERT INTO mart.review_filtered_count_serving_v4 (
      project_id,
      review_config_hash,
      snapshot_id,
      list_mode_key,
      filter_signature,
      component_identity,
      count_value,
      count_updated_at
    ) VALUES (
      ${getSqlLiteral(input.projectId)},
      ${getSqlLiteral(input.reviewConfigHash)},
      ${getSqlLiteral(input.snapshotId)},
      ${getSqlLiteral(input.listModeKey)},
      ${getSqlLiteral(input.filterSignature)},
      ${getSqlLiteral(input.componentIdentity)},
      ${getSqlLiteral(input.countValue)},
      current_timestamp
    )
  `,
  ]
}

export const getReviewServingFilteredCountPruneSql = (
  input: Pick<ReviewServingFilteredCountLookup, 'listModeKey' | 'projectId' | 'reviewConfigHash' | 'snapshotId'> & {
    maxRowsPerScope?: number
  },
) => {
  const maxRowsPerScope = Math.max(1, input.maxRowsPerScope ?? defaultMaxRowsPerScope)

  return `
    DELETE FROM mart.review_filtered_count_serving_v4 target
    USING (
      SELECT
        project_id,
        review_config_hash,
        snapshot_id,
        list_mode_key,
        filter_signature,
        component_identity
      FROM (
        SELECT
          project_id,
          review_config_hash,
          snapshot_id,
          list_mode_key,
          filter_signature,
          component_identity,
          ROW_NUMBER() OVER (
            PARTITION BY project_id, review_config_hash, snapshot_id, list_mode_key
            ORDER BY count_updated_at DESC, filter_signature, component_identity
          ) AS row_rank
        FROM mart.review_filtered_count_serving_v4
        WHERE project_id = ${getSqlLiteral(input.projectId)}
          AND review_config_hash = ${getSqlLiteral(input.reviewConfigHash)}
          AND snapshot_id = ${getSqlLiteral(input.snapshotId)}
          AND list_mode_key = ${getSqlLiteral(input.listModeKey)}
      ) ranked_counts
      WHERE row_rank > ${getSqlLiteral(maxRowsPerScope)}
    ) stale
    WHERE target.project_id = stale.project_id
      AND target.review_config_hash = stale.review_config_hash
      AND target.snapshot_id = stale.snapshot_id
      AND target.list_mode_key = stale.list_mode_key
      AND target.filter_signature = stale.filter_signature
      AND target.component_identity = stale.component_identity
  `
}

export const getReviewServingFilteredCountValue = async (input: GetReviewServingFilteredCountInput) => {
  const lookup = await getReviewServingFilteredCountRevisionedLookup(input)
  const [cachedRow] = await input.database.queryJson<ReviewServingFilteredCountRow>(
    getReviewServingFilteredCountReadSql(lookup),
  )
  const countFound = Boolean(cachedRow?.countFound ?? cachedRow?.count_found ?? false)
  const cachedCountValue = Number(cachedRow?.countValue ?? cachedRow?.count_value ?? 0)

  if (countFound && cachedCountValue > 0) {
    return cachedCountValue
  }

  const countValue = await input.computeCount()

  if (countValue === 0) {
    return countValue
  }

  for (const statement of getReviewServingFilteredCountWriteSqls({...lookup, countValue})) {
    await executeCountServingStatement(input.database, statement)
  }
  await executeCountServingStatement(input.database, getReviewServingFilteredCountPruneSql(lookup))

  return countValue
}
