import {
  comparisonProjectConflictResolutionCommentMaxLength,
  getHasComparisonProjectConflictResolutionCommentControlCharacter,
} from '../../../utils/comparisonProjectConflictResolutionComment.ts'
import {escapeSqlString, getDateValue, getQuotedStringList, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import type {DuckdbTransactionRunner} from '../../utils/duckdbService.ts'
import {HttpError} from '../../utils/httpError.ts'
import type {ComparisonProjectConflictResolutionImportOverwriteMode} from './comparisonProjectConflictResolutionImport.ts'

export const comparisonProjectConflictCommentTable = 'app.comparison_project_conflict_comment'

export type ComparisonProjectConflictCommentAuthor = {displayName: string | null; userId: string}

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

export type ComparisonProjectConflictCommentImport = {
  articleId: string
  authorDisplayName: string | null
  authorUserId: string | null
  comment: string | null
}

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
  const trimmedComment = comment?.trim() || null

  if (trimmedComment !== null && trimmedComment.length > comparisonProjectConflictResolutionCommentMaxLength) {
    throw new HttpError(
      400,
      `Conflict comments are limited to ${comparisonProjectConflictResolutionCommentMaxLength} characters`,
    )
  }

  if (trimmedComment !== null && getHasComparisonProjectConflictResolutionCommentControlCharacter(trimmedComment)) {
    throw new HttpError(400, 'Conflict comments cannot contain control characters')
  }

  return trimmedComment
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

export const getComparisonProjectConflictComment = (
  row: ComparisonProjectConflictCommentReadRow,
): ComparisonProjectConflictComment => {
  return {
    author: row.authorUserId ? {displayName: getTrimmedText(row.authorDisplayName), userId: row.authorUserId} : null,
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

const getIsComparisonProjectConflictCommentImportChange = (
  commentImport: ComparisonProjectConflictCommentImport,
  existingCommentsByArticleId: ReadonlyMap<string, string>,
  overwriteMode: ComparisonProjectConflictResolutionImportOverwriteMode,
) => {
  const existingComment = existingCommentsByArticleId.get(commentImport.articleId) ?? null

  return overwriteMode === 'skip-existing'
    ? existingComment === null && commentImport.comment !== null
    : existingComment !== commentImport.comment
}

const getComparisonProjectConflictCommentsByArticleIdFromRows = (
  rows: readonly {articleId: string; comment: string}[],
) => {
  return rows.reduce<Map<string, string>>((commentMap, row) => {
    return commentMap.has(row.articleId) ? commentMap : commentMap.set(row.articleId, row.comment)
  }, new Map<string, string>())
}

export const importComparisonProjectConflictComments = async (params: {
  comparisonProjectId: string
  commentImports: readonly ComparisonProjectConflictCommentImport[]
  overwriteMode: ComparisonProjectConflictResolutionImportOverwriteMode
  tx: DuckdbTransactionRunner
}) => {
  const articleIds = params.commentImports.map((commentImport) => {
    return commentImport.articleId
  })
  const existingRows =
    articleIds.length === 0
      ? []
      : await params.tx.queryJson<ComparisonProjectConflictCommentReadRow>(
          getComparisonProjectConflictCommentReadRowsSql(params.comparisonProjectId, articleIds),
        )
  const existingCommentsByArticleId = getComparisonProjectConflictCommentsByArticleIdFromRows(existingRows)
  const changedImports = params.commentImports.filter((commentImport) => {
    return getIsComparisonProjectConflictCommentImportChange(
      commentImport,
      existingCommentsByArticleId,
      params.overwriteMode,
    )
  })
  const insertedComments = changedImports.flatMap<ComparisonProjectConflictCommentWrite>((commentImport) => {
    return commentImport.comment === null ? [] : [{...commentImport, comment: commentImport.comment}]
  })

  if (changedImports.length > 0) {
    await params.tx.queryJson<ComparisonProjectConflictCommentDeletedRow>(
      getDeleteComparisonProjectConflictCommentsSql(
        params.comparisonProjectId,
        changedImports.map((commentImport) => {
          return commentImport.articleId
        }),
      ),
    )
  }

  if (insertedComments.length > 0) {
    await params.tx.queryJson<ComparisonProjectConflictCommentReadRow>(
      getInsertComparisonProjectConflictCommentsSql(params.comparisonProjectId, insertedComments),
    )
  }

  return changedImports.length
}
