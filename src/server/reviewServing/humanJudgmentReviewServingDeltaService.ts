import {
  appendReviewServingChangeDelta,
  type ReviewServingDeltaLedgerTransaction,
  type ReviewServingSourceOperation,
} from './reviewServingDeltaLedger.ts'

export type HumanJudgmentReviewServingDeltaRow = {
  answer?: string | null
  articleId: string
  humanJudgmentKey: string
  projectId: string
  promptId?: string | null
  sourceUpdatedAt?: Date | string | null
}

export type AppendHumanJudgmentReviewServingDeltaInput = HumanJudgmentReviewServingDeltaRow & {
  sourceMutationKey: string
  sourceOperation: ReviewServingSourceOperation
  sourcePartition?: string
  sourceRowId?: string
  sourceTable?: string
}

export const appendHumanJudgmentReviewServingDelta = async (
  tx: ReviewServingDeltaLedgerTransaction,
  input: AppendHumanJudgmentReviewServingDeltaInput,
) => {
  const typedKey = {
    articleId: input.articleId,
    humanJudgmentKey: input.humanJudgmentKey,
    projectId: input.projectId,
    promptId: input.promptId ?? null,
  }

  await appendReviewServingChangeDelta(tx, {
    articleId: input.articleId,
    changeKind: 'judgment.human.updated',
    humanJudgmentKey: input.humanJudgmentKey,
    payloadJson: {...typedKey, answer: input.answer ?? null},
    payloadVersion: 1,
    projectId: input.projectId,
    promptId: input.promptId ?? null,
    sourceMutationKey: input.sourceMutationKey,
    sourceOperation: input.sourceOperation,
    sourcePartition: input.sourcePartition ?? `humanJudgment:${input.projectId}:${input.articleId}`,
    sourceRowId: input.sourceRowId ?? input.humanJudgmentKey,
    sourceTable: input.sourceTable ?? (input.promptId ? 'app.judgment_human' : 'app.judgment_human_summary'),
    sourceUpdatedAt: input.sourceUpdatedAt,
    typedKey,
  })
}

export const appendHumanJudgmentReviewServingDeltas = async (
  tx: ReviewServingDeltaLedgerTransaction,
  inputs: readonly AppendHumanJudgmentReviewServingDeltaInput[],
) => {
  await inputs.reduce<Promise<void>>(async (previousRun, input) => {
    await previousRun
    await appendHumanJudgmentReviewServingDelta(tx, input)
  }, Promise.resolve())
}
