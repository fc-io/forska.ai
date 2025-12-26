import {and, eq, inArray, isNull, or, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {
  articleRouteLink,
  articles,
  judgments,
  projectArticles,
  projectRouteLink,
  projects,
  prompts,
} from '../../db/schema.ts'
import {requireUserAuth} from '../utils/authGuard.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'

export const projectExportRoutes = new Elysia()
  .use(withErrorHandler())
  .use(requireUserAuth())
  .post(
    '/api/projects/:id/export',
    async ({params, body}) => {
      const db = getDatabase()
      const projectId = params.id

      // Verify project exists
      const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
      if (!project) {
        throw new Error('Project not found')
      }

      const promptIds = body.promptIds
      if (!promptIds || promptIds.length === 0) {
        throw new Error('No prompts selected for export')
      }

      // Get prompt details for headers
      const promptDetails = await db
        .select({id: prompts.id, promptHeading: prompts.promptHeading, originalText: prompts.originalText})
        .from(prompts)
        .where(inArray(prompts.id, promptIds))

      // Create a map of promptId to header
      const promptHeaderMap = new Map<string, string>()
      for (const p of promptDetails) {
        promptHeaderMap.set(p.id, p.promptHeading || p.originalText.substring(0, 50))
      }

      // Build scope condition for articles
      // Articles accessible via source projects' import routes or project_articles
      const sourceProjectIds = body.sourceProjectIds || [projectId]

      // Get import routes for source projects
      const projectImportRoutes = await db
        .select({projectId: projectRouteLink.projectId, importRouteId: projectRouteLink.importRouteId})
        .from(projectRouteLink)
        .where(inArray(projectRouteLink.projectId, sourceProjectIds))

      const allImportRouteIds = projectImportRoutes.map((r) => {
        return r.importRouteId
      })

      // Build scope parts
      const scopeParts: Array<ReturnType<typeof sql>> = []

      // Add import route scope if any exist
      if (allImportRouteIds.length > 0) {
        const routeIdArray = sql.join(
          allImportRouteIds.map((r) => {
            return sql`${r}::uuid`
          }),
          sql`,`,
        )
        scopeParts.push(
          sql`EXISTS (
            SELECT 1 FROM ${articleRouteLink} arl
            WHERE arl."article_id" = ${articles.id}
              AND arl."import_route_id" = ANY(ARRAY[${routeIdArray}])
          )`,
        )
      }

      // Add project_articles scope for each source project
      for (const sourceProjectId of sourceProjectIds) {
        scopeParts.push(
          sql`EXISTS (
            SELECT 1 FROM ${projectArticles} pa
            WHERE pa."article_id" = ${articles.id}
              AND pa."project_id" = ${sourceProjectId}::uuid
          )`,
        )
      }

      const scopeCondition = scopeParts.length > 1 ? or(...scopeParts) : scopeParts[0]

      // Get all articles in scope with their judgments for selected prompts
      const articlesWithJudgments = await db
        .select({
          articleId: articles.id,
          articleTitle: articles.articleTitle,
          promptId: judgments.promptId,
          answeredOriginal: judgments.answeredOriginal,
          answeredOriginalAsArray: judgments.answeredOriginalAsArray,
        })
        .from(articles)
        .innerJoin(
          judgments,
          and(
            eq(judgments.articleId, articles.id),
            inArray(judgments.promptId, promptIds),
            isNull(judgments.deletedAt),
          ),
        )
        .where(scopeCondition)
        .orderBy(articles.id)

      // Group by article
      const articleMap = new Map<string, {title: string; answers: Map<string, string>}>()

      for (const row of articlesWithJudgments) {
        if (!articleMap.has(row.articleId)) {
          articleMap.set(row.articleId, {title: row.articleTitle || 'Untitled', answers: new Map()})
        }
        const article = articleMap.get(row.articleId)
        if (article) {
          // Get the answer - prefer array format if available, else original
          let answer = row.answeredOriginal || ''
          if (row.answeredOriginalAsArray && row.answeredOriginalAsArray.length > 0) {
            answer = row.answeredOriginalAsArray.join('; ')
          }
          article.answers.set(row.promptId, answer)
        }
      }

      // Build CSV
      // Header row: Title, then each prompt heading
      const orderedPromptIds = promptIds.filter((id) => {
        return promptHeaderMap.has(id)
      })
      const headers = [
        'Title',
        ...orderedPromptIds.map((id) => {
          return promptHeaderMap.get(id) || id
        }),
      ]

      // Escape CSV field
      const escapeCSV = (value: string): string => {
        if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
          return `"${value.replace(/"/g, '""')}"`
        }
        return value
      }

      const rows: string[] = []
      rows.push(headers.map(escapeCSV).join(','))

      for (const [_, articleData] of articleMap) {
        const row = [
          articleData.title,
          ...orderedPromptIds.map((promptId) => {
            return articleData.answers.get(promptId) || ''
          }),
        ]
        rows.push(row.map(escapeCSV).join(','))
      }

      const csv = rows.join('\n')
      const filename = `${project.name.replace(/[^a-zA-Z0-9]/g, '_')}_export_${new Date().toISOString().slice(0, 10)}.csv`

      return {csv, filename}
    },
    {body: t.Object({promptIds: t.Array(t.String()), sourceProjectIds: t.Optional(t.Array(t.String()))})},
  )
