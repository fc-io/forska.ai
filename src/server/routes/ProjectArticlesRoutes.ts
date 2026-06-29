import {Buffer} from 'node:buffer'

import {Elysia, t} from 'elysia'

import {appendProjectScopeArticleReviewServingDelta} from '../reviewServing/projectScopeReviewServingDeltaService.ts'
import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {escapeSqlString, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {insertArticlesIntoProject} from '../services/insertArticlesIntoProject.ts'

type ProjectArticleMembershipCursor = {articleCreatedAt: string | null; articleId: string}

type ProjectArticleMembershipScopeRow = {articleCreatedAt: string | null; id: string}

type ProjectArticleMembershipArticleRow = {articleTitle: string; id: string}

const maxProjectArticleMembershipLimit = 100

const decodeProjectArticleMembershipCursor = (cursor: string | null | undefined) => {
  if (!cursor) {
    return {cursor: null, valid: true}
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Partial<ProjectArticleMembershipCursor>
    const articleCreatedAt = typeof parsed.articleCreatedAt === 'string' ? parsed.articleCreatedAt : null
    const parsedDate = articleCreatedAt ? new Date(articleCreatedAt) : null
    const validDate = !parsedDate || Number.isFinite(parsedDate.getTime())
    const decodedCursor =
      typeof parsed.articleId === 'string' && parsed.articleId.length > 0 && validDate
        ? {articleCreatedAt, articleId: parsed.articleId}
        : null

    return {cursor: decodedCursor, valid: decodedCursor !== null}
  } catch {
    return {cursor: null, valid: false}
  }
}

const encodeProjectArticleMembershipCursor = (row: ProjectArticleMembershipScopeRow) => {
  return Buffer.from(JSON.stringify({articleCreatedAt: row.articleCreatedAt, articleId: row.id}), 'utf8').toString(
    'base64url',
  )
}

const getProjectArticleMembershipCursorClause = (cursor: ProjectArticleMembershipCursor | null) => {
  if (!cursor) {
    return ''
  }

  if (!cursor.articleCreatedAt) {
    return `
      AND scope.article_created_at IS NULL
      AND scope.article_id < ${getSqlLiteral(cursor.articleId)}
    `
  }

  return `
    AND (
      scope.article_created_at < ${getSqlLiteral(new Date(cursor.articleCreatedAt))}
      OR scope.article_created_at IS NULL
      OR (
        scope.article_created_at = ${getSqlLiteral(new Date(cursor.articleCreatedAt))}
        AND scope.article_id < ${getSqlLiteral(cursor.articleId)}
      )
    )
  `
}

const getProjectArticleMembershipLimit = (limit: string | undefined) => {
  const parsed = Number.parseInt(limit ?? '10', 10)
  const normalized = Number.isFinite(parsed) && parsed > 0 ? parsed : 10

  return Math.min(normalized, maxProjectArticleMembershipLimit)
}

const getProjectArticleMembershipRows = async (params: {
  cursor: ProjectArticleMembershipCursor | null
  limit: number
  projectId: string
}) => {
  const rows = await getAppDatabaseService().queryJson<ProjectArticleMembershipScopeRow>(`
    SELECT
      scope.article_id AS id,
      CAST(scope.article_created_at AS VARCHAR) AS articleCreatedAt
    FROM mart.project_scope_article scope
    WHERE scope.project_id = ${getSqlLiteral(params.projectId)}
      AND scope.in_curated_scope = TRUE
      ${getProjectArticleMembershipCursorClause(params.cursor)}
    ORDER BY scope.article_created_at DESC NULLS LAST, scope.article_id DESC
    LIMIT ${params.limit + 1}
  `)

  return rows
}

const getProjectArticleMembershipArticleRows = async (projectId: string, articleIds: string[]) => {
  if (articleIds.length === 0) {
    return []
  }

  return getAppDatabaseService().queryJson<ProjectArticleMembershipArticleRow>(`
    WITH latest_snapshot AS (
      SELECT snapshot_id AS snapshotId
      FROM app.review_serving_snapshot_manifest
      WHERE project_id = ${getSqlLiteral(projectId)}
        AND snapshot_status IN ('active', 'retired')
      ORDER BY updated_at DESC, snapshot_id DESC
      LIMIT 1
    )
    SELECT
      serving.article_id AS id,
      serving.article_title AS articleTitle
    FROM mart.review_article_serving_v4 serving
    INNER JOIN latest_snapshot latest
      ON latest.snapshotId = serving.snapshot_id
    WHERE serving.project_id = ${getSqlLiteral(projectId)}
      AND serving.article_id IN (${articleIds.map(getSqlLiteral).join(', ')})
    ORDER BY serving.article_id ASC,
      CASE serving.list_mode_key
        WHEN 'both' THEN 0
        WHEN 'llm' THEN 1
        WHEN 'human' THEN 2
        WHEN 'unassessed' THEN 3
        ELSE 4
      END ASC
  `)
}

export const projectArticlesRoutes = new Elysia()
  .get(
    '/api/projects/:id/articles',
    async ({params, query, set}) => {
      const {id: projectId} = params
      const page = Number.parseInt(query.page || '1', 10)
      const limit = getProjectArticleMembershipLimit(query.limit)
      const decodedCursor = decodeProjectArticleMembershipCursor(query.cursor)

      if (!decodedCursor.valid) {
        set.status = 400

        return {error: 'Invalid project article membership cursor.'}
      }

      const cursor = decodedCursor.cursor

      if (page > 1 && !cursor) {
        set.status = 400

        return {error: 'Use cursor pagination for project article membership after the first page.'}
      }

      const scopeRows = await getProjectArticleMembershipRows({cursor, limit, projectId})
      const pageRows = scopeRows.slice(0, limit)
      const articleIds = pageRows.map((row) => {
        return row.id
      })
      const articleRows = await getProjectArticleMembershipArticleRows(projectId, articleIds)
      const articleById = articleRows.reduce((map, row) => {
        return map.has(row.id) ? map : map.set(row.id, row)
      }, new Map<string, ProjectArticleMembershipArticleRow>())
      const rows = pageRows.map((row) => {
        const article = articleById.get(row.id)

        return {
          id: row.id,
          articleTitle: article?.articleTitle ?? row.id,
          importedFromProjectId: null,
          importedFromProjectName: null,
        }
      })
      const lastPageRow = pageRows[pageRows.length - 1]
      const nextCursor =
        scopeRows.length > limit && lastPageRow ? encodeProjectArticleMembershipCursor(lastPageRow) : null

      return {
        articles: rows,
        cursor: query.cursor ?? null,
        hasMore: nextCursor !== null,
        limit,
        nextCursor,
        page,
        totalCount: null,
        totalPages: null,
      }
    },
    {
      params: t.Object({id: t.String()}),
      query: t.Object({cursor: t.Optional(t.String()), page: t.Optional(t.String()), limit: t.Optional(t.String())}),
    },
  )
  .post(
    '/api/projects/:id/articles',
    async ({params, body}) => {
      const projectId = params.id
      const articleIds = Array.isArray(body.articleIds) ? body.articleIds : [body.articleIds]
      const importedFromProjectId = body.importedFromProjectId ?? null

      const result = await insertArticlesIntoProject(projectId, articleIds, importedFromProjectId)
      return {success: true, ...result}
    },
    {
      body: t.Object({
        articleIds: t.Union([t.String(), t.Array(t.String())]),
        importedFromProjectId: t.Optional(t.String()),
      }),
    },
  )
  .delete('/api/projects/:id/articles/:articleId', async ({params}) => {
    const {id: projectId, articleId} = params

    await getAppDatabaseService().transaction(async (tx) => {
      const [existingProjectArticle] = await tx.queryJson<{articleId: string; projectArticleId: string}>(`
        SELECT
          id AS projectArticleId,
          article_id AS articleId
        FROM app.project_article
        WHERE project_id = '${escapeSqlString(projectId)}'
          AND article_id = '${escapeSqlString(articleId)}'
        LIMIT 1
      `)

      if (!existingProjectArticle) {
        return
      }

      await tx.run(`
        DELETE FROM app.project_article
        WHERE project_id = '${escapeSqlString(projectId)}'
          AND article_id = '${escapeSqlString(articleId)}'
      `)

      const [remainingImportScope] = await tx.queryJson<{articleId: string}>(`
        SELECT air.article_id AS articleId
        FROM app.article_import_route air
        INNER JOIN app.project_import_route pir ON pir.import_route_id = air.import_route_id
        WHERE pir.project_id = '${escapeSqlString(projectId)}'
          AND air.article_id = '${escapeSqlString(articleId)}'
        LIMIT 1
      `)

      if (!remainingImportScope) {
        await appendProjectScopeArticleReviewServingDelta(tx, {
          articleId,
          changeKind: 'projectScope.article.removed',
          projectArticleId: existingProjectArticle.projectArticleId,
          projectId,
          sourceMutationKey: `ProjectArticlesRoutes.delete|${projectId}|${existingProjectArticle.projectArticleId}`,
          sourceOperation: 'delete',
        })
      }
    })

    return {success: true}
  })
