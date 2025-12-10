import {and, eq, inArray} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {judgments, models, projectArticles, projectPrompts, projects, prompts} from '../../db/schema.ts'
import {requireUserAuth} from '../utils/authGuard.ts'
import {computePromptContentHash} from '../utils/computePromptContentHash.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'

type ProjectWithPrompts = {
  id: string
  name: string
  description: string | null
  prompts: Array<{
    id: string
    promptHeading: string | null
    type: string | null
  }>
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

    // Get all non-archived projects
    const projectsList = await db
      .select({id: projects.id, name: projects.name, description: projects.description})
      .from(projects)
      .where(eq(projects.archived, false))
      .orderBy(projects.name)

    // For each project, get prompts with their type
    const projectsWithPrompts: ProjectWithPrompts[] = []

    for (const project of projectsList) {
      // Get prompts for this project
      const projectPromptsList = await db
        .select({id: prompts.id, promptHeading: prompts.promptHeading, type: prompts.type})
        .from(projectPrompts)
        .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
        .where(and(eq(projectPrompts.projectId, project.id), eq(projectPrompts.enabled, true)))
        .orderBy(projectPrompts.order)

      // Include all projects that have prompts
      if (projectPromptsList.length > 0) {
        projectsWithPrompts.push({
          ...project,
          prompts: projectPromptsList.map((p) => {
            return {id: p.id, promptHeading: p.promptHeading, type: p.type}
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

      // Build a map of promptId -> selected types
      const promptTypeMap = new Map<string, Set<string>>()
      for (const selection of body.promptSelections) {
        if (!promptTypeMap.has(selection.promptId)) {
          promptTypeMap.set(selection.promptId, new Set())
        }
        const typeSet = promptTypeMap.get(selection.promptId)
        if (typeSet) {
          for (const type of selection.types) {
            typeSet.add(type)
          }
        }
      }

      // Find articles that have judgments matching the selected prompts and types
      // This needs to handle potentially many articles, so we batch the inserts
      const articleIdSet = new Set<string>()

      // Query articles with matching judgments for each prompt/type combination
      for (const [promptId, types] of promptTypeMap) {
        const typesArray = Array.from(types)
        if (typesArray.length === 0) continue

        // Get article IDs that have judgments with matching answers
        const matchingArticles = await db
          .select({articleId: judgments.articleId})
          .from(judgments)
          .where(and(eq(judgments.promptId, promptId), inArray(judgments.answeredOriginal, typesArray)))
          .groupBy(judgments.articleId)

        for (const row of matchingArticles) {
          articleIdSet.add(row.articleId)
        }
      }

      const articleIds = Array.from(articleIdSet)
      console.log(`[subprojects] Found ${articleIds.length} articles matching criteria`)

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
        promptSelections: t.Array(t.Object({promptId: t.String(), types: t.Array(t.String())})),
      }),
    },
  )
