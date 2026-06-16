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
