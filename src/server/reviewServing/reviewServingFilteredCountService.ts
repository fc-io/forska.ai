import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson} from './reviewProjectionIdentity.ts'
import type {ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import {getReviewServingFilterSignature, type ReviewServingFilterSignatureValue} from './reviewServingCursor.ts'
import type {ReviewServingSnapshotManifest} from './reviewServingManifestRepository.ts'
import type {ReviewServingReaderDatabase} from './reviewServingReader.ts'

type ReviewServingFilteredCountRow = {
  count_found?: boolean | null
  count_value?: number | null
  countFound?: boolean | null
  countValue?: number | null
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

const getManifestComponentIdentity = (manifest: ReviewServingSnapshotManifest, component: string) => {
  return [...manifest.componentState.required, ...manifest.componentState.optional].find((entry) => {
    return entry.component === component
  })?.projectionIdentity
}

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

export const getReviewServingFilteredCountComponentIdentities = (
  manifest: ReviewServingSnapshotManifest,
  components: readonly ReviewServingProjectionComponent[],
): ReviewServingFilteredCountComponentIdentities => {
  const componentEntries = components
    .map((component) => {
      return [component, getManifestComponentIdentity(manifest, component) ?? ''] as const
    })
    .sort(([leftComponent], [rightComponent]) => {
      return leftComponent.localeCompare(rightComponent)
    })
  const componentIdentity = Buffer.from(
    getStableReviewServingJson(Object.fromEntries(componentEntries)),
    'utf8',
  ).toString('base64url')

  return {componentIdentity}
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
  const [cachedRow] = await input.database.queryJson<ReviewServingFilteredCountRow>(
    getReviewServingFilteredCountReadSql(input),
  )
  const countFound = Boolean(cachedRow?.countFound ?? cachedRow?.count_found ?? false)

  if (countFound) {
    return Number(cachedRow?.countValue ?? cachedRow?.count_value ?? 0)
  }

  const countValue = await input.computeCount()

  for (const statement of getReviewServingFilteredCountWriteSqls({...input, countValue})) {
    await executeCountServingStatement(input.database, statement)
  }
  await executeCountServingStatement(input.database, getReviewServingFilteredCountPruneSql(input))

  return countValue
}
