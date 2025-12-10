import {and, eq, gte, inArray, lte, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {articles, judgments, models, projectArticles, projectPrompts, projects, prompts} from '../../db/schema.ts'
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
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        modelName: models.name,
      })
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

      // Build filter conditions - ALL prompts must match (AND logic)
      // Similar to projectsRoutesGetArticlesReviewsBoth.ts
      const filterConditions: Array<ReturnType<typeof sql>> = []

      for (const selection of body.promptSelections) {
        if (selection.types.length === 0) continue

        const answeredValsArray = sql.join(
          selection.types.map((v) => {
            return sql`${v}`
          }),
          sql`,`,
        )

        // Normalized array handling: COALESCE(answered_original_as_array, ARRAY[answered_original])
        const normalized = sql`COALESCE(${judgments.answeredOriginalAsArray}, CASE WHEN ${judgments.answeredOriginal} IS NOT NULL THEN ARRAY[${judgments.answeredOriginal}] ELSE ARRAY[]::text[] END)`

        // Create EXISTS subquery for this prompt
        const subquery = db
          .select({exists: sql`1`})
          .from(judgments)
          .where(
            and(
              eq(judgments.articleId, articles.id),
              eq(judgments.promptId, selection.promptId),
              sql`(${normalized}) && ARRAY[${answeredValsArray}]::text[]`,
            ),
          )
          .limit(1)

        filterConditions.push(sql`EXISTS (${subquery})`)
      }

      if (filterConditions.length === 0) {
        console.log(`[subprojects] No valid prompt selections, no articles added`)
        return {data: {project: newProject, articleCount: 0}}
      }

      // Build where clause: all filter conditions must be true (AND logic)
      const whereParts: Array<ReturnType<typeof sql>> = [...filterConditions]

      // Add optional date range filter
      if (body.dateFrom) {
        const fromDate = new Date(`${body.dateFrom}T00:00:00.000Z`)
        whereParts.push(gte(articles.articleCreatedAt, fromDate))
      }
      if (body.dateTo) {
        const toDate = new Date(`${body.dateTo}T23:59:59.999Z`)
        whereParts.push(lte(articles.articleCreatedAt, toDate))
      }

      const combinedWhere = whereParts.length > 1 ? and(...whereParts) : whereParts[0]

      // Find articles that match ALL filter conditions
      const matchingArticles = await db.selectDistinct({id: articles.id}).from(articles).where(combinedWhere)

      const articleIds = matchingArticles.map((a) => {
        return a.id
      })
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
      }),
    },
  )
