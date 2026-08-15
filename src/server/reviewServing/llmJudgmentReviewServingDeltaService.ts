import {
  appendReviewServingChangeDelta,
  appendReviewServingChangeDeltas,
  type ReviewServingDeltaAppendInput,
  type ReviewServingDeltaLedgerTransaction,
  type ReviewServingSourceOperation,
} from './reviewServingDeltaLedger.ts'

export type LlmJudgmentReviewServingDeltaKind = 'judgment.llm.created' | 'judgment.llm.deleted' | 'judgment.llm.updated'

export type LlmJudgmentReviewServingDeltaRow = {
  articleId: string
  judgmentId: string
  modelId: string
  projectId: string | null
  promptId: string
  sourceUpdatedAt?: Date | string | null
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useTitle: boolean
}

export type AppendLlmJudgmentReviewServingDeltaInput = LlmJudgmentReviewServingDeltaRow & {
  changeKind: LlmJudgmentReviewServingDeltaKind
  sourceMutationKey: string
  sourceOperation: ReviewServingSourceOperation
  sourcePartition?: string
  sourceRowId?: string
  sourceTable?: string
}

const getContentFlags = (input: LlmJudgmentReviewServingDeltaRow) => {
  return {
    useAbstract: input.useAbstract,
    useFulltext: input.useFulltext,
    useFulltextNoImages: input.useFulltextNoImages,
    useTitle: input.useTitle,
  }
}

const getLlmJudgmentReviewServingDeltaInput = (
  input: AppendLlmJudgmentReviewServingDeltaInput,
): ReviewServingDeltaAppendInput => {
  const contentFlags = getContentFlags(input)

  return {
    articleId: input.articleId,
    changeKind: input.changeKind,
    judgmentId: input.judgmentId,
    modelId: input.modelId,
    payloadJson: {
      articleId: input.articleId,
      contentFlags,
      judgmentId: input.judgmentId,
      modelId: input.modelId,
      projectId: input.projectId,
      promptId: input.promptId,
    },
    payloadVersion: 1,
    projectId: input.projectId,
    promptId: input.promptId,
    sourceMutationKey: input.sourceMutationKey,
    sourceOperation: input.sourceOperation,
    sourcePartition: input.sourcePartition ?? `llmJudgment:${input.articleId}`,
    sourceRowId: input.sourceRowId ?? input.judgmentId,
    sourceTable: input.sourceTable ?? 'app.judgment',
    sourceUpdatedAt: input.sourceUpdatedAt,
    typedKey: {
      articleId: input.articleId,
      contentFlags,
      judgmentId: input.judgmentId,
      modelId: input.modelId,
      projectId: input.projectId,
      promptId: input.promptId,
    },
    useAbstract: input.useAbstract,
    useFulltext: input.useFulltext,
    useFulltextNoImages: input.useFulltextNoImages,
    useTitle: input.useTitle,
  }
}

export const appendLlmJudgmentReviewServingDelta = async (
  tx: ReviewServingDeltaLedgerTransaction,
  input: AppendLlmJudgmentReviewServingDeltaInput,
) => {
  return appendReviewServingChangeDelta(tx, getLlmJudgmentReviewServingDeltaInput(input))
}

export const appendLlmJudgmentReviewServingDeltas = async (
  tx: ReviewServingDeltaLedgerTransaction,
  inputs: readonly AppendLlmJudgmentReviewServingDeltaInput[],
) => {
  return appendReviewServingChangeDeltas(tx, inputs.map(getLlmJudgmentReviewServingDeltaInput))
}
