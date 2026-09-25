import {createHash} from 'node:crypto'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getIntegerValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {reviewImportHotFieldProjectorColumns} from './reviewImportHotFieldService.ts'
import {getStableReviewServingJson, type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import type {ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import {getReviewServingDeltaIntakeGroups, runReviewServingDeltaIntakeGroups} from './reviewServingDeltaIntakeGroups.ts'
import {
  type ReviewServingDirtyWorkTransaction,
  upsertReviewServingDirtyWorkBatch,
} from './reviewServingDirtyWorkService.ts'
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
  deadlineAtMs?: number | null
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
  sourceHighWaterMark: bigint | number | string
  sourcePartition: string
  sourceRecordKey: string | null
  tombstone: boolean
}

type ValidatedReviewImportDelta = {
  deltaId: string
  projections: readonly {projectionComponent: ReviewServingProjectionComponent; projectionIdentity: string}[]
  scope: ReviewServingDirtyWorkScope
  sourceHighWaterMark: number
}
type InvalidReviewImportDelta = {reason: string}
type ReviewImportDeltaIntakeEntry = {delta: ValidatedReviewImportDelta | null; row: ReviewImportDeltaRow}

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
  projectionComponent: ReviewServingProjectionComponent
  projectId: string | null
}) => {
  return `${input.projectionComponent}:${getReviewServingHash('review-change-delta-dirty-projection', {
    projectionComponent: input.projectionComponent,
    projectId: input.projectId,
  })}`
}

const isInvalidReviewImportDelta = (
  delta: InvalidReviewImportDelta | ValidatedReviewImportDelta | null,
): delta is InvalidReviewImportDelta => {
  return delta !== null && 'reason' in delta
}

const getValidatedReviewImportDelta = (row: ReviewImportDeltaRow) => {
  const rule = getReviewServingInvalidationRuleOrNull(row.changeKind)
  const sourceHighWaterMark = getIntegerValue(row.sourceHighWaterMark)

  if (rule === null) {
    return {reason: `unsupported change kind: ${row.changeKind}`}
  }

  const ruleValidationError = getRuleValidationError(rule)

  if (ruleValidationError !== null) {
    return {reason: ruleValidationError}
  }

  if (sourceHighWaterMark === null || sourceHighWaterMark < 0) {
    return {reason: `invalid source high-water mark: ${row.sourceHighWaterMark}`}
  }

  if (row.payloadVersion !== supportedPayloadVersion) {
    return {reason: `unsupported payload version: ${row.payloadVersion}`}
  }

  const values = {...getImportDeltaValues(row), sourceHighWaterMark}
  const missingKeys = getMissingRequiredKeys(rule, values)

  if (missingKeys.length > 0) {
    return {reason: `missing required keys: ${missingKeys.join(', ')}`}
  }

  if (row.projectId === null) {
    return null
  }

  const scope = getReviewServingDirtyWorkScopeForChange({
    changeKind: row.changeKind,
    sourceHighWaterMark,
    sourcePartition: row.sourcePartition,
    values,
  })

  if (scope === null) {
    return {reason: 'invalid dirty-work scope'}
  }

  return {
    deltaId: row.deltaId,
    projections: rule.affectedComponents.map((projectionComponent) => {
      return {
        projectionComponent,
        projectionIdentity: getProjectionIdentity({projectionComponent, projectId: scope.projectId}),
      }
    }),
    scope,
    sourceHighWaterMark,
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
          delta.source_high_water_mark AS sourceHighWaterMark,
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

const getCommittableReviewImportDeltas = (entries: readonly ReviewImportDeltaIntakeEntry[]) => {
  return entries.flatMap((entry) => {
    return entry.delta === null ? [] : [entry.delta]
  })
}

const getReviewImportDeltaDirtyWorkInputs = (deltas: readonly ValidatedReviewImportDelta[]) => {
  return deltas.flatMap((delta) => {
    return delta.projections.map((projection) => {
      return {
        articleId: delta.scope.scopeId.split(':').at(-1) ?? null,
        latestDeltaId: delta.deltaId,
        projectionComponent: projection.projectionComponent,
        projectionIdentity: projection.projectionIdentity,
        scope: delta.scope,
      }
    })
  })
}

const commitReviewImportDeltaIntakeGroup = (
  entries: readonly ReviewImportDeltaIntakeEntry[],
  database: ReviewImportDeltaDirtyIntakeDatabase,
) => {
  return database.transaction(async (tx) => {
    const upserts = await upsertReviewServingDirtyWorkBatch(
      getReviewImportDeltaDirtyWorkInputs(getCommittableReviewImportDeltas(entries)),
      tx,
    )

    await markReviewImportDeltasReconciled(
      tx,
      entries.map((entry) => {
        return entry.row
      }),
    )

    return upserts.filter((result) => {
      return !result.skipped
    }).length
  })
}

export const intakeReviewImportDeltasToDirtyWork = async (
  params: IntakeReviewImportDeltaDirtyWorkParams,
  database: ReviewImportDeltaDirtyIntakeDatabase = getAppDatabaseService() as ReviewImportDeltaDirtyIntakeDatabase,
): Promise<ReviewImportDeltaDirtyIntakeResult> => {
  const rows = await getReviewImportDeltaRows(database, params)
  const validated = rows.map(getValidatedReviewImportDelta)
  const invalid = validated.find(isInvalidReviewImportDelta)

  if (invalid !== undefined) {
    const row = rows[validated.indexOf(invalid)]

    return {deltaId: row?.deltaId ?? 'unknown', reason: invalid.reason, status: 'failed'}
  }

  const groups = getReviewServingDeltaIntakeGroups({
    entries: rows.map((row, index) => {
      return {delta: (validated[index] ?? null) as ValidatedReviewImportDelta | null, row}
    }),
    getDeltaId: (entry) => {
      return entry.row.deltaId
    },
    getDirtyWorkCount: (entry) => {
      return entry.delta?.projections.length ?? 0
    },
  })
  const intake = await runReviewServingDeltaIntakeGroups({
    deadlineAtMs: params.deadlineAtMs,
    groups,
    runGroup: (group) => {
      return commitReviewImportDeltaIntakeGroup(group, database)
    },
  })

  return {
    dirtyWorkCount: intake.dirtyWorkCount,
    maxSourceHighWaterMark:
      getCommittableReviewImportDeltas(groups.slice(0, intake.committedGroupCount).flat()).at(-1)?.sourceHighWaterMark
      ?? null,
    status: 'converted',
  }
}
