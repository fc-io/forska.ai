import {and, eq, gte, inArray, isNull, lte, or, sql} from 'drizzle-orm'
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
  modelId: string
  modelName: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  prompts: Array<{id: string; promptHeading: string | null; originalText: string; type: string | null}>
}

const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

type ProjectBound = {
  id: string
  modelId: string
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}

type PromptFilter = {promptId: string; types: string[]}

const queryArticlesWithPromptFilters = async (
  db: ReturnType<typeof getDatabase>,
  promptFilters: PromptFilter[],
  allSelectedPromptIds: string[],
  projectBounds: ProjectBound[],
  combinedWhereCondition: ReturnType<typeof and> | ReturnType<typeof sql> | undefined,
) => {
  const normalized = sql`COALESCE(${judgments.answeredOriginalAsArray}, CASE WHEN ${judgments.answeredOriginal} IS NOT NULL THEN ARRAY[${judgments.answeredOriginal}] ELSE ARRAY[]::text[] END)`

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

  const judgmentConfigParts = projectBounds.map((proj) => {
    return and(
      eq(judgments.modelId, proj.modelId),
      eq(judgments.useTitle, proj.useTitle),
      eq(judgments.useAbstract, proj.useAbstract),
      eq(judgments.useFulltext, proj.useFulltext),
      eq(judgments.useFulltextNoImages, proj.useFulltextNoImages),
    )
  })
  const judgmentConfigCondition = judgmentConfigParts.length > 1 ? or(...judgmentConfigParts) : judgmentConfigParts[0]

  return db
    .select({id: articles.id})
    .from(articles)
    .innerJoin(
      judgments,
      and(
        eq(judgments.articleId, articles.id),
        inArray(judgments.promptId, allSelectedPromptIds),
        isNull(judgments.deletedAt),
        judgmentConfigCondition,
      ),
    )
    .where(combinedWhereCondition)
    .groupBy(articles.id)
    .having(and(...havingParts))
}

const queryAllArticlesInScope = async (
  db: ReturnType<typeof getDatabase>,
  combinedWhereCondition: ReturnType<typeof and> | ReturnType<typeof sql> | undefined,
) => {
  return db.select({id: articles.id}).from(articles).where(combinedWhereCondition)
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
        modelId: projects.modelId,
        modelName: models.name,
        useTitle: projects.useTitle,
        useAbstract: projects.useAbstract,
        useFulltext: projects.useFulltext,
        useFulltextNoImages: projects.useFulltextNoImages,
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
          id: project.id,
          name: project.name,
          description: project.description,
          modelId: project.modelId,
          modelName: project.modelName,
          useTitle: project.useTitle,
          useAbstract: project.useAbstract,
          useFulltext: project.useFulltext,
          useFulltextNoImages: project.useFulltextNoImages,
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

      // Build filter conditions per source project (AND within a project),
      // then union matching articles across all selected projects.

      if (body.sourceProjectIds.length === 0) {
        console.log(`[subprojects] No source projects selected, no articles added`)
        return {data: {project: newProject, articleCount: 0}}
      }

      // Build prompt filter conditions (for the specific answer types selected)
      const promptFilters = body.promptSelections.filter((s) => {
        return s.types.length > 0
      })

      // Get all prompt IDs that we're filtering on (may be empty)
      const allSelectedPromptIds = promptFilters.map((f) => {
        return f.promptId
      })

      // For each source project, get its import routes
      const projectImportRoutes = await db
        .select({projectId: projectRouteLink.projectId, importRouteId: projectRouteLink.importRouteId})
        .from(projectRouteLink)
        .where(inArray(projectRouteLink.projectId, body.sourceProjectIds))

      // Get project date bounds and content/model settings
      const projectBounds = await db
        .select({
          id: projects.id,
          dateFrom: projects.dateFrom,
          dateTo: projects.dateTo,
          modelId: projects.modelId,
          useTitle: projects.useTitle,
          useAbstract: projects.useAbstract,
          useFulltext: projects.useFulltext,
          useFulltextNoImages: projects.useFulltextNoImages,
        })
        .from(projects)
        .where(inArray(projects.id, body.sourceProjectIds))

      const importRoutesByProjectId = new Map<string, string[]>()
      for (const row of projectImportRoutes) {
        const current = importRoutesByProjectId.get(row.projectId) ?? []
        current.push(row.importRouteId)
        importRoutesByProjectId.set(row.projectId, current)
      }

      const promptIdsForMapping = allSelectedPromptIds.length > 0 ? Array.from(new Set(allSelectedPromptIds)) : []
      const promptIdsByProjectId = new Map<string, Set<string>>()
      if (promptIdsForMapping.length > 0) {
        const projectPromptRows = await db
          .select({projectId: projectPrompts.projectId, promptId: projectPrompts.promptId})
          .from(projectPrompts)
          .where(
            and(
              inArray(projectPrompts.projectId, body.sourceProjectIds),
              inArray(projectPrompts.promptId, promptIdsForMapping),
              eq(projectPrompts.enabled, true),
            ),
          )

        for (const row of projectPromptRows) {
          const current = promptIdsByProjectId.get(row.projectId) ?? new Set<string>()
          current.add(row.promptId)
          promptIdsByProjectId.set(row.projectId, current)
        }
      }

      const userDateFrom = body.dateFrom ? new Date(`${body.dateFrom}T00:00:00.000Z`) : null
      const userDateTo = body.dateTo ? new Date(`${body.dateTo}T23:59:59.999Z`) : null

      const uniqueArticleIds = new Set<string>()

      for (const sourceProject of projectBounds) {
        const projectPromptIdSet = promptIdsByProjectId.get(sourceProject.id) ?? new Set<string>()
        const applicablePromptFilters = promptFilters.filter((f) => {
          return projectPromptIdSet.has(f.promptId)
        })
        const applicablePromptIds = applicablePromptFilters.map((f) => {
          return f.promptId
        })

        const projectScopeParts: Array<ReturnType<typeof sql>> = []

        const routeIds = importRoutesByProjectId.get(sourceProject.id) ?? []
        if (routeIds.length > 0) {
          const routeIdArray = sql.join(
            routeIds.map((r) => {
              return sql`${r}::uuid`
            }),
            sql`,`,
          )
          projectScopeParts.push(
            sql`EXISTS (
              SELECT 1 FROM ${articleRouteLink} arl
              WHERE arl."article_id" = ${articles.id}
                AND arl."import_route_id" = ANY(ARRAY[${routeIdArray}])
            )`,
          )
        }

        projectScopeParts.push(
          sql`EXISTS (
            SELECT 1 FROM ${projectArticles} pa
            WHERE pa."article_id" = ${articles.id}
              AND pa."project_id" = ${sourceProject.id}::uuid
          )`,
        )

        const projectScopeCondition =
          (projectScopeParts.length > 1 ? or(...projectScopeParts) : projectScopeParts[0]) ?? sql`FALSE`

        const projectWhereParts: Array<ReturnType<typeof sql>> = []
        if (sourceProject.dateFrom) {
          projectWhereParts.push(gte(articles.articleCreatedAt, sourceProject.dateFrom))
        }
        if (sourceProject.dateTo) {
          projectWhereParts.push(lte(articles.articleCreatedAt, sourceProject.dateTo))
        }
        if (userDateFrom) {
          projectWhereParts.push(gte(articles.articleCreatedAt, userDateFrom))
        }
        if (userDateTo) {
          projectWhereParts.push(lte(articles.articleCreatedAt, userDateTo))
        }
        projectWhereParts.push(projectScopeCondition)

        const projectWhereCondition = projectWhereParts.length > 1 ? and(...projectWhereParts) : projectWhereParts[0]

        const matchingArticles =
          applicablePromptFilters.length > 0
            ? await queryArticlesWithPromptFilters(
                db,
                applicablePromptFilters,
                applicablePromptIds,
                [sourceProject],
                projectWhereCondition,
              )
            : await queryAllArticlesInScope(db, projectWhereCondition)

        for (const row of matchingArticles) {
          uniqueArticleIds.add(row.id)
        }
      }

      const articleIds = Array.from(uniqueArticleIds)
      console.log(
        `[subprojects] Found ${articleIds.length} articles matching criteria across ${projectBounds.length} projects`,
      )

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
