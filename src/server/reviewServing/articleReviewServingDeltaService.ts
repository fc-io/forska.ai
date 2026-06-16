import {createHash} from 'node:crypto'

import {getStableReviewServingJson, type ReviewServingIdentityValue} from './reviewProjectionIdentity.ts'
import {
  appendReviewServingChangeDelta,
  type ReviewServingDeltaLedgerTransaction,
  type ReviewServingSourceOperation,
} from './reviewServingDeltaLedger.ts'

export type ArticleReviewServingFieldName =
  | 'articleAuthors'
  | 'articleCreatedAt'
  | 'articleSummary'
  | 'articleTitle'
  | 'arxivId'
  | 'biorxivId'
  | 'doi'
  | 'fullText'
  | 'fullTextHtml'
  | 'fullTextPDF'
  | 'medrxivId'
  | 'publicationStatus'
  | 'pubmedId'
  | 'sourceMetadata'
  | 'url'

export type ArticleReviewServingDeltaInput = {
  articleId: string
  changedFields: readonly ArticleReviewServingFieldName[]
  sourceMutationKey: string
  sourceOperation: ReviewServingSourceOperation
  sourcePartition?: string
  sourceRowId?: string
  sourceTable?: string
  sourceUpdatedAt?: Date | string | null
}

type ArticleReviewServingDeltaPlan = {
  changeKind: 'article.display.updated' | 'article.judgmentInput.updated' | 'article.searchText.updated'
  payloadJson: Record<string, unknown>
  typedKey: Record<string, unknown>
}

const displayFieldNames = [
  'articleAuthors',
  'articleCreatedAt',
  'articleSummary',
  'articleTitle',
  'arxivId',
  'biorxivId',
  'doi',
  'fullTextPDF',
  'medrxivId',
  'publicationStatus',
  'pubmedId',
  'sourceMetadata',
  'url',
] as const
const searchFieldNames = ['articleSummary', 'articleTitle', 'fullText'] as const
const titleFieldNames = ['articleTitle'] as const
const abstractFieldNames = ['articleSummary'] as const
const fullTextFieldNames = ['fullText', 'fullTextHtml', 'fullTextPDF'] as const

const getChangedKnownFields = <TFieldName extends ArticleReviewServingFieldName>(
  changedFields: readonly ArticleReviewServingFieldName[],
  knownFields: readonly TFieldName[],
) => {
  return knownFields.filter((fieldName) => {
    return changedFields.includes(fieldName)
  })
}

const getArticleReviewServingDeltaPlans = (input: ArticleReviewServingDeltaInput): ArticleReviewServingDeltaPlan[] => {
  const uniqueChangedFields = Array.from(new Set(input.changedFields))
  const changedDisplayFieldNames = getChangedKnownFields(uniqueChangedFields, displayFieldNames)
  const changedSearchableFieldNames = getChangedKnownFields(uniqueChangedFields, searchFieldNames)
  const affectedContentFlags = [
    ...getChangedKnownFields(uniqueChangedFields, titleFieldNames).map(() => {
      return 'useTitle' as const
    }),
    ...getChangedKnownFields(uniqueChangedFields, abstractFieldNames).map(() => {
      return 'useAbstract' as const
    }),
    ...getChangedKnownFields(uniqueChangedFields, fullTextFieldNames).flatMap(() => {
      return ['useFulltext' as const, 'useFulltextNoImages' as const]
    }),
  ]
  const uniqueAffectedContentFlags = Array.from(new Set(affectedContentFlags))
  const displayPlan: ArticleReviewServingDeltaPlan | null =
    changedDisplayFieldNames.length === 0
      ? null
      : {
          changeKind: 'article.display.updated',
          payloadJson: {articleId: input.articleId, changedDisplayFieldNames},
          typedKey: {articleId: input.articleId, changedDisplayFieldNames},
        }
  const searchPlan: ArticleReviewServingDeltaPlan | null =
    changedSearchableFieldNames.length === 0
      ? null
      : {
          changeKind: 'article.searchText.updated',
          payloadJson: {articleId: input.articleId, changedSearchableFieldNames},
          typedKey: {articleId: input.articleId, changedSearchableFieldNames},
        }
  const judgmentPlan: ArticleReviewServingDeltaPlan | null =
    uniqueAffectedContentFlags.length === 0
      ? null
      : {
          changeKind: 'article.judgmentInput.updated',
          payloadJson: {affectedContentFlags: uniqueAffectedContentFlags, articleId: input.articleId},
          typedKey: {affectedContentFlags: uniqueAffectedContentFlags, articleId: input.articleId},
        }

  return [displayPlan, searchPlan, judgmentPlan].filter((plan): plan is ArticleReviewServingDeltaPlan => {
    return plan !== null
  })
}

export const appendArticleReviewServingDeltas = async (
  tx: ReviewServingDeltaLedgerTransaction,
  input: ArticleReviewServingDeltaInput,
) => {
  const plans = getArticleReviewServingDeltaPlans(input)

  await plans.reduce<Promise<void>>(async (previousRun, plan) => {
    await previousRun
    await appendReviewServingChangeDelta(tx, {
      articleId: input.articleId,
      changeKind: plan.changeKind,
      payloadJson: plan.payloadJson,
      payloadVersion: 1,
      sourceMutationKey: `${input.sourceMutationKey}|${plan.changeKind}`,
      sourceOperation: input.sourceOperation,
      sourcePartition: input.sourcePartition ?? `article:${input.articleId}`,
      sourceRowId: input.sourceRowId ?? input.articleId,
      sourceTable: input.sourceTable ?? 'app.article',
      sourceUpdatedAt: input.sourceUpdatedAt,
      typedKey: plan.typedKey,
    })
  }, Promise.resolve())
}

export const getChangedArticleReviewServingFieldNames = <TCurrent extends Record<string, unknown>>(
  current: TCurrent,
  nextValues: Partial<Record<ArticleReviewServingFieldName, unknown>>,
) => {
  return Object.entries(nextValues)
    .filter(([fieldName, value]) => {
      return current[fieldName] !== value
    })
    .map(([fieldName]) => {
      return fieldName as ArticleReviewServingFieldName
    })
}

export const getArticleReviewServingMutationValueHash = (value: unknown) => {
  return createHash('sha256')
    .update(getStableReviewServingJson(value as ReviewServingIdentityValue))
    .digest('hex')
}

export const appendArticleReviewServingDeltasForIds = async (
  tx: ReviewServingDeltaLedgerTransaction,
  input: Omit<ArticleReviewServingDeltaInput, 'articleId' | 'sourceRowId'> & {articleIds: readonly string[]},
) => {
  const uniqueArticleIds = Array.from(new Set(input.articleIds))

  await uniqueArticleIds.reduce<Promise<void>>(async (previousRun, articleId) => {
    await previousRun
    await appendArticleReviewServingDeltas(tx, {
      ...input,
      articleId,
      sourceRowId: articleId,
      sourceMutationKey: `${input.sourceMutationKey}|${articleId}`,
    })
  }, Promise.resolve())
}
