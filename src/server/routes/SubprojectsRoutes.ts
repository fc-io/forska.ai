import {and, eq, gte, inArray, lte, or, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {
  articleRouteLink,
  articles,
  judgments,
  models,
  projectArticles,
  projectPrompts,
  projectRouteLink,
  projects,
  prompts,
} from '../../db/schema.ts'
import {requireUserAuth} from '../utils/authGuard.ts'
import {computePromptContentHash} from '../utils/computePromptContentHash.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'

type ProjectWithPrompts = {
  id: string
  name: string
  description: string | null
  modelName: string | null
  prompts: Array<{id: string; promptHeading: string | null; originalText: string; type: string | null}>
}

const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export const subprojectsRoutes = new Elysia()
  .use(withErrorHandler())
  .use(requireUserAuth())
  // Get all projects with their prompts
  .get('/api/subprojects/sources', async () => {
    const db = getDatabase()

    // Get all non-archived projects with their model name
    const projectsList = await db
      .select({id: projects.id, name: projects.name, description: projects.description, modelName: models.name})
      .from(projects)
      .innerJoin(models, eq(projects.modelId, models.id))
      .where(eq(projects.archived, false))
      .orderBy(projects.name)

    // For each project, get prompts with their type and originalText
    const projectsWithPrompts: ProjectWithPrompts[] = []

    for (const project of projectsList) {
      // Get prompts for this project
      const projectPromptsList = await db
        .select({
          id: prompts.id,
          promptHeading: prompts.promptHeading,
          originalText: prompts.originalText,
          type: prompts.type,
        })
        .from(projectPrompts)
        .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
        .where(and(eq(projectPrompts.projectId, project.id), eq(projectPrompts.enabled, true)))
        .orderBy(projectPrompts.order)

      // Include all projects that have prompts
      if (projectPromptsList.length > 0) {
        projectsWithPrompts.push({
          ...project,
          prompts: projectPromptsList.map((p) => {
            return {id: p.id, promptHeading: p.promptHeading, originalText: p.originalText, type: p.type}
          }),
        })
      }
    }

    return {data: projectsWithPrompts}
  })
  // Create a subproject from selected projects, prompts, and types
  .post(
    '/api/subprojects',
    async ({body}) => {
      const db = getDatabase()

      // Validate model exists
      const [validModel] = await db.select({id: models.id}).from(models).where(eq(models.id, body.modelId)).limit(1)
      if (!validModel) {
        throw new Error('Selected model does not exist')
      }

      // Create the new project
      const [newProject] = await db
        .insert(projects)
        .values({
          name: body.name,
          description: body.description || null,
          ownerId: body.ownerId,
          modelId: body.modelId,
          useTitle: true,
          useAbstract: true,
          useFulltext: false,
          dateFrom: body.dateFrom ? new Date(body.dateFrom) : null,
          dateTo: body.dateTo ? new Date(body.dateTo) : null,
        })
        .returning()

      if (!newProject) {
        throw new Error('Failed to create project')
      }

      // Link prompts to the new project
      const promptIdSet = new Set<string>()
      for (const selection of body.promptSelections) {
        if (!promptIdSet.has(selection.promptId)) {
          promptIdSet.add(selection.promptId)
        }
      }
      const promptIds = Array.from(promptIdSet)

      if (promptIds.length > 0) {
        // Fetch prompt details to create associations
        const promptDetails = await db.select().from(prompts).where(inArray(prompts.id, promptIds))

        let orderIndex = 0
        for (const prompt of promptDetails) {
          const contentHash = computePromptContentHash(
            prompt.originalText,
            prompt.transformedText,
            prompt.promptHeading,
            prompt.type,
          )

          // Check if prompt with this hash exists, otherwise use existing
          let targetPromptId = prompt.id
          if (contentHash !== prompt.contentHash) {
            const [existingByHash] = await db
              .select({id: prompts.id})
              .from(prompts)
              .where(eq(prompts.contentHash, contentHash))
              .limit(1)
            if (existingByHash) {
              targetPromptId = existingByHash.id
            }
          }

          await db
            .insert(projectPrompts)
            .values({
              projectId: newProject.id,
              promptId: targetPromptId,
              order: orderIndex,
              archived: false,
              enabled: true,
              originProjectId: newProject.id,
            })
            .onConflictDoNothing({target: [projectPrompts.projectId, projectPrompts.promptId]})
          orderIndex++
        }
      }

      // Build filter conditions matching the Reviews LLM page behavior:
      // 1. Scope articles to source projects (via import routes or project_articles)
      // 2. Require articles to be fully assessed for ALL prompts on each source project
      // 3. Apply the answer type filters

      if (body.sourceProjectIds.length === 0) {
        console.log(`[subprojects] No source projects selected, no articles added`)
        return {data: {project: newProject, articleCount: 0}}
      }

      // For each source project, get its import routes and prompts
      const projectImportRoutes = await db
        .select({projectId: projectRouteLink.projectId, importRouteId: projectRouteLink.importRouteId})
        .from(projectRouteLink)
        .where(inArray(projectRouteLink.projectId, body.sourceProjectIds))

      // Group import routes by project
      const routesByProject = new Map<string, string[]>()
      for (const row of projectImportRoutes) {
        const routes = routesByProject.get(row.projectId) || []
        routes.push(row.importRouteId)
        routesByProject.set(row.projectId, routes)
      }

      // Get all prompts for each source project
      const sourceProjectPrompts = await db
        .select({projectId: projectPrompts.projectId, promptId: prompts.id})
        .from(projectPrompts)
        .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
        .where(and(inArray(projectPrompts.projectId, body.sourceProjectIds), eq(projectPrompts.enabled, true)))

      // Group prompts by project
      const promptsByProject = new Map<string, string[]>()
      for (const row of sourceProjectPrompts) {
        const prompts = promptsByProject.get(row.projectId) || []
        prompts.push(row.promptId)
        promptsByProject.set(row.projectId, prompts)
      }

      // Get project date bounds
      const projectBounds = await db
        .select({id: projects.id, dateFrom: projects.dateFrom, dateTo: projects.dateTo})
        .from(projects)
        .where(inArray(projects.id, body.sourceProjectIds))

      const boundsByProject = new Map<string, {dateFrom: Date | null; dateTo: Date | null}>()
      for (const row of projectBounds) {
        boundsByProject.set(row.id, {dateFrom: row.dateFrom, dateTo: row.dateTo})
      }

      // Build prompt filter conditions (for the specific answer types selected)
      const promptFilters = body.promptSelections.filter((s) => {
        return s.types.length > 0
      })

      // Use HAVING-based filtering like the Reviews LLM page
      // This requires: COUNT(DISTINCT judgments.promptId) = promptIds.length for full assessment
      // AND SUM(CASE WHEN ...) > 0 for answer type filters

      const normalized = sql`COALESCE(${judgments.answeredOriginalAsArray}, CASE WHEN ${judgments.answeredOriginal} IS NOT NULL THEN ARRAY[${judgments.answeredOriginal}] ELSE ARRAY[]::text[] END)`

      // Build HAVING conditions for selected prompt/type filters
      const havingParts: Array<ReturnType<typeof sql>> = []
      for (const filter of promptFilters) {
        const answeredValsArray = sql.join(
          filter.types.map((v) => {
            return sql`${v}`
          }),
          sql`,`,
        )
        havingParts.push(
          sql`SUM(CASE WHEN ${judgments.promptId} = ${filter.promptId}::uuid AND (${normalized}) && ARRAY[${answeredValsArray}]::text[] THEN 1 ELSE 0 END) > 0`,
        )
      }

      if (havingParts.length === 0) {
        console.log(`[subprojects] No valid prompt selections, no articles added`)
        return {data: {project: newProject, articleCount: 0}}
      }

      // Collect all matching article IDs across all source projects
      const allMatchingArticleIds: string[] = []

      for (const sourceProjectId of body.sourceProjectIds) {
        const projectPromptIds = promptsByProject.get(sourceProjectId) || []
        if (projectPromptIds.length === 0) continue

        const projectRoutes = routesByProject.get(sourceProjectId) || []
        const bounds = boundsByProject.get(sourceProjectId)

        // Build scope condition: articles accessible via import routes OR project_articles
        const routeIdArray =
          projectRoutes.length > 0
            ? sql.join(
                projectRoutes.map((r) => {
                  return sql`${r}::uuid`
                }),
                sql`,`,
              )
            : null

        const hasMatchingImportRoute =
          routeIdArray !== null
            ? sql`EXISTS (
                SELECT 1 FROM ${articleRouteLink} arl
                WHERE arl."article_id" = ${articles.id}
                  AND arl."import_route_id" = ANY(ARRAY[${routeIdArray}])
              )`
            : null
        const hasProjectArticle = sql`EXISTS (
          SELECT 1 FROM ${projectArticles} pa
          WHERE pa."article_id" = ${articles.id}
            AND pa."project_id" = ${sourceProjectId}::uuid
        )`
        const scopeCondition = hasMatchingImportRoute
          ? or(hasMatchingImportRoute, hasProjectArticle)
          : hasProjectArticle

        // Build where conditions
        const whereParts: Array<ReturnType<typeof sql>> = []

        // Project date bounds
        if (bounds?.dateFrom) {
          whereParts.push(gte(articles.articleCreatedAt, bounds.dateFrom))
        }
        if (bounds?.dateTo) {
          whereParts.push(lte(articles.articleCreatedAt, bounds.dateTo))
        }

        // User-specified date range
        if (body.dateFrom) {
          const fromDate = new Date(`${body.dateFrom}T00:00:00.000Z`)
          whereParts.push(gte(articles.articleCreatedAt, fromDate))
        }
        if (body.dateTo) {
          const toDate = new Date(`${body.dateTo}T23:59:59.999Z`)
          whereParts.push(lte(articles.articleCreatedAt, toDate))
        }

        const combinedWhereCondition = whereParts.length > 1 ? and(...whereParts) : whereParts[0]

        // Build the full HAVING: require full assessment for ALL project prompts + answer type filters
        const fullHavingParts: Array<ReturnType<typeof sql>> = [
          sql`COUNT(DISTINCT ${judgments.promptId}) = ${projectPromptIds.length}`,
          ...havingParts,
        ]

        // Query matching articles for this project using grouped query with HAVING (like Reviews LLM page)
        const groupedQuery = db
          .select({id: articles.id})
          .from(articles)
          .innerJoin(
            judgments,
            and(eq(judgments.articleId, articles.id), inArray(judgments.promptId, projectPromptIds)),
          )
          .where(combinedWhereCondition ? and(combinedWhereCondition, scopeCondition) : scopeCondition)
          .groupBy(articles.id)
          .having(fullHavingParts.length > 1 ? and(...fullHavingParts) : fullHavingParts[0])

        const matchingArticles = await groupedQuery
        for (const row of matchingArticles) {
          allMatchingArticleIds.push(row.id)
        }
      }

      // Deduplicate article IDs (in case a single article appears in multiple source projects)
      const articleIds = [...new Set(allMatchingArticleIds)]
      console.log(`[subprojects] Found ${articleIds.length} articles matching ALL criteria`)

      // Insert articles into the new project in batches
      const batchSize = 1000
      let insertedCount = 0
      for (const idsChunk of chunk(articleIds, batchSize)) {
        if (idsChunk.length === 0) continue
        await db
          .insert(projectArticles)
          .values(
            idsChunk.map((articleId) => {
              return {projectId: newProject.id, articleId, importedFromProjectId: null}
            }),
          )
          .onConflictDoNothing({target: [projectArticles.projectId, projectArticles.articleId]})
        insertedCount += idsChunk.length
      }

      console.log(`[subprojects] Inserted ${insertedCount} articles into project ${newProject.id}`)

      return {data: {project: newProject, articleCount: articleIds.length}}
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.String()),
        ownerId: t.String(),
        modelId: t.String(),
        dateFrom: t.Optional(t.String()),
        dateTo: t.Optional(t.String()),
        promptSelections: t.Array(t.Object({promptId: t.String(), types: t.Array(t.String())})),
        sourceProjectIds: t.Array(t.String()),
      }),
    },
  )
