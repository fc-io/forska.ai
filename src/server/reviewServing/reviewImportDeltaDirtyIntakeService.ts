import {createHash} from 'node:crypto'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {reviewImportHotFieldProjectorColumns} from './reviewImportHotFieldService.ts'
import {getStableReviewServingJson, type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import type {ReviewServingChangeKind, ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import {type ReviewServingDirtyWorkTransaction, upsertReviewServingDirtyWork} from './reviewServingDirtyWorkService.ts'
import {
  getReviewServingInvalidationRuleOrNull,
  type ReviewServingInvalidationRule,
} from './reviewServingInvalidationRegistry.ts'
import {
  getReviewServingDirtyWorkScopeForChange,
  type ReviewServingDirtyWorkScope,
} from './reviewServingProjectorDomain.ts'

export type ReviewImportDeltaDirtyIntakeDatabase = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
  transaction: <T>(operation: (tx: ReviewServingDirtyWorkTransaction) => Promise<T>) => Promise<T>
}

export type IntakeReviewImportDeltaDirtyWorkParams = {
  endSourceHighWaterMark: number
  limit: number
  sourcePartition: string
  startSourceHighWaterMark: number
}

export type ReviewImportDeltaDirtyIntakeResult =
  | {dirtyWorkCount: number; maxSourceHighWaterMark: number | null; status: 'converted'}
  | {deltaId: string; reason: string; status: 'failed'}

type ReviewImportDeltaRow = {
  articleId: string | null
  changeKind: string
  conflictFlag: boolean | null
  deltaId: string
  duplicateFlag: boolean | null
  filterBucketKey: string | null
  filterBucketValue: string | null
  hotArticleId: string | null
  hotImportRouteId: string | null
  hotSourceRecordKey: string | null
  importRouteId: string | null
  payloadVersion: number
  projectId: string | null
  publicationYear: number | null
  selectedRankKey: string | null
  selectedRankNumeric: number | null
  sourceHighWaterMark: number
  sourcePartition: string
  sourceRecordKey: string | null
  tombstone: boolean
}

type ValidatedReviewImportDelta = {
  deltaId: string
  projectionComponent: ReviewServingProjectionComponent
  projectionIdentity: string
  scope: ReviewServingDirtyWorkScope
  sourceHighWaterMark: number
}

const supportedPayloadVersion = 1

const rankFilterDirtyFields = [
  ...new Set([
    ...reviewImportHotFieldProjectorColumns.selectedImportRanking,
    ...reviewImportHotFieldProjectorColumns.filters,
    ...reviewImportHotFieldProjectorColumns.postings,
  ]),
]

const getReviewServingHash = (label: string, value: ReviewServingIdentityValue) => {
  return createHash('sha256')
    .update(`${label}:${getStableReviewServingJson(value)}`)
    .digest('hex')
}

const isPresentValue = (value: ReviewServingIdentityValue) => {
  return value !== undefined && value !== null && value !== ''
}

const getMissingRequiredKeys = (
  rule: ReviewServingInvalidationRule,
  values: Record<string, ReviewServingIdentityValue>,
) => {
  return rule.requiredKeys.filter((key) => {
    return !isPresentValue(values[key])
  })
}

const getRuleValidationError = (rule: ReviewServingInvalidationRule) => {
  return rule.affectedComponents[0] === rule.firstAffectedComponent
    && rule.downstreamDependents.every((component) => {
      return rule.affectedComponents.includes(component) && component !== rule.firstAffectedComponent
    })
    ? null
    : `invalid invalidation topology for ${rule.changeKind}`
}

const getImportDeltaValues = (row: ReviewImportDeltaRow) => {
  return {
    articleId: row.hotArticleId ?? row.articleId ?? undefined,
    changedRankFilterFields: rankFilterDirtyFields,
    conflictFlag: row.conflictFlag ?? undefined,
    duplicateFlag: row.duplicateFlag ?? undefined,
    filterBucketKey: row.filterBucketKey ?? undefined,
    filterBucketValue: row.filterBucketValue ?? undefined,
    importRouteId: row.hotImportRouteId ?? row.importRouteId ?? undefined,
    importSourceRecordKey: row.hotSourceRecordKey ?? row.sourceRecordKey ?? undefined,
    projectId: row.projectId ?? undefined,
    publicationYear: row.publicationYear ?? undefined,
    selectedRankKey: row.selectedRankKey ?? undefined,
    selectedRankNumeric: row.selectedRankNumeric ?? undefined,
    sourceHighWaterMark: row.sourceHighWaterMark,
    tombstone: row.tombstone,
  }
}

const getProjectionIdentity = (input: {
  changeKind: ReviewServingChangeKind
  projectionComponent: ReviewServingProjectionComponent
  projectId: string | null
  updateMode: string
  values: Record<string, ReviewServingIdentityValue>
}) => {
  return `${input.projectionComponent}:${getReviewServingHash('review-import-delta-dirty-projection', {
    changeKind: input.changeKind,
    projectionComponent: input.projectionComponent,
    projectId: input.projectId,
    updateMode: input.updateMode,
    values: input.values,
  })}`
}

const getValidatedReviewImportDelta = (row: ReviewImportDeltaRow) => {
  const rule = getReviewServingInvalidationRuleOrNull(row.changeKind)

  if (rule === null) {
    return {reason: `unsupported change kind: ${row.changeKind}`}
  }

  const ruleValidationError = getRuleValidationError(rule)

  if (ruleValidationError !== null) {
    return {reason: ruleValidationError}
  }

  if (!Number.isInteger(row.sourceHighWaterMark) || row.sourceHighWaterMark < 0) {
    return {reason: `invalid source high-water mark: ${row.sourceHighWaterMark}`}
  }

  if (row.payloadVersion !== supportedPayloadVersion) {
    return {reason: `unsupported payload version: ${row.payloadVersion}`}
  }

  const values = getImportDeltaValues(row)
  const missingKeys = getMissingRequiredKeys(rule, values)

  if (missingKeys.length > 0) {
    return {reason: `missing required keys: ${missingKeys.join(', ')}`}
  }

  if (row.projectId === null) {
    return null
  }

  const scope = getReviewServingDirtyWorkScopeForChange({
    changeKind: row.changeKind,
    sourceHighWaterMark: row.sourceHighWaterMark,
    sourcePartition: row.sourcePartition,
    values,
  })

  if (scope === null) {
    return {reason: 'invalid dirty-work scope'}
  }

  return {
    deltaId: row.deltaId,
    projectionComponent: rule.firstAffectedComponent,
    projectionIdentity: getProjectionIdentity({
      changeKind: rule.changeKind,
      projectionComponent: rule.firstAffectedComponent,
      projectId: scope.projectId,
      updateMode: rule.updateMode,
      values,
    }),
    scope,
    sourceHighWaterMark: row.sourceHighWaterMark,
  }
}

const getReviewImportDeltaRows = async (
  database: ReviewImportDeltaDirtyIntakeDatabase,
  params: IntakeReviewImportDeltaDirtyWorkParams,
) => {
  const limit = Math.max(0, Math.floor(params.limit))

  return limit === 0
    ? []
    : database.queryJson<ReviewImportDeltaRow>(`
        WITH bounded_deltas AS (
          SELECT
            delta_id,
            change_kind,
            source_partition,
            source_high_water_mark,
            payload_version,
            import_route_id,
            article_id,
            source_record_key,
            tombstone
          FROM app.import_run_article_delta
          WHERE source_partition = ${getSqlLiteral(params.sourcePartition)}
            AND source_high_water_mark >= ${params.startSourceHighWaterMark}
            AND source_high_water_mark <= ${params.endSourceHighWaterMark}
          ORDER BY source_high_water_mark ASC, delta_id ASC
          LIMIT ${limit}
        )
        SELECT
          delta.delta_id AS deltaId,
          delta.change_kind AS changeKind,
          delta.source_partition AS sourcePartition,
          CAST(delta.source_high_water_mark AS INTEGER) AS sourceHighWaterMark,
          delta.payload_version AS payloadVersion,
          delta.import_route_id AS importRouteId,
          delta.article_id AS articleId,
          delta.source_record_key AS sourceRecordKey,
          COALESCE(hot.tombstone, delta.tombstone) AS tombstone,
          hot.import_route_id AS hotImportRouteId,
          hot.article_id AS hotArticleId,
          hot.source_record_key AS hotSourceRecordKey,
          hot.selected_rank_key AS selectedRankKey,
          hot.selected_rank_numeric AS selectedRankNumeric,
          hot.publication_year AS publicationYear,
          hot.duplicate_flag AS duplicateFlag,
          hot.conflict_flag AS conflictFlag,
          hot.filter_bucket_key AS filterBucketKey,
          hot.filter_bucket_value AS filterBucketValue,
          project_route.project_id AS projectId
        FROM bounded_deltas delta
        LEFT JOIN app.review_import_article_hot_field hot
          ON hot.import_route_id = delta.import_route_id
          AND hot.article_id = delta.article_id
          AND hot.source_record_key = delta.source_record_key
        LEFT JOIN app.project_import_route project_route
          ON project_route.import_route_id = delta.import_route_id
        ORDER BY delta.source_high_water_mark ASC, delta.delta_id ASC, project_route.project_id ASC
      `)
}

const markReviewImportDeltasReconciled = async (
  tx: ReviewServingDirtyWorkTransaction,
  deltas: readonly {deltaId: string}[],
) => {
  const deltaIds = [
    ...new Set(
      deltas.map((delta) => {
        return delta.deltaId
      }),
    ),
  ].map(getSqlLiteral)

  if (deltaIds.length > 0) {
    await tx.run(`
      UPDATE app.import_run_article_delta
      SET reconciled_at = current_timestamp
      WHERE delta_id IN (${deltaIds.join(', ')})
    `)
  }
}

export const intakeReviewImportDeltasToDirtyWork = async (
  params: IntakeReviewImportDeltaDirtyWorkParams,
  database: ReviewImportDeltaDirtyIntakeDatabase = getAppDatabaseService(),
): Promise<ReviewImportDeltaDirtyIntakeResult> => {
  const rows = await getReviewImportDeltaRows(database, params)
  const validated = rows.map(getValidatedReviewImportDelta)
  const invalid = validated.find((delta) => {
    return delta !== null && 'reason' in delta
  })

  if (invalid !== undefined && invalid !== null && 'reason' in invalid) {
    const row = rows[validated.indexOf(invalid)]

    return {deltaId: row?.deltaId ?? 'unknown', reason: invalid.reason, status: 'failed'}
  }

  const deltas = validated.filter((delta) => {
    return delta !== null
  }) as ValidatedReviewImportDelta[]

  return database.transaction(async (tx) => {
    const upserts = await deltas.reduce<Promise<{skipped: boolean}[]>>(async (previousRun, delta) => {
      const results = await previousRun
      const result = await upsertReviewServingDirtyWork(
        {
          articleId: delta.scope.scopeId.split(':').at(-1) ?? null,
          latestDeltaId: delta.deltaId,
          projectionComponent: delta.projectionComponent,
          projectionIdentity: delta.projectionIdentity,
          scope: delta.scope,
        },
        tx,
      )

      return [...results, result]
    }, Promise.resolve([]))

    await markReviewImportDeltasReconciled(tx, rows)

    return {
      dirtyWorkCount: upserts.filter((result) => {
        return !result.skipped
      }).length,
      maxSourceHighWaterMark: rows.at(-1)?.sourceHighWaterMark ?? null,
      status: 'converted' as const,
    }
  })
}
