import {getQuotedStringList} from '../services/appQueryHelpers.ts'
import {
  appendReviewServingChangeDelta,
  type ReviewServingDeltaLedgerTransaction,
  type ReviewServingSourceOperation,
} from './reviewServingDeltaLedger.ts'

export type PromptConfigReviewServingField =
  | 'answerSchema'
  | 'archived'
  | 'enabled'
  | 'promptHeading'
  | 'promptOrder'
  | 'promptText'
  | 'promptType'
  | 'thresholding'

export type ProjectReviewConfigReviewServingField =
  | 'dateFrom'
  | 'dateTo'
  | 'humanJudgmentMode'
  | 'importRoutes'
  | 'modelExecutionIdentity'
  | 'modelId'
  | 'promptMembership'
  | 'useAbstract'
  | 'useFulltext'
  | 'useFulltextNoImages'
  | 'useTitle'

export type AppendPromptConfigReviewServingDeltaInput = {
  changedPromptConfigFields: readonly PromptConfigReviewServingField[]
  projectId: string
  promptId: string
  sourceMutationKey: string
  sourceOperation: ReviewServingSourceOperation
  sourcePartition?: string
  sourceRowId?: string
  sourceTable?: string
  sourceUpdatedAt?: Date | string | null
}

export type AppendProjectReviewConfigReviewServingDeltaInput = {
  changedReviewConfigFields: readonly ProjectReviewConfigReviewServingField[]
  projectId: string
  promptId?: string | null
  sourceMutationKey: string
  sourceOperation: ReviewServingSourceOperation
  sourcePartition?: string
  sourceRowId?: string
  sourceTable?: string
  sourceUpdatedAt?: Date | string | null
}

type ProjectModelExecutionIdentityRow = {modelId: string; projectId: string}
type ProjectProviderExecutionIdentityRow = {projectId: string; providerConnectionId: string}

const getSortedUniqueFields = <T extends string>(fields: readonly T[]) => {
  return Array.from(new Set(fields)).sort((left, right) => {
    return left.localeCompare(right)
  })
}

export const appendPromptConfigReviewServingDelta = async (
  tx: ReviewServingDeltaLedgerTransaction,
  input: AppendPromptConfigReviewServingDeltaInput,
) => {
  const changedPromptConfigFields = getSortedUniqueFields(input.changedPromptConfigFields)
  const typedKey = {changedPromptConfigFields, projectId: input.projectId, promptId: input.promptId}

  await appendReviewServingChangeDelta(tx, {
    changeKind: 'prompt.config.updated',
    configFieldSet: changedPromptConfigFields.join(','),
    payloadJson: typedKey,
    payloadVersion: 1,
    projectId: input.projectId,
    promptId: input.promptId,
    sourceMutationKey: input.sourceMutationKey,
    sourceOperation: input.sourceOperation,
    sourcePartition: input.sourcePartition ?? `promptConfig:${input.projectId}:${input.promptId}`,
    sourceRowId: input.sourceRowId ?? `${input.projectId}:${input.promptId}`,
    sourceTable: input.sourceTable ?? 'app.project_prompt',
    sourceUpdatedAt: input.sourceUpdatedAt,
    typedKey,
  })
}

export const appendPromptConfigReviewServingDeltas = async (
  tx: ReviewServingDeltaLedgerTransaction,
  inputs: readonly AppendPromptConfigReviewServingDeltaInput[],
) => {
  await inputs.reduce<Promise<void>>(async (previousRun, input) => {
    await previousRun
    await appendPromptConfigReviewServingDelta(tx, input)
  }, Promise.resolve())
}

export const appendProjectReviewConfigReviewServingDelta = async (
  tx: ReviewServingDeltaLedgerTransaction,
  input: AppendProjectReviewConfigReviewServingDeltaInput,
) => {
  const changedReviewConfigFields = getSortedUniqueFields(input.changedReviewConfigFields)
  const typedKey = {changedReviewConfigFields, projectId: input.projectId, promptId: input.promptId ?? null}

  await appendReviewServingChangeDelta(tx, {
    changeKind: 'project.reviewConfig.updated',
    configFieldSet: changedReviewConfigFields.join(','),
    payloadJson: typedKey,
    payloadVersion: 1,
    projectId: input.projectId,
    promptId: input.promptId ?? null,
    sourceMutationKey: input.sourceMutationKey,
    sourceOperation: input.sourceOperation,
    sourcePartition: input.sourcePartition ?? `projectReviewConfig:${input.projectId}`,
    sourceRowId: input.sourceRowId ?? input.projectId,
    sourceTable: input.sourceTable ?? 'app.project',
    sourceUpdatedAt: input.sourceUpdatedAt,
    typedKey,
  })
}

export const appendProjectReviewConfigReviewServingDeltas = async (
  tx: ReviewServingDeltaLedgerTransaction,
  inputs: readonly AppendProjectReviewConfigReviewServingDeltaInput[],
) => {
  await inputs.reduce<Promise<void>>(async (previousRun, input) => {
    await previousRun
    await appendProjectReviewConfigReviewServingDelta(tx, input)
  }, Promise.resolve())
}

export const appendProviderModelExecutionIdentityReviewServingDeltas = async (
  tx: ReviewServingDeltaLedgerTransaction,
  input: {modelIds: readonly string[]; sourceMutationKey: string; sourceOperation: ReviewServingSourceOperation},
) => {
  const modelIds = Array.from(new Set(input.modelIds)).filter((modelId) => {
    return modelId.trim().length > 0
  })

  if (modelIds.length === 0) {
    return
  }

  const rows = await tx.queryJson<ProjectModelExecutionIdentityRow>(`
    SELECT p.id AS projectId,
           p.model_id AS modelId
    FROM app.project p
    WHERE p.model_id IN (${getQuotedStringList(modelIds).join(', ')})
    ORDER BY p.id ASC
  `)

  await appendProjectReviewConfigReviewServingDeltas(
    tx,
    rows.map((row) => {
      return {
        changedReviewConfigFields: ['modelExecutionIdentity'],
        projectId: row.projectId,
        sourceMutationKey: input.sourceMutationKey,
        sourceOperation: input.sourceOperation,
        sourcePartition: `providerModelExecutionIdentity:${row.modelId}`,
        sourceRowId: `${row.projectId}:${row.modelId}`,
        sourceTable: 'app.model',
      }
    }),
  )
}

export const appendProviderConnectionExecutionIdentityReviewServingDeltas = async (
  tx: ReviewServingDeltaLedgerTransaction,
  input: {
    providerConnectionIds: readonly string[]
    sourceMutationKey: string
    sourceOperation: ReviewServingSourceOperation
  },
) => {
  const providerConnectionIds = Array.from(new Set(input.providerConnectionIds)).filter((providerConnectionId) => {
    return providerConnectionId.trim().length > 0
  })

  if (providerConnectionIds.length === 0) {
    return
  }

  const rows = await tx.queryJson<ProjectProviderExecutionIdentityRow>(`
    SELECT p.id AS projectId,
           m.provider_connection_id AS providerConnectionId
    FROM app.project p
    INNER JOIN app.model m ON m.id = p.model_id
    WHERE m.provider_connection_id IN (${getQuotedStringList(providerConnectionIds).join(', ')})
    ORDER BY p.id ASC
  `)

  await appendProjectReviewConfigReviewServingDeltas(
    tx,
    rows.map((row) => {
      return {
        changedReviewConfigFields: ['modelExecutionIdentity'],
        projectId: row.projectId,
        sourceMutationKey: input.sourceMutationKey,
        sourceOperation: input.sourceOperation,
        sourcePartition: `providerConnectionExecutionIdentity:${row.providerConnectionId}`,
        sourceRowId: `${row.projectId}:${row.providerConnectionId}`,
        sourceTable: 'app.provider_connection',
      }
    }),
  )
}
