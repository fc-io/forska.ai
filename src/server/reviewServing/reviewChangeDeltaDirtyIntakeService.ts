import {createHash} from 'node:crypto'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getStableReviewServingJson, type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import type {ReviewServingProjectionComponent} from './reviewServingContracts.ts'
import {type ReviewServingDirtyWorkTransaction, upsertReviewServingDirtyWork} from './reviewServingDirtyWorkService.ts'
import {
  getReviewServingInvalidationRuleOrNull,
  type ReviewServingInvalidationRule,
} from './reviewServingInvalidationRegistry.ts'
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
  sourceHighWaterMark: number
  sourcePartition: string
  useAbstract: boolean | null
  useFulltext: boolean | null
  useFulltextNoImages: boolean | null
  useTitle: boolean | null
}

type ValidatedReviewChangeDelta = {
  deltaId: string
  projections: readonly {
    projectionComponent: ReviewServingProjectionComponent
    projectionIdentity: string
  }[]
  scope: ReviewServingDirtyWorkScope
  sourceHighWaterMark: number
}

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

const getArticleProjectIds = async (row: ReviewChangeDeltaRow, database: ReviewChangeDeltaDirtyIntakeDatabase) => {
  return !shouldExpandArticleDeltaToProjects(row)
    ? []
    : database.queryJson<{projectId: string}>(`
        SELECT DISTINCT project_id AS projectId
        FROM mart.project_scope_article
        WHERE article_id = ${getSqlLiteral(row.articleId)}
          AND (in_curated_scope OR in_route_scope)
        ORDER BY project_id ASC
      `)
}

const getValidatedReviewChangeDelta = (
  row: ReviewChangeDeltaRow,
  valuesOverride: Record<string, ReviewServingIdentityValue> = {},
) => {
  const rule = getReviewServingInvalidationRuleOrNull(row.changeKind)

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

  if (!Number.isInteger(row.sourceHighWaterMark) || row.sourceHighWaterMark < 0) {
    return {deltaId: row.deltaId, reason: `invalid source high-water mark: ${row.sourceHighWaterMark}`}
  }

  const typedValues = getTypedValues(row)

  if (typedValues === null) {
    return {deltaId: row.deltaId, reason: 'malformed payload_json'}
  }

  const values = {...typedValues, ...valuesOverride}

  const missingKeys = getMissingRequiredKeys(rule, values)

  if (missingKeys.length > 0) {
    return {deltaId: row.deltaId, reason: `missing required keys: ${missingKeys.join(', ')}`}
  }

  const scope = getReviewServingDirtyWorkScopeForChange({
    changeKind: row.changeKind,
    sourceHighWaterMark: row.sourceHighWaterMark,
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
        projectionIdentity: getProjectionIdentity({
          projectionComponent,
          projectId: scope.projectId,
        }),
      }
    }),
    scope,
    sourceHighWaterMark: row.sourceHighWaterMark,
  }
}

const getValidatedReviewChangeDeltas = async (row: ReviewChangeDeltaRow, database: ReviewChangeDeltaDirtyIntakeDatabase) => {
  const projectRows = await getArticleProjectIds(row, database)

  if (projectRows.length > 0) {
    return projectRows.map((projectRow) => {
      return getValidatedReviewChangeDelta(row, {projectId: projectRow.projectId})
    })
  }

  const validated = getValidatedReviewChangeDelta(row)

  return shouldExpandArticleDeltaToProjects(row) && !('reason' in validated)
    ? [{...validated, projections: []}]
    : [validated]
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
          CAST(source_high_water_mark AS INTEGER) AS sourceHighWaterMark,
          payload_version AS payloadVersion,
          project_id AS projectId,
          article_id AS articleId,
          prompt_id AS promptId,
          model_id AS modelId,
          use_title AS useTitle,
          use_abstract AS useAbstract,
          use_fulltext AS useFulltext,
          use_fulltext_no_images AS useFulltextNoImages,
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

export const intakeReviewChangeDeltasToDirtyWork = async (
  params: IntakeReviewChangeDeltaDirtyWorkParams,
  database: ReviewChangeDeltaDirtyIntakeDatabase = getAppDatabaseService(),
): Promise<ReviewChangeDeltaDirtyIntakeResult> => {
  const rows = await getReviewChangeDeltaRows(database, params)
  const validated = (await Promise.all(
    rows.map((row) => {
      return getValidatedReviewChangeDeltas(row, database)
    }),
  )).flat()
  const invalid = validated.find((delta) => {
    return 'reason' in delta
  })

  if (invalid !== undefined && 'reason' in invalid) {
    return {deltaId: invalid.deltaId, reason: invalid.reason, status: 'failed'}
  }

  const deltas = validated as ValidatedReviewChangeDelta[]

  return database.transaction(async (tx) => {
    const projectionDeltas = deltas.flatMap((delta) => {
      return delta.projections.map((projection) => {
        return {...delta, ...projection}
      })
    })
    const upserts = await projectionDeltas.reduce<Promise<{skipped: boolean}[]>>(async (previousRun, delta) => {
      const results = await previousRun
      const result = await upsertReviewServingDirtyWork(
        {
          latestDeltaId: delta.deltaId,
          projectionComponent: delta.projectionComponent,
          projectionIdentity: delta.projectionIdentity,
          scope: delta.scope,
        },
        tx,
      )

      return [...results, result]
    }, Promise.resolve([]))

    await markReviewChangeDeltasReconciled(tx, deltas)

    return {
      dirtyWorkCount: upserts.filter((result) => {
        return !result.skipped
      }).length,
      maxSourceHighWaterMark: deltas.at(-1)?.sourceHighWaterMark ?? null,
      status: 'converted' as const,
    }
  })
}
