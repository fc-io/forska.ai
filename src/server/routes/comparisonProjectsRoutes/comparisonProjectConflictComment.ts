import {
  comparisonProjectConflictResolutionCommentMaxLength,
  getNormalizedComparisonProjectConflictComment,
} from '../../../utils/comparisonProjectConflictResolutionComment.ts'
import {escapeSqlString, getDateValue, getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import type {DuckdbTransactionRunner} from '../../utils/duckdbService.ts'
import {HttpError} from '../../utils/httpError.ts'
import type {ComparisonProjectConflictResolutionImportCommentChange} from './comparisonProjectConflictResolutionImport/comparisonProjectConflictResolutionImportTypes.ts'

export const comparisonProjectConflictCommentTable = 'app.comparison_project_conflict_comment'

export type ComparisonProjectConflictCommentAuthor = {displayName: string | null; userId: string | null}

export type ComparisonProjectConflictComment = {
  author: ComparisonProjectConflictCommentAuthor | null
  comment: string
  updatedAt: Date | null
}

export type ComparisonProjectConflictCommentReadRow = {
  articleId: string
  authorDisplayName: string | null
  authorUserId: string | null
  comment: string
  updatedAt: unknown
}

export type ComparisonProjectConflictCommentWrite = {
  articleId: string
  authorDisplayName: string | null
  authorUserId: string | null
  comment: string
  createdAt?: unknown
}

type ComparisonProjectConflictCommentQueryRunner = Pick<DuckdbTransactionRunner, 'queryJson'>

type ComparisonProjectConflictCommentDeletedRow = {articleId: string; comment: string; createdAt: unknown}

const getTrimmedText = (value: string | null | undefined) => {
  const trimmedValue = value?.trim() ?? ''

  return trimmedValue.length > 0 ? trimmedValue : null
}

const getArticleIdsSql = (articleIds: readonly string[]) => {
  return getQuotedStringList([...articleIds]).join(', ')
}

const getCreatedAtSql = (value: unknown) => {
  const literalValue =
    value instanceof Date ? value.toISOString() : typeof value === 'string' && getDateValue(value) ? value : null

  return literalValue === null ? 'current_timestamp' : `TIMESTAMPTZ '${escapeSqlString(literalValue)}'`
}

export const getValidatedComparisonProjectConflictComment = (comment: string | null) => {
  const isRemoval = (comment?.trim() ?? '') === ''
  const normalizedComment = getNormalizedComparisonProjectConflictComment(comment)

  if (!isRemoval && normalizedComment === null) {
    throw new HttpError(400, 'Conflict comments need text besides control characters')
  }

  if (normalizedComment !== null && normalizedComment.length > comparisonProjectConflictResolutionCommentMaxLength) {
    throw new HttpError(
      400,
      `Conflict comments are limited to ${comparisonProjectConflictResolutionCommentMaxLength} characters`,
    )
  }

  return normalizedComment
}

export const getComparisonProjectConflictCommentReadRowsSql = (
  comparisonProjectId: string,
  articleIds: readonly string[],
) => {
  return `
    SELECT
      cc.article_id AS articleId,
      cc.comment AS comment,
      cc.updated_at AS updatedAt,
      cc.author_user_id AS authorUserId,
      COALESCE(NULLIF(TRIM(cc.author_display_name), ''), NULLIF(TRIM(author.name), '')) AS authorDisplayName
    FROM ${comparisonProjectConflictCommentTable} cc
    LEFT JOIN app.user_config author ON author.id = cc.author_user_id
    WHERE cc.comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
      AND cc.article_id IN (${getArticleIdsSql(articleIds)})
    ORDER BY cc.article_id ASC, cc.updated_at DESC, cc.id DESC
  `
}

const getComparisonProjectConflictCommentAuthor = (
  row: Pick<ComparisonProjectConflictCommentReadRow, 'authorDisplayName' | 'authorUserId'>,
): ComparisonProjectConflictCommentAuthor | null => {
  const displayName = getTrimmedText(row.authorDisplayName)

  return row.authorUserId || displayName ? {displayName, userId: row.authorUserId || null} : null
}

export const getComparisonProjectConflictComment = (
  row: ComparisonProjectConflictCommentReadRow,
): ComparisonProjectConflictComment => {
  return {
    author: getComparisonProjectConflictCommentAuthor(row),
    comment: row.comment,
    updatedAt: getDateValue(row.updatedAt),
  }
}

export const getComparisonProjectConflictCommentsByArticleId = (
  rows: readonly ComparisonProjectConflictCommentReadRow[],
) => {
  return rows.reduce<Map<string, ComparisonProjectConflictComment>>((commentMap, row) => {
    return commentMap.has(row.articleId)
      ? commentMap
      : commentMap.set(row.articleId, getComparisonProjectConflictComment(row))
  }, new Map<string, ComparisonProjectConflictComment>())
}

const getDeleteComparisonProjectConflictCommentsSql = (comparisonProjectId: string, articleIds: readonly string[]) => {
  return `
    DELETE FROM ${comparisonProjectConflictCommentTable}
    WHERE comparison_project_id = ${getSqlLiteral(comparisonProjectId)}
      AND article_id IN (${getArticleIdsSql(articleIds)})
    RETURNING article_id AS articleId, comment, created_at AS createdAt
  `
}

const getInsertComparisonProjectConflictCommentsSql = (
  comparisonProjectId: string,
  comments: readonly ComparisonProjectConflictCommentWrite[],
) => {
  return `
    INSERT INTO ${comparisonProjectConflictCommentTable} (
      id,
      comparison_project_id,
      article_id,
      comment,
      author_user_id,
      author_display_name,
      created_at,
      updated_at
    )
    VALUES ${comments
      .map((comment) => {
        return `(
      ${getSqlLiteral(crypto.randomUUID())},
      ${getSqlLiteral(comparisonProjectId)},
      ${getSqlLiteral(comment.articleId)},
      ${getSqlLiteral(comment.comment)},
      ${getSqlLiteral(comment.authorUserId)},
      ${getSqlLiteral(getTrimmedText(comment.authorDisplayName))},
      ${getCreatedAtSql(comment.createdAt)},
      current_timestamp
    )`
      })
      .join(',\n')}
    RETURNING
      article_id AS articleId,
      comment,
      updated_at AS updatedAt,
      author_user_id AS authorUserId,
      author_display_name AS authorDisplayName
  `
}

const getEarliestCreatedAt = (rows: readonly ComparisonProjectConflictCommentDeletedRow[]) => {
  return rows.reduce<unknown>((earliestCreatedAt, row) => {
    const createdAt = getDateValue(row.createdAt)
    const earliestDate = getDateValue(earliestCreatedAt)

    return createdAt && (!earliestDate || createdAt < earliestDate) ? row.createdAt : earliestCreatedAt
  }, null)
}

export const replaceComparisonProjectConflictComment = async (params: {
  articleId: string
  author: {id: string; name: string | null} | null
  comment: string | null
  comparisonProjectId: string
  tx: DuckdbTransactionRunner
}): Promise<ComparisonProjectConflictComment | null> => {
  const deletedRows = await params.tx.queryJson<ComparisonProjectConflictCommentDeletedRow>(
    getDeleteComparisonProjectConflictCommentsSql(params.comparisonProjectId, [params.articleId]),
  )
  const insertedRows =
    params.comment === null
      ? []
      : await params.tx.queryJson<ComparisonProjectConflictCommentReadRow>(
          getInsertComparisonProjectConflictCommentsSql(params.comparisonProjectId, [
            {
              articleId: params.articleId,
              authorDisplayName: params.author?.name ?? null,
              authorUserId: params.author?.id ?? null,
              comment: params.comment,
              createdAt: getEarliestCreatedAt(deletedRows),
            },
          ]),
        )
  const [insertedRow] = insertedRows

  return insertedRow ? getComparisonProjectConflictComment(insertedRow) : null
}

export const getComparisonProjectConflictCommentTextsByArticleId = async (params: {
  articleIds: readonly string[]
  comparisonProjectId: string
  queryRunner: ComparisonProjectConflictCommentQueryRunner
}) => {
  const articleIds = Array.from(new Set(params.articleIds))
  const rows =
    articleIds.length === 0
      ? []
      : await params.queryRunner.queryJson<ComparisonProjectConflictCommentReadRow>(
          getComparisonProjectConflictCommentReadRowsSql(params.comparisonProjectId, articleIds),
        )

  return rows.reduce<Map<string, string>>((commentMap, row) => {
    return commentMap.has(row.articleId) ? commentMap : commentMap.set(row.articleId, row.comment)
  }, new Map<string, string>())
}

const getCreatedAtByArticleId = (rows: readonly ComparisonProjectConflictCommentDeletedRow[]) => {
  const rowsByArticleId = rows.reduce<Map<string, ComparisonProjectConflictCommentDeletedRow[]>>((rowMap, row) => {
    return rowMap.set(row.articleId, [...(rowMap.get(row.articleId) ?? []), row])
  }, new Map<string, ComparisonProjectConflictCommentDeletedRow[]>())

  return new Map(
    Array.from(rowsByArticleId.entries()).map(([articleId, articleRows]) => {
      return [articleId, getEarliestCreatedAt(articleRows)] as const
    }),
  )
}

export const getComparisonProjectConflictCommentImportWrites = (
  commentChanges: readonly ComparisonProjectConflictResolutionImportCommentChange[],
) => {
  return commentChanges.filter((commentChange) => {
    return commentChange.change !== 'keep'
  })
}

export const writeComparisonProjectConflictCommentImportChanges = async (params: {
  commentChanges: readonly ComparisonProjectConflictResolutionImportCommentChange[]
  comparisonProjectId: string
  tx: DuckdbTransactionRunner
}) => {
  const commentWrites = getComparisonProjectConflictCommentImportWrites(params.commentChanges)

  if (commentWrites.length === 0) {
    return 0
  }

  const deletedRows = await params.tx.queryJson<ComparisonProjectConflictCommentDeletedRow>(
    getDeleteComparisonProjectConflictCommentsSql(
      params.comparisonProjectId,
      commentWrites.map((commentChange) => {
        return commentChange.targetArticleId
      }),
    ),
  )
  const createdAtByArticleId = getCreatedAtByArticleId(deletedRows)

  await params.tx.queryJson<ComparisonProjectConflictCommentReadRow>(
    getInsertComparisonProjectConflictCommentsSql(
      params.comparisonProjectId,
      commentWrites.map((commentChange) => {
        return {
          articleId: commentChange.targetArticleId,
          authorDisplayName: commentChange.authorDisplayName,
          authorUserId: commentChange.authorUserId,
          comment: commentChange.comment,
          createdAt: createdAtByArticleId.get(commentChange.targetArticleId) ?? null,
        }
      }),
    ),
  )

  return commentWrites.length
}
