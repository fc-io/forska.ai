import {createHash} from 'node:crypto'

import {getSystemPromptVariant} from '../../agent/judge/systemPromptVariant.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getIntegerValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
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
import {getReviewServingJsonRowsSql} from './reviewServingJsonRowSource.ts'
import {
  getReviewServingDirtyWorkScopeForChange,
  type ReviewServingDirtyWorkScope,
} from './reviewServingProjectorDomain.ts'

export type ReviewChangeDeltaDirtyIntakeDatabase = {
  queryJson: <T>(statement: string) => Promise<T[]>
  run: (statement: string) => Promise<void>
  transaction: <T>(operation: (tx: ReviewServingDirtyWorkTransaction) => Promise<T>) => Promise<T>
}

export type IntakeReviewChangeDeltaDirtyWorkParams = {
  deadlineAtMs?: number | null
  endSourceHighWaterMark: number
  limit: number
  sourcePartition: string
  startSourceHighWaterMark: number
}

export type ReviewChangeDeltaDirtyIntakeResult =
  | {dirtyWorkCount: number; maxSourceHighWaterMark: number | null; status: 'converted'}
  | {deltaId: string; reason: string; status: 'failed'}

type ReviewChangeDeltaRow = {
  articleId: string | null
  changeKind: string
  configFieldSet: string | null
  deltaId: string
  humanJudgmentKey: string | null
  judgmentId: string | null
  modelId: string | null
  payloadJson: unknown
  payloadVersion: number
  projectId: string | null
  promptId: string | null
  sourceHighWaterMark: bigint | number | string
  sourcePartition: string
  systemPromptVariant?: string | null
  useAbstract: boolean | null
  useFulltext: boolean | null
  useFulltextNoImages: boolean | null
  useTitle: boolean | null
}

type ValidatedReviewChangeDelta = {
  deltaId: string
  projections: readonly {projectionComponent: ReviewServingProjectionComponent; projectionIdentity: string}[]
  scope: ReviewServingDirtyWorkScope
  sourceHighWaterMark: number
}
type InvalidReviewChangeDelta = {deltaId: string; reason: string}

const supportedPayloadVersion = 1

const getReviewServingHash = (label: string, value: ReviewServingIdentityValue) => {
  return createHash('sha256')
    .update(`${label}:${getStableReviewServingJson(value)}`)
    .digest('hex')
}

const parsePayloadJson = (value: unknown) => {
  if (typeof value !== 'string') {
    return value
  }

  try {
    return JSON.parse(value) as unknown
  } catch (_error) {
    return null
  }
}

const isRecord = (value: unknown): value is Record<string, ReviewServingIdentityValue> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const isPresentValue = (value: ReviewServingIdentityValue) => {
  return value !== undefined && value !== null && value !== ''
}

const getConfigFieldValues = (value: string | null) => {
  return value === null || value.trim().length === 0
    ? []
    : value
        .split(',')
        .map((field) => {
          return field.trim()
        })
        .filter((field) => {
          return field.length > 0
        })
}

const getContentFlags = (row: ReviewChangeDeltaRow) => {
  return row.useTitle === null
    || row.useAbstract === null
    || row.useFulltext === null
    || row.useFulltextNoImages === null
    ? undefined
    : {
        systemPromptVariant: getSystemPromptVariant(row.systemPromptVariant),
        useAbstract: row.useAbstract,
        useFulltext: row.useFulltext,
        useFulltextNoImages: row.useFulltextNoImages,
        useTitle: row.useTitle,
      }
}

const getTypedValues = (row: ReviewChangeDeltaRow) => {
  const payload = parsePayloadJson(row.payloadJson)

  if (!isRecord(payload)) {
    return null
  }

  return {
    ...payload,
    articleId: payload.articleId ?? row.articleId ?? undefined,
    changedPromptConfigFields: payload.changedPromptConfigFields ?? getConfigFieldValues(row.configFieldSet),
    changedReviewConfigFields: payload.changedReviewConfigFields ?? getConfigFieldValues(row.configFieldSet),
    contentFlags: payload.contentFlags ?? getContentFlags(row),
    humanJudgmentKey: payload.humanJudgmentKey ?? row.humanJudgmentKey ?? undefined,
    judgmentId: payload.judgmentId ?? row.judgmentId ?? undefined,
    modelId: payload.modelId ?? row.modelId ?? undefined,
    projectId: payload.projectId ?? row.projectId ?? undefined,
    promptId: payload.promptId ?? row.promptId ?? undefined,
    sourceHighWaterMark: row.sourceHighWaterMark,
  }
}

const getMissingRequiredKeys = (
  rule: ReviewServingInvalidationRule,
  values: Record<string, ReviewServingIdentityValue>,
) => {
  return rule.requiredKeys.filter((key) => {
    return !isPresentValue(values[key])
  })
}

const isValidRuleTopology = (rule: ReviewServingInvalidationRule) => {
  return (
    rule.affectedComponents[0] === rule.firstAffectedComponent
    && rule.downstreamDependents.every((component) => {
      return rule.affectedComponents.includes(component) && component !== rule.firstAffectedComponent
    })
  )
}

const isValidJudgmentStart = (rule: ReviewServingInvalidationRule) => {
  return !rule.changeKind.startsWith('judgment.')
    ? true
    : (rule.firstAffectedComponent === 'llmStatus' || rule.firstAffectedComponent === 'humanStatus')
        && !rule.affectedComponents.includes('selectedImport')
        && !rule.affectedComponents.includes('display')
}

const getRuleValidationError = (rule: ReviewServingInvalidationRule) => {
  if (!isValidRuleTopology(rule)) {
    return `invalid invalidation topology for ${rule.changeKind}`
  }

  return isValidJudgmentStart(rule) ? null : `invalid judgment invalidation start for ${rule.changeKind}`
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

const shouldExpandArticleDeltaToProjects = (row: ReviewChangeDeltaRow) => {
  return row.projectId === null && row.articleId !== null && row.changeKind.startsWith('article.')
}

const isInvalidReviewChangeDelta = (
  delta: InvalidReviewChangeDelta | ValidatedReviewChangeDelta,
): delta is InvalidReviewChangeDelta => {
  return 'reason' in delta
}

// One scope lookup per intake batch: a query per article delta scanned mart.project_scope_article each time
// (13-32 ms apiece), which held a shared article partition to under a thousand deltas a minute. The batch lookup
// costs about the same as a single one.
const getArticleProjectIdsByArticleId = async (
  rows: readonly ReviewChangeDeltaRow[],
  database: Pick<ReviewChangeDeltaDirtyIntakeDatabase, 'queryJson'>,
) => {
  const articleIds = [
    ...new Set(
      rows.filter(shouldExpandArticleDeltaToProjects).map((row) => {
        return row.articleId as string
      }),
    ),
  ]

  if (articleIds.length === 0) {
    return new Map<string, string[]>()
  }

  const projectRows = await database.queryJson<{articleId: string; projectId: string}>(`
    SELECT DISTINCT scope.article_id AS articleId, scope.project_id AS projectId
    FROM mart.project_scope_article scope
    WHERE scope.article_id IN (
        SELECT article.article_id
        FROM (${getReviewServingJsonRowsSql({
          columns: [{name: 'article_id', type: 'VARCHAR'}],
          rows: articleIds.map((articleId) => {
            return [articleId]
          }),
        })}) AS article
      )
      AND (scope.in_curated_scope OR scope.in_route_scope)
    ORDER BY articleId ASC, projectId ASC
  `)

  return projectRows.reduce((projectIdsByArticleId, row) => {
    return projectIdsByArticleId.set(row.articleId, [
      ...(projectIdsByArticleId.get(row.articleId) ?? []),
      row.projectId,
    ])
  }, new Map<string, string[]>())
}

const getValidatedReviewChangeDelta = (
  row: ReviewChangeDeltaRow,
  valuesOverride: Record<string, ReviewServingIdentityValue> = {},
) => {
  const rule = getReviewServingInvalidationRuleOrNull(row.changeKind)
  const sourceHighWaterMark = getIntegerValue(row.sourceHighWaterMark)

  if (rule === null) {
    return {deltaId: row.deltaId, reason: `unsupported change kind: ${row.changeKind}`}
  }

  const ruleValidationError = getRuleValidationError(rule)

  if (ruleValidationError !== null) {
    return {deltaId: row.deltaId, reason: ruleValidationError}
  }

  if (row.payloadVersion !== supportedPayloadVersion) {
    return {deltaId: row.deltaId, reason: `unsupported payload version: ${row.payloadVersion}`}
  }

  if (sourceHighWaterMark === null || sourceHighWaterMark < 0) {
    return {deltaId: row.deltaId, reason: `invalid source high-water mark: ${row.sourceHighWaterMark}`}
  }

  const typedValues = getTypedValues(row)

  if (typedValues === null) {
    return {deltaId: row.deltaId, reason: 'malformed payload_json'}
  }

  const values = {...typedValues, sourceHighWaterMark, ...valuesOverride}

  const missingKeys = getMissingRequiredKeys(rule, values)

  if (missingKeys.length > 0) {
    return {deltaId: row.deltaId, reason: `missing required keys: ${missingKeys.join(', ')}`}
  }

  const scope = getReviewServingDirtyWorkScopeForChange({
    changeKind: row.changeKind,
    sourceHighWaterMark,
    sourcePartition: row.sourcePartition,
    values,
  })

  if (scope === null) {
    return {deltaId: row.deltaId, reason: 'invalid dirty-work scope'}
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

const getValidatedReviewChangeDeltas = (row: ReviewChangeDeltaRow, projectIdsByArticleId: Map<string, string[]>) => {
  const projectIds = shouldExpandArticleDeltaToProjects(row)
    ? (projectIdsByArticleId.get(row.articleId as string) ?? [])
    : []

  if (projectIds.length > 0) {
    return projectIds.map((projectId) => {
      return getValidatedReviewChangeDelta(row, {projectId})
    })
  }

  const validated = getValidatedReviewChangeDelta(row)

  return shouldExpandArticleDeltaToProjects(row) && !('reason' in validated)
    ? [{...validated, projections: []}]
    : [validated]
}

const getValidatedReviewChangeDeltaRows = async (
  rows: readonly ReviewChangeDeltaRow[],
  database: Pick<ReviewChangeDeltaDirtyIntakeDatabase, 'queryJson'>,
) => {
  const projectIdsByArticleId = await getArticleProjectIdsByArticleId(rows, database)

  return rows.flatMap((row) => {
    return getValidatedReviewChangeDeltas(row, projectIdsByArticleId)
  })
}

const getReviewChangeDeltaRows = async (
  database: ReviewChangeDeltaDirtyIntakeDatabase,
  params: IntakeReviewChangeDeltaDirtyWorkParams,
) => {
  const limit = Math.max(0, Math.floor(params.limit))

  return limit === 0
    ? []
    : database.queryJson<ReviewChangeDeltaRow>(`
        SELECT
          delta_id AS deltaId,
          change_kind AS changeKind,
          source_partition AS sourcePartition,
          source_high_water_mark AS sourceHighWaterMark,
          payload_version AS payloadVersion,
          project_id AS projectId,
          article_id AS articleId,
          prompt_id AS promptId,
          model_id AS modelId,
          use_title AS useTitle,
          use_abstract AS useAbstract,
          use_fulltext AS useFulltext,
          use_fulltext_no_images AS useFulltextNoImages,
          COALESCE(system_prompt_variant, 'legacy') AS systemPromptVariant,
          judgment_id AS judgmentId,
          human_judgment_key AS humanJudgmentKey,
          config_field_set AS configFieldSet,
          payload_json AS payloadJson
        FROM app.review_change_delta
        WHERE source_partition = ${getSqlLiteral(params.sourcePartition)}
          AND source_high_water_mark >= ${params.startSourceHighWaterMark}
          AND source_high_water_mark <= ${params.endSourceHighWaterMark}
        ORDER BY source_high_water_mark ASC, delta_id ASC
        LIMIT ${limit}
      `)
}

const markReviewChangeDeltasReconciled = async (
  tx: ReviewServingDirtyWorkTransaction,
  deltas: readonly ValidatedReviewChangeDelta[],
) => {
  const deltaIds = deltas.map((delta) => {
    return getSqlLiteral(delta.deltaId)
  })

  if (deltaIds.length > 0) {
    await tx.run(`
      UPDATE app.review_change_delta
      SET reconciled_at = current_timestamp
      WHERE delta_id IN (${deltaIds.join(', ')})
    `)
  }
}

const commitValidatedReviewChangeDeltasToDirtyWork = async (
  deltas: readonly ValidatedReviewChangeDelta[],
  tx: ReviewServingDirtyWorkTransaction,
) => {
  const projectionDeltas = deltas.flatMap((delta) => {
    return delta.projections.map((projection) => {
      return {...delta, ...projection}
    })
  })
  const upserts = await upsertReviewServingDirtyWorkBatch(
    projectionDeltas.map((delta) => {
      return {
        latestDeltaId: delta.deltaId,
        projectionComponent: delta.projectionComponent,
        projectionIdentity: delta.projectionIdentity,
        scope: delta.scope,
      }
    }),
    tx,
  )

  await markReviewChangeDeltasReconciled(tx, deltas)

  return {
    dirtyWorkCount: upserts.filter((result) => {
      return !result.skipped
    }).length,
    maxSourceHighWaterMark: deltas.at(-1)?.sourceHighWaterMark ?? null,
    status: 'converted' as const,
  }
}

export const intakeReviewChangeDeltaRangeToDirtyWork = async (
  params: IntakeReviewChangeDeltaDirtyWorkParams,
  database: Pick<ReviewChangeDeltaDirtyIntakeDatabase, 'queryJson' | 'run'>,
): Promise<ReviewChangeDeltaDirtyIntakeResult> => {
  const rows = await getReviewChangeDeltaRows(database as ReviewChangeDeltaDirtyIntakeDatabase, params)
  const validated = await getValidatedReviewChangeDeltaRows(rows, database)
  const invalid = validated.find(isInvalidReviewChangeDelta)

  if (invalid !== undefined) {
    return {deltaId: invalid.deltaId, reason: invalid.reason, status: 'failed'}
  }

  return commitValidatedReviewChangeDeltasToDirtyWork(validated as ValidatedReviewChangeDelta[], database)
}

export const intakeReviewChangeDeltasToDirtyWork = async (
  params: IntakeReviewChangeDeltaDirtyWorkParams,
  database: ReviewChangeDeltaDirtyIntakeDatabase = getAppDatabaseService() as ReviewChangeDeltaDirtyIntakeDatabase,
): Promise<ReviewChangeDeltaDirtyIntakeResult> => {
  const rows = await getReviewChangeDeltaRows(database, params)
  const validated = await getValidatedReviewChangeDeltaRows(rows, database)
  const invalid = validated.find(isInvalidReviewChangeDelta)

  if (invalid !== undefined) {
    return {deltaId: invalid.deltaId, reason: invalid.reason, status: 'failed'}
  }

  const groups = getReviewServingDeltaIntakeGroups({
    entries: validated as ValidatedReviewChangeDelta[],
    getDeltaId: (delta) => {
      return delta.deltaId
    },
    getDirtyWorkCount: (delta) => {
      return delta.projections.length
    },
  })
  const intake = await runReviewServingDeltaIntakeGroups({
    deadlineAtMs: params.deadlineAtMs,
    groups,
    runGroup: async (group) => {
      const result = await database.transaction(async (tx) => {
        return commitValidatedReviewChangeDeltasToDirtyWork(group, tx)
      })

      return result.dirtyWorkCount
    },
  })

  return {
    dirtyWorkCount: intake.dirtyWorkCount,
    maxSourceHighWaterMark: groups.slice(0, intake.committedGroupCount).flat().at(-1)?.sourceHighWaterMark ?? null,
    status: 'converted',
  }
}
