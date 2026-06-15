import {
  appendReviewServingChangeDelta,
  type ReviewServingDeltaAppendResult,
  type ReviewServingDeltaLedgerTransaction,
  type ReviewServingSourceOperation,
} from './reviewServingDeltaLedger.ts'
import {appendReviewWriteOverlay, type ReviewWriteOverlayEligibleReadSurface} from './reviewWriteOverlayService.ts'

export type HumanJudgmentReviewServingDeltaRow = {
  answer?: string | null
  articleId: string
  comment?: string | null
  humanJudgmentKey: string
  projectId: string
  promptId?: string | null
  sourceUpdatedAt?: Date | string | null
}

export type HumanJudgmentReviewServingOverlayInput = {
  readSurface: ReviewWriteOverlayEligibleReadSurface
  reviewConfigHash?: string | null
  ttlMs?: number
}

export type AppendHumanJudgmentReviewServingDeltaInput = HumanJudgmentReviewServingDeltaRow & {
  reviewerOverlay?: HumanJudgmentReviewServingOverlayInput
  sourceMutationKey: string
  sourceOperation: ReviewServingSourceOperation
  sourcePartition?: string
  sourceRowId?: string
  sourceTable?: string
}

export const appendHumanJudgmentReviewServingDelta = async (
  tx: ReviewServingDeltaLedgerTransaction,
  input: AppendHumanJudgmentReviewServingDeltaInput,
): Promise<ReviewServingDeltaAppendResult> => {
  const sourcePartition = input.sourcePartition ?? `humanJudgment:${input.projectId}:${input.articleId}`
  const typedKey = {
    articleId: input.articleId,
    humanJudgmentKey: input.humanJudgmentKey,
    projectId: input.projectId,
    promptId: input.promptId ?? null,
  }

  const result = await appendReviewServingChangeDelta(tx, {
    articleId: input.articleId,
    changeKind: 'judgment.human.updated',
    humanJudgmentKey: input.humanJudgmentKey,
    payloadJson: {...typedKey, answer: input.answer ?? null},
    payloadVersion: 1,
    projectId: input.projectId,
    promptId: input.promptId ?? null,
    sourceMutationKey: input.sourceMutationKey,
    sourceOperation: input.sourceOperation,
    sourcePartition,
    sourceRowId: input.sourceRowId ?? input.humanJudgmentKey,
    sourceTable: input.sourceTable ?? (input.promptId ? 'app.judgment_human' : 'app.judgment_human_summary'),
    sourceUpdatedAt: input.sourceUpdatedAt,
    typedKey,
  })

  if (input.reviewerOverlay) {
    await appendReviewWriteOverlay(tx, {
      articleId: input.articleId,
      createdAt: input.sourceUpdatedAt ?? undefined,
      humanJudgmentKey: input.humanJudgmentKey,
      overlayKind: 'humanJudgment.answer',
      overlayValueJson: {
        answer: input.answer ?? null,
        comment: input.comment ?? null,
        humanJudgmentKey: input.humanJudgmentKey,
        promptId: input.promptId ?? null,
      },
      projectId: input.projectId,
      promptId: input.promptId ?? null,
      readSurface: input.reviewerOverlay.readSurface,
      reviewConfigHash: input.reviewerOverlay.reviewConfigHash ?? null,
      sourceHighWaterMark: result.sourceHighWaterMark,
      sourcePartition,
      ttlMs: input.reviewerOverlay.ttlMs,
    })
  }

  return result
}

export const appendHumanJudgmentReviewServingDeltas = async (
  tx: ReviewServingDeltaLedgerTransaction,
  inputs: readonly AppendHumanJudgmentReviewServingDeltaInput[],
): Promise<ReviewServingDeltaAppendResult[]> => {
  return inputs.reduce<Promise<ReviewServingDeltaAppendResult[]>>(async (previousRun, input) => {
    const results = await previousRun
    const result = await appendHumanJudgmentReviewServingDelta(tx, input)

    return [...results, result]
  }, Promise.resolve([]))
}
