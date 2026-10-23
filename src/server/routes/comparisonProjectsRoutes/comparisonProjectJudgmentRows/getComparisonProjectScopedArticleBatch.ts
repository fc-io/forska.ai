import {getDateValue} from '../../../services/appQueryHelpers.ts'
import type {
  ComparisonProjectScopedArticle,
  ComparisonProjectScopedArticleQueryRunner,
} from './comparisonProjectJudgmentRowsTypes.ts'
import {getPositiveInteger} from './comparisonProjectJudgmentRowsUtils.ts'

type ComparisonProjectScopedArticleRow = Omit<ComparisonProjectScopedArticle, 'articleCreatedAt'> & {
  articleCreatedAt: unknown
}

const getNonNegativeInteger = (value: number) => {
  const integerValue = Number.isFinite(value) ? Math.floor(value) : 0
  return Math.max(integerValue, 0)
}

export const getComparisonProjectScopedArticleBatchSql = (params: {
  articleTable: string
  limit: number
  offset: number
  whereClause: string
}) => {
  const limit = getPositiveInteger(params.limit)
  const offset = getNonNegativeInteger(params.offset)

  return `
      SELECT
        id,
        id AS canonicalArticleId,
        article_id AS articleExternalId,
        article_title AS articleTitle,
        article_summary AS articleSummary,
        article_created_at AS articleCreatedAt
      FROM ${params.articleTable} a
      ${params.whereClause}
      ORDER BY a.article_created_at DESC, a.article_title ASC, a.id ASC
      LIMIT ${limit}
      OFFSET ${offset}
    `
}

export const getComparisonProjectScopedArticleBatch = async (params: {
  articleTable: string
  limit: number
  offset: number
  queryRunner: ComparisonProjectScopedArticleQueryRunner
  whereClause: string
}) => {
  const rows = await params.queryRunner.queryJson<ComparisonProjectScopedArticleRow>(
    getComparisonProjectScopedArticleBatchSql(params),
  )

  return rows.map((row) => {
    return {...row, articleCreatedAt: getDateValue(row.articleCreatedAt)}
  })
}
