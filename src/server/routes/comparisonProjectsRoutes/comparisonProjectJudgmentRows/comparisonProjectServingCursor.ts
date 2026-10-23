import {getDateValue, getSqlLiteral} from '../../../services/appQueryHelpers.ts'
import type {ComparisonProjectServingMemberRow} from './comparisonProjectJudgmentRowsTypes.ts'

type ComparisonProjectServingPageCursor = {articleId: string; createdAt: string | null; title: string}

export const getComparisonProjectServingPageCursor = (cursor: string | null | undefined) => {
  if (!cursor) {
    return null
  }

  try {
    const parsedCursor = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Partial<ComparisonProjectServingPageCursor>
    const createdAt =
      parsedCursor.createdAt === null || typeof parsedCursor.createdAt === 'string' ? parsedCursor.createdAt : undefined

    return typeof parsedCursor.articleId === 'string'
      && typeof parsedCursor.title === 'string'
      && createdAt !== undefined
      ? {articleId: parsedCursor.articleId, createdAt, title: parsedCursor.title}
      : null
  } catch {
    return null
  }
}

const comparisonProjectServingCursorTimestampPattern =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/

const getComparisonProjectServingCursorCreatedAt = (value: unknown) => {
  const rowSortCreatedAt = getDateValue(value)

  return rowSortCreatedAt === null
    ? null
    : typeof value === 'string' && comparisonProjectServingCursorTimestampPattern.test(value)
      ? value
      : rowSortCreatedAt.toISOString()
}

export const getComparisonProjectServingNextCursor = (memberRow: ComparisonProjectServingMemberRow | undefined) => {
  const createdAt = getComparisonProjectServingCursorCreatedAt(memberRow?.rowSortCreatedAt)
  const articleId = memberRow?.rowSortArticleId
  const title = memberRow?.rowSortTitle

  return articleId !== null && articleId !== undefined && title !== null && title !== undefined
    ? Buffer.from(JSON.stringify({articleId, createdAt, title}), 'utf8').toString('base64url')
    : null
}

export const getComparisonProjectServingCursorWhereSql = (cursor: ComparisonProjectServingPageCursor | null) => {
  if (cursor === null) {
    return ''
  }

  const titleCondition = `article.row_sort_title > ${getSqlLiteral(cursor.title)}
        OR (article.row_sort_title = ${getSqlLiteral(cursor.title)}
          AND article.row_sort_article_id > ${getSqlLiteral(cursor.articleId)})`

  if (cursor.createdAt === null) {
    return `
      AND article.row_sort_created_at IS NULL
      AND (${titleCondition})
    `
  }

  const cursorCreatedAt = getComparisonProjectServingCursorCreatedAt(cursor.createdAt)
  const cursorCreatedAtLiteral = cursorCreatedAt === null ? null : `TIMESTAMPTZ ${getSqlLiteral(cursorCreatedAt)}`

  return cursorCreatedAtLiteral
    ? `
      AND (
        article.row_sort_created_at < ${cursorCreatedAtLiteral}
        OR article.row_sort_created_at IS NULL
        OR (
          article.row_sort_created_at = ${cursorCreatedAtLiteral}
          AND (${titleCondition})
        )
      )
    `
    : ''
}
