import {
  appendReviewServingChangeDelta,
  type ReviewServingDeltaLedgerTransaction,
  type ReviewServingSourceOperation,
} from './reviewServingDeltaLedger.ts'

export type ProjectScopeReviewServingDeltaKind = 'projectScope.article.added' | 'projectScope.article.removed'

export type ProjectScopeArticleReviewServingDeltaRow = {
  articleId: string
  projectArticleId: string
  projectId: string
  sourceUpdatedAt?: Date | string | null
}

export type AppendProjectScopeArticleReviewServingDeltaInput = ProjectScopeArticleReviewServingDeltaRow & {
  changeKind: ProjectScopeReviewServingDeltaKind
  sourceMutationKey: string
  sourceOperation: ReviewServingSourceOperation
  sourcePartition?: string
  sourceRowId?: string
  sourceTable?: string
}

export const appendProjectScopeArticleReviewServingDelta = async (
  tx: ReviewServingDeltaLedgerTransaction,
  input: AppendProjectScopeArticleReviewServingDeltaInput,
) => {
  const typedKey = {articleId: input.articleId, projectArticleId: input.projectArticleId, projectId: input.projectId}

  await appendReviewServingChangeDelta(tx, {
    articleId: input.articleId,
    changeKind: input.changeKind,
    payloadJson: typedKey,
    payloadVersion: 1,
    projectId: input.projectId,
    sourceMutationKey: input.sourceMutationKey,
    sourceOperation: input.sourceOperation,
    sourcePartition: input.sourcePartition ?? `projectScope:${input.projectId}`,
    sourceRowId: input.sourceRowId ?? input.projectArticleId,
    sourceTable: input.sourceTable ?? 'app.project_article',
    sourceUpdatedAt: input.sourceUpdatedAt,
    typedKey,
  })
}

export const appendProjectScopeArticleReviewServingDeltas = async (
  tx: ReviewServingDeltaLedgerTransaction,
  inputs: readonly AppendProjectScopeArticleReviewServingDeltaInput[],
) => {
  await inputs.reduce<Promise<void>>(async (previousRun, input) => {
    await previousRun
    await appendProjectScopeArticleReviewServingDelta(tx, input)
  }, Promise.resolve())
}
