import {Effect} from 'effect'

import {getSqlLiteral} from '../services/appQueryHelpers.ts'
import {type ReviewServingDeltaLedgerTransaction} from './reviewServingDeltaLedger.ts'

export type ReviewImportHotFieldInput = {
  articleId: string
  articleTitle?: string | null
  conflictFlag?: boolean | null
  duplicateFlag?: boolean | null
  duplicateKey?: string | null
  externalId?: string | null
  filterBucketKey?: string | null
  filterBucketValue?: string | null
  importRouteId: string
  journalTitle?: string | null
  publicationYear?: number | null
  sourceKind?: string | null
  sourceRecordHash?: string | null
  sourceRecordKey: string
  sourceUpdatedAt?: Date | string | null
  tombstone?: boolean
}

export type ReviewImportHotFieldRow = Required<
  Pick<ReviewImportHotFieldInput, 'articleId' | 'importRouteId' | 'sourceRecordKey'>
> & {
  articleTitle: string | null
  conflictFlag: boolean | null
  duplicateFlag: boolean | null
  duplicateKey: string | null
  externalId: string | null
  filterBucketKey: string | null
  filterBucketValue: string | null
  journalTitle: string | null
  publicationYear: number | null
  selectedRankKey: string | null
  selectedRankNumeric: number | null
  sourceKind: string | null
  tombstone: boolean
}

export const reviewImportHotFieldProjectorColumns = {
  contributionKeys: ['import_route_id', 'article_id', 'source_record_key', 'filter_bucket_key', 'filter_bucket_value'],
  display: ['external_id', 'article_title', 'journal_title', 'publication_year', 'source_kind'],
  filters: [
    'publication_year',
    'source_kind',
    'duplicate_flag',
    'conflict_flag',
    'filter_bucket_key',
    'filter_bucket_value',
  ],
  postings: ['article_id', 'selected_rank_key', 'filter_bucket_key', 'filter_bucket_value', 'tombstone'],
  selectedImportRanking: [
    'import_route_id',
    'article_id',
    'source_record_key',
    'selected_rank_key',
    'selected_rank_numeric',
    'external_id',
    'tombstone',
  ],
} as const

const getNullableString = (value: string | null | undefined) => {
  const trimmed = value?.trim() ?? null

  return trimmed && trimmed.length > 0 ? trimmed : null
}

const getNullableInteger = (value: number | null | undefined) => {
  return value === null || value === undefined || !Number.isInteger(value) ? null : value
}

const getSelectedRankNumeric = (input: {
  conflictFlag: boolean | null
  duplicateFlag: boolean | null
  duplicateKey: string | null
  externalId: string | null
  filterBucketKey: string | null
  sourceKind: string | null
  tombstone: boolean
}) => {
  const sourcePriority =
    input.conflictFlag || input.duplicateFlag ? 0 : input.duplicateKey ? 1 : input.sourceKind ? 2 : 3
  const externalPriority = input.externalId ? 0 : 1
  const filterPriority = input.filterBucketKey ? 0 : 1
  const tombstonePriority = input.tombstone ? 1 : 0

  return sourcePriority * 1000 + externalPriority * 100 + filterPriority * 10 + tombstonePriority
}

const getSelectedRankKey = (selectedRankNumeric: number, input: {articleId: string; sourceRecordKey: string}) => {
  return [String(selectedRankNumeric).padStart(4, '0'), input.articleId, input.sourceRecordKey].join(':')
}

export const getReviewImportHotFieldRow = (input: ReviewImportHotFieldInput): ReviewImportHotFieldRow => {
  const row = {
    articleId: getNullableString(input.articleId),
    articleTitle: getNullableString(input.articleTitle),
    conflictFlag: input.conflictFlag ?? null,
    duplicateFlag: input.duplicateFlag ?? null,
    duplicateKey: getNullableString(input.duplicateKey),
    externalId: getNullableString(input.externalId),
    filterBucketKey: getNullableString(input.filterBucketKey),
    filterBucketValue: getNullableString(input.filterBucketValue),
    importRouteId: getNullableString(input.importRouteId),
    journalTitle: getNullableString(input.journalTitle),
    publicationYear: getNullableInteger(input.publicationYear),
    sourceKind: getNullableString(input.sourceKind),
    sourceRecordKey: getNullableString(input.sourceRecordKey),
    tombstone: input.tombstone ?? false,
  }

  if (!row.articleId || !row.importRouteId || !row.sourceRecordKey) {
    throw new Error('review import hot fields require importRouteId, articleId, and sourceRecordKey')
  }

  const selectedRankNumeric = getSelectedRankNumeric(row)

  return {
    ...row,
    articleId: row.articleId,
    importRouteId: row.importRouteId,
    selectedRankKey: getSelectedRankKey(selectedRankNumeric, row),
    selectedRankNumeric,
    sourceRecordKey: row.sourceRecordKey,
  }
}

export const getReviewImportHotFieldProjectorColumns = () => {
  return [...new Set(Object.values(reviewImportHotFieldProjectorColumns).flat())]
}

export const upsertReviewImportArticleHotFieldEffect = (
  tx: ReviewServingDeltaLedgerTransaction,
  input: ReviewImportHotFieldInput,
) => {
  const row = getReviewImportHotFieldRow(input)

  return Effect.promise(async () => {
    await tx.run(`
      DELETE FROM app.review_import_article_hot_field
      WHERE import_route_id = ${getSqlLiteral(row.importRouteId)}
        AND article_id = ${getSqlLiteral(row.articleId)}
        AND source_record_key = ${getSqlLiteral(row.sourceRecordKey)}
    `)

    return tx.run(`
      INSERT INTO app.review_import_article_hot_field (
        import_route_id,
        article_id,
        source_record_key,
        source_kind,
        selected_rank_key,
        selected_rank_numeric,
        publication_year,
        article_title,
        journal_title,
        external_id,
        duplicate_flag,
        conflict_flag,
        filter_bucket_key,
        filter_bucket_value,
        tombstone
      ) VALUES (
        ${getSqlLiteral(row.importRouteId)},
        ${getSqlLiteral(row.articleId)},
        ${getSqlLiteral(row.sourceRecordKey)},
        ${getSqlLiteral(row.sourceKind)},
        ${getSqlLiteral(row.selectedRankKey)},
        ${getSqlLiteral(row.selectedRankNumeric)},
        ${getSqlLiteral(row.publicationYear)},
        ${getSqlLiteral(row.articleTitle)},
        ${getSqlLiteral(row.journalTitle)},
        ${getSqlLiteral(row.externalId)},
        ${getSqlLiteral(row.duplicateFlag)},
        ${getSqlLiteral(row.conflictFlag)},
        ${getSqlLiteral(row.filterBucketKey)},
        ${getSqlLiteral(row.filterBucketValue)},
        ${getSqlLiteral(row.tombstone)}
      )
    `)
  })
}

export const upsertReviewImportArticleHotField = async (
  tx: ReviewServingDeltaLedgerTransaction,
  input: ReviewImportHotFieldInput,
) => {
  return Effect.runPromise(upsertReviewImportArticleHotFieldEffect(tx, input))
}
