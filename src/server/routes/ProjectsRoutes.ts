import {and, asc, desc, eq, inArray, isNull, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {
  importRoute as importRouteTable,
  judgments,
  judgmentsHuman,
  judgmentsJobs,
  models,
  projectArticles,
  projectPrompts,
  projectRouteLink,
  projects,
  prompts,
} from '../../db/schema.ts'
import {computePromptContentHash} from '../utils/computePromptContentHash.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'
import {projectsRoutesGetArticlesReviews} from './projectsRoutes/projectsRoutesGetArticlesReviews.ts'
import {projectsRoutesGetArticlesReviewsBoth} from './projectsRoutes/projectsRoutesGetArticlesReviewsBoth.ts'
import {projectsRoutesGetArticlesReviewsClickHouse} from './projectsRoutes/projectsRoutesGetArticlesReviewsClickHouse.ts'
import {projectsRoutesGetArticlesReviewsCount} from './projectsRoutes/projectsRoutesGetArticlesReviewsCount.ts'
import {projectsRoutesGetArticlesReviewsFilters} from './projectsRoutes/projectsRoutesGetArticlesReviewsFilters.ts'
import {projectsRoutesGetArticlesReviewsHuman} from './projectsRoutes/projectsRoutesGetArticlesReviewsHuman.ts'
import {projectsRoutesGetArticlesReviewsHumanFilters} from './projectsRoutes/projectsRoutesGetArticlesReviewsHumanFilters.ts'
import {projectsRoutesGetArticlesReviewsUnassessed} from './projectsRoutes/projectsRoutesGetArticlesReviewsUnassessed.ts'
import {projectsRoutesGetReviewsHealth} from './projectsRoutes/projectsRoutesGetReviewsHealth.ts'
import {projectsRoutesPostArticleReviewDetails} from './projectsRoutes/projectsRoutesPostArticleReviewDetails.ts'

const parseOptionalDate = (value?: string | null) => {
  if (!value) {
    return null
  }
  const trimmedValue = value.trim()
  if (!trimmedValue) {
    return null
  }
  const isoDateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/
  const hasIsoDateOnlyMatch = isoDateOnlyPattern.exec(trimmedValue)
  const normalizedValue = hasIsoDateOnlyMatch ? `${trimmedValue}T00:00:00.000Z` : trimmedValue
  const parsedDate = new Date(normalizedValue)
  if (Number.isNaN(parsedDate.getTime())) {
    throw new Error('Invalid date value provided')
  }
  return parsedDate
}

const _getOrphanPromptIds = async (tx: ReturnType<typeof getDatabase>, promptIds: string[]) => {
  if (promptIds.length === 0) {
    return []
  }

  const linkedToProjects = await tx
    .select({promptId: projectPrompts.promptId})
    .from(projectPrompts)
    .where(inArray(projectPrompts.promptId, promptIds))

  const usedInJudgments = await tx
    .select({promptId: judgments.promptId})
    .from(judgments)
    .where(inArray(judgments.promptId, promptIds))

  const usedInHumanJudgments = await tx
    .select({promptId: judgmentsHuman.promptId})
    .from(judgmentsHuman)
    .where(inArray(judgmentsHuman.promptId, promptIds))

  const usedPromptIds = new Set(
    [...linkedToProjects, ...usedInJudgments, ...usedInHumanJudgments].map((row) => {
      return row.promptId
    }),
  )

  return promptIds.filter((id) => {
    return !usedPromptIds.has(id)
  })
}

export const projectsRoutes = new Elysia()
  .use(withErrorHandler())
  .use(projectsRoutesGetArticlesReviews)
  .use(projectsRoutesGetArticlesReviewsCount)
  .use(projectsRoutesGetArticlesReviewsBoth)
  .use(projectsRoutesGetArticlesReviewsHuman)
  .use(projectsRoutesGetArticlesReviewsUnassessed)
  .use(projectsRoutesGetArticlesReviewsFilters)
  .use(projectsRoutesGetArticlesReviewsHumanFilters)
  .use(projectsRoutesPostArticleReviewDetails)
  .use(projectsRoutesGetArticlesReviewsClickHouse)
  .use(projectsRoutesGetReviewsHealth)
  .use(
    new Elysia().get('/api/projects-without-jobs', async () => {
      const db = getDatabase()
      const rows = await db
        .select({id: projects.id, name: projects.name, description: projects.description})
        .from(projects)
        .leftJoin(judgmentsJobs, eq(judgmentsJobs.projectId, projects.id))
        .where(isNull(judgmentsJobs.id))
        .orderBy(desc(projects.createdAt))

      return {data: rows}
    }),
  )
  .get('/api/projects', async () => {
    const db = getDatabase()
    // Filter out archived projects by default
    const projectsList = await db
      .select({project: projects, modelName: models.modelName})
      .from(projects)
      .leftJoin(models, eq(projects.modelId, models.id))
      .where(eq(projects.archived, false))
      .orderBy(asc(projects.name))

    const projectsWithModelName = projectsList.map(({project, modelName}) => {
      return {...project, modelName}
    })

    return {data: projectsWithModelName}
  })
  .get('/api/projects/archived', async () => {
    const db = getDatabase()
    // Return only archived projects
    const projectsList = await db
      .select({project: projects, modelName: models.modelName})
      .from(projects)
      .leftJoin(models, eq(projects.modelId, models.id))
      .where(eq(projects.archived, true))
      .orderBy(desc(projects.createdAt))

    const projectsWithModelName = projectsList.map(({project, modelName}) => {
      return {...project, modelName}
    })

    return {data: projectsWithModelName}
  })
  .get('/api/projects/:id', async ({params}) => {
    const db = getDatabase()
    const [project] = await db.select().from(projects).where(eq(projects.id, params.id)).limit(1)

    if (!project) {
      throw new Error('Project not found')
    }

    const projectPromptsList = await db
      .select({
        id: prompts.id,
        originalText: prompts.originalText,
        transformedText: prompts.transformedText,
        promptHeading: prompts.promptHeading,
        order: projectPrompts.order,
        archived: projectPrompts.archived,
        promptArchived: prompts.archived,
        type: prompts.type,
        enabled: projectPrompts.enabled,
        originProjectId: projectPrompts.originProjectId,
        contentHash: prompts.contentHash,
        createdAt: prompts.createdAt,
      })
      .from(projectPrompts)
      .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
      .where(eq(projectPrompts.projectId, params.id))
      .orderBy(projectPrompts.order)

    // All non-archived prompts not already linked to this project
    const importablePrompts = await db
      .select({
        id: prompts.id,
        originalText: prompts.originalText,
        transformedText: prompts.transformedText,
        promptHeading: prompts.promptHeading,
        order: sql<number>`NULL`,
        archived: sql<boolean>`FALSE`,
        promptArchived: prompts.archived,
        type: prompts.type,
        enabled: sql<boolean>`FALSE`,
        originProjectId: sql<string>`NULL`,
        contentHash: prompts.contentHash,
        createdAt: prompts.createdAt,
      })
      .from(prompts)
      .leftJoin(projectPrompts, and(eq(projectPrompts.projectId, params.id), eq(projectPrompts.promptId, prompts.id)))
      .where(and(isNull(projectPrompts.id), eq(prompts.archived, false)))

    const promptsCombined = [...projectPromptsList, ...importablePrompts]

    // Lock projects for editing if a judgment job exists for the project
    const existingJob = await db
      .select({id: judgmentsJobs.id})
      .from(judgmentsJobs)
      .where(eq(judgmentsJobs.projectId, params.id))
      .limit(1)
    const hasJudgedArticles = existingJob.length > 0

    // Fetch selected model for this project
    const [projectModel] = await db
      .select({
        id: models.id,
        name: models.name,
        provider: models.provider,
        modelName: models.modelName,
        baseURL: models.baseURL,
        version: models.version,
      })
      .from(models)
      .where(eq(models.id, project.modelId))
      .limit(1)

    // Fetch linked import routes for this project via projectRouteLink
    const linkedImportRoutes = await db
      .select({route: importRouteTable.route, name: importRouteTable.name})
      .from(projectRouteLink)
      .innerJoin(importRouteTable, eq(projectRouteLink.importRouteId, importRouteTable.id))
      .where(eq(projectRouteLink.projectId, params.id))

    const importRoutes = linkedImportRoutes.map((r) => {
      return r.route
    })

    const importRouteNamesByRoute = linkedImportRoutes.reduce<Record<string, string | null>>((acc, row) => {
      acc[row.route] = row.name ?? null
      return acc
    }, {})

    return {
      data: {
        project,
        prompts: promptsCombined,
        hasJudgedArticles,
        model: projectModel ?? null,
        importRoutes,
        importRouteNamesByRoute,
      },
    }
  })
  .post(
    '/api/projects',
    async ({body}) => {
      const db = getDatabase()

      const dateFrom = parseOptionalDate(body.dateFrom)
      const dateTo = parseOptionalDate(body.dateTo)
      if (dateFrom && dateTo && dateFrom > dateTo) {
        throw new Error('date_from must be on or before date_to')
      }

      const [validModel] = await db.select({id: models.id}).from(models).where(eq(models.id, body.modelId)).limit(1)

      if (!validModel) {
        throw new Error('Selected model does not exist')
      }

      // Validate mutual exclusivity of useFulltext and useFulltextNoImages
      if (body.useFulltext && body.useFulltextNoImages) {
        throw new Error('Cannot enable both "Use Full Text" and "Use Full Text (No Images)" at the same time')
      }

      // Create project
      const [newProject] = await db
        .insert(projects)
        .values({
          name: body.name,
          description: body.description || null,
          modelId: body.modelId,
          useTitle: body.useTitle ?? true,
          useAbstract: body.useAbstract ?? true,
          useFulltext: body.useFulltext ?? false,
          useFulltextNoImages: body.useFulltextNoImages ?? false,
          dateFrom,
          dateTo,
        })
        .returning()

      // Create prompts associations if provided (global immutable prompts; upsert by hash incl metadata)
      if (newProject && body.prompts && body.prompts.length > 0) {
        const submittedPrompts = (
          body.prompts as Array<string | {content: string; promptHeading?: string; type?: string; order: number}>
        ).filter((p) => {
          return typeof p === 'string' ? p.trim() !== '' : (p.content ?? '').trim() !== ''
        })
        for (let index = 0; index < submittedPrompts.length; index++) {
          const prompt = submittedPrompts[index] as
            | string
            | {content: string; promptHeading?: string; type?: string; order: number}
          const content = typeof prompt === 'string' ? prompt : prompt.content
          const heading = typeof prompt === 'object' ? prompt.promptHeading || null : null
          const typeVal = typeof prompt === 'object' ? prompt.type || null : null
          const orderVal = typeof prompt === 'object' && prompt.order !== undefined ? prompt.order : index

          const contentHash = computePromptContentHash(content, null, heading, typeVal)
          const existingByHash = await db
            .select({id: prompts.id})
            .from(prompts)
            .where(eq(prompts.contentHash, contentHash))
            .limit(1)

          const promptId = await (async () => {
            if (existingByHash[0]?.id) {
              return existingByHash[0].id
            }
            const inserted = await db
              .insert(prompts)
              .values({
                originalText: content,
                transformedText: null,
                promptHeading: heading,
                type: typeVal,
                contentHash,
              })
              .onConflictDoNothing({target: prompts.contentHash})
              .returning({id: prompts.id})
            if (inserted[0]?.id) {
              return inserted[0].id
            }
            const [fallbackPrompt] = await db
              .select({id: prompts.id})
              .from(prompts)
              .where(eq(prompts.contentHash, contentHash))
              .limit(1)
            if (!fallbackPrompt) {
              throw new Error('Prompt not found after insert')
            }
            return fallbackPrompt.id
          })()

          await db
            .insert(projectPrompts)
            .values({
              projectId: newProject.id,
              promptId,
              order: orderVal,
              archived: false,
              enabled: true,
              originProjectId: newProject.id,
            })
            .onConflictDoUpdate({
              target: [projectPrompts.projectId, projectPrompts.promptId],
              set: {
                order: sql`EXCLUDED."order"`,
                archived: sql`EXCLUDED.archived`,
                enabled: sql`EXCLUDED.enabled`,
                updatedAt: new Date(),
              },
            })
        }
      }

      // Link existing prompts to the project (by prompt ID)
      if (newProject && body.existingPromptIds && body.existingPromptIds.length > 0) {
        for (const existing of body.existingPromptIds) {
          const [existingPrompt] = await db
            .select({id: prompts.id})
            .from(prompts)
            .where(eq(prompts.id, existing.originalId))
            .limit(1)

          if (!existingPrompt) {
            throw new Error(`Existing prompt not found: ${existing.originalId}`)
          }

          await db
            .insert(projectPrompts)
            .values({
              projectId: newProject.id,
              promptId: existing.originalId,
              order: existing.order,
              archived: false,
              enabled: true,
              originProjectId: null,
            })
            .onConflictDoUpdate({
              target: [projectPrompts.projectId, projectPrompts.promptId],
              set: {
                order: sql`EXCLUDED."order"`,
                archived: sql`EXCLUDED.archived`,
                enabled: sql`EXCLUDED.enabled`,
                updatedAt: new Date(),
              },
            })
        }
      }

      // Link selected import routes to the project
      if (newProject && body.importRoutes && body.importRoutes.length > 0) {
        const selectedRoutes = Array.from(
          new Set(
            body.importRoutes.filter((r) => {
              return typeof r === 'string' && r.trim() !== ''
            }),
          ),
        )

        if (selectedRoutes.length > 0) {
          const routeRows = await db
            .select({id: importRouteTable.id, route: importRouteTable.route})
            .from(importRouteTable)
            .where(inArray(importRouteTable.route, selectedRoutes))

          if (routeRows.length !== selectedRoutes.length) {
            throw new Error('One or more selected import routes are invalid')
          }

          await db.insert(projectRouteLink).values(
            routeRows.map((r) => {
              return {projectId: newProject.id, importRouteId: r.id}
            }),
          )
        }
      }

      // Linking datasources to projects removed

      return {data: newProject}
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.String()),
        modelId: t.String(),
        dateFrom: t.Optional(t.String()),
        dateTo: t.Optional(t.String()),
        useTitle: t.Optional(t.Boolean()),
        useAbstract: t.Optional(t.Boolean()),
        useFulltext: t.Optional(t.Boolean()),
        useFulltextNoImages: t.Optional(t.Boolean()),
        importRoutes: t.Optional(t.Array(t.String())),
        prompts: t.Optional(
          t.Union([
            t.Array(t.String()),
            t.Array(
              t.Object({
                content: t.String(),
                promptHeading: t.Optional(t.String()),
                type: t.Optional(t.String()),
                order: t.Number(),
              }),
            ),
          ]),
        ),
        existingPromptIds: t.Optional(t.Array(t.Object({originalId: t.String(), order: t.Number()}))),
      }),
    },
  )
  .patch(
    '/api/projects/:id',
    async ({params, body}) => {
      const db = getDatabase()
      // Disallow edits when a judgments job exists for this project
      const [job] = await db
        .select({id: judgmentsJobs.id})
        .from(judgmentsJobs)
        .where(eq(judgmentsJobs.projectId, params.id))
        .limit(1)
      if (job?.id) {
        throw new Error('Project is locked: a judgment job exists for this project')
      }

      const updateData: Partial<typeof projects.$inferInsert> = {updatedAt: new Date()}
      if (body.name !== undefined) updateData.name = body.name
      if (body.description !== undefined) updateData.description = body.description

      const [updatedProject] = await db.update(projects).set(updateData).where(eq(projects.id, params.id)).returning()

      if (!updatedProject) {
        throw new Error('Project not found')
      }

      return {data: updatedProject}
    },
    {body: t.Object({name: t.Optional(t.String()), description: t.Optional(t.Union([t.String(), t.Null()]))})},
  )
  .patch(
    '/api/projects/:id/edit',
    async ({params, body}) => {
      const db = getDatabase()
      // Disallow edits when a judgments job exists for this project
      const [job] = await db
        .select({id: judgmentsJobs.id})
        .from(judgmentsJobs)
        .where(eq(judgmentsJobs.projectId, params.id))
        .limit(1)
      if (job?.id) {
        throw new Error('Project is locked: a judgment job exists for this project')
      }

      const parsedDateFrom = body.dateFrom === undefined ? undefined : parseOptionalDate(body.dateFrom)
      const parsedDateTo = body.dateTo === undefined ? undefined : parseOptionalDate(body.dateTo)
      if (parsedDateFrom && parsedDateTo && parsedDateFrom > parsedDateTo) {
        throw new Error('date_from must be on or before date_to')
      }

      // Start a transaction to ensure data consistency
      const result = await db.transaction(async (tx) => {
        // Update project details
        const updateData: Partial<typeof projects.$inferInsert> = {updatedAt: new Date()}
        if (body.name !== undefined) updateData.name = body.name
        if (body.description !== undefined) updateData.description = body.description
        if (parsedDateFrom !== undefined) updateData.dateFrom = parsedDateFrom
        if (parsedDateTo !== undefined) updateData.dateTo = parsedDateTo
        if (body.modelId !== undefined) {
          const [validModel] = await tx.select({id: models.id}).from(models).where(eq(models.id, body.modelId)).limit(1)
          if (!validModel) {
            throw new Error('Selected model does not exist')
          }
          updateData.modelId = body.modelId
        }
        if (body.useTitle !== undefined) updateData.useTitle = body.useTitle
        if (body.useAbstract !== undefined) updateData.useAbstract = body.useAbstract
        if (body.useFulltext !== undefined) updateData.useFulltext = body.useFulltext
        if (body.useFulltextNoImages !== undefined) updateData.useFulltextNoImages = body.useFulltextNoImages

        // Validate mutual exclusivity (check both incoming values and existing DB values)
        const finalUseFulltext = body.useFulltext ?? updateData.useFulltext
        const finalUseFulltextNoImages = body.useFulltextNoImages ?? updateData.useFulltextNoImages
        if (finalUseFulltext && finalUseFulltextNoImages) {
          throw new Error('Cannot enable both "Use Full Text" and "Use Full Text (No Images)" at the same time')
        }

        const [updatedProject] = await tx.update(projects).set(updateData).where(eq(projects.id, params.id)).returning()

        if (!updatedProject) {
          throw new Error('Project not found')
        }

        // No longer need provider/modelName for prompt hashing

        // Handle prompts updates against associations (immutable prompts)
        if (body.prompts !== undefined) {
          const submitted = body.prompts.filter((p) => {
            return (p.originalText ?? '').trim() !== ''
          })
          // Existing associations (include originProjectId to preserve it for imported prompts)
          const existing = await tx
            .select({
              id: projectPrompts.id,
              promptId: projectPrompts.promptId,
              originProjectId: projectPrompts.originProjectId,
            })
            .from(projectPrompts)
            .where(eq(projectPrompts.projectId, params.id))

          const existingPromptIds = new Set(
            existing.map((p) => {
              return p.promptId
            }),
          )
          const existingOriginMap = new Map(
            existing.map((p) => {
              return [p.promptId, p.originProjectId]
            }),
          )
          const receivedOriginalIds = new Set(
            submitted
              .map((p) => {
                return p.originalId
              })
              .filter((id): id is string => {
                return typeof id === 'string'
              }),
          )

          // Delete associations removed by client
          const toDeleteAssoc = existing.filter((e) => {
            return !receivedOriginalIds.has(e.promptId)
          })
          if (toDeleteAssoc.length > 0) {
            await tx.delete(projectPrompts).where(
              and(
                eq(projectPrompts.projectId, params.id),
                inArray(
                  projectPrompts.promptId,
                  toDeleteAssoc.map((entry) => {
                    return entry.promptId
                  }),
                ),
              ),
            )
          }

          // Upsert associations and prompt rows (works for both existing and importable prompts)
          for (const p of submitted) {
            const orderVal = p.order
            const archivedVal = typeof p.archived === 'boolean' ? p.archived : undefined
            const enabledVal = typeof p.enabled === 'boolean' ? p.enabled : undefined

            // Resolve association
            let targetPromptId: string
            if (p.originalId) {
              const isAlreadyAssociated = existingPromptIds.has(p.originalId)
              // Avoid creating disabled associations for importables that weren't enabled
              if (!isAlreadyAssociated && enabledVal !== true) {
                continue
              }
              // Associate exactly the clicked prompt ID; do not canonicalize by content hash
              const [existingPrompt] = await tx.select().from(prompts).where(eq(prompts.id, p.originalId)).limit(1)
              if (!existingPrompt) {
                throw new Error('Prompt not found')
              }

              // Check if text or metadata changed - if so, create a new prompt
              const textChanged = existingPrompt.originalText !== p.originalText
              const metaChanged =
                (p.promptHeading !== undefined && p.promptHeading !== (existingPrompt.promptHeading ?? null))
                || (p.type !== undefined && p.type !== (existingPrompt.type ?? null))

              if (textChanged || metaChanged) {
                // Create a new prompt with the new text/metadata
                const headingVal = p.promptHeading || null
                const typeVal = p.type || null
                const h4b = computePromptContentHash(p.originalText, null, headingVal, typeVal)
                const found = await tx
                  .select({id: prompts.id})
                  .from(prompts)
                  .where(eq(prompts.contentHash, h4b))
                  .limit(1)
                targetPromptId = await (async () => {
                  if (found[0]?.id) {
                    return found[0].id
                  }
                  const inserted = await tx
                    .insert(prompts)
                    .values({
                      originalText: p.originalText,
                      transformedText: null,
                      promptHeading: headingVal,
                      type: typeVal,
                      contentHash: h4b,
                    })
                    .onConflictDoNothing({target: prompts.contentHash})
                    .returning({id: prompts.id})
                  if (inserted[0]?.id) {
                    return inserted[0].id
                  }
                  const [fallbackPrompt] = await tx
                    .select({id: prompts.id})
                    .from(prompts)
                    .where(eq(prompts.contentHash, h4b))
                    .limit(1)
                  if (!fallbackPrompt) {
                    throw new Error('Prompt not found after insert')
                  }
                  return fallbackPrompt.id
                })()

                // Delete the old association (will be replaced with new prompt association below)
                await tx
                  .delete(projectPrompts)
                  .where(and(eq(projectPrompts.projectId, params.id), eq(projectPrompts.promptId, p.originalId)))
              } else {
                targetPromptId = p.originalId
              }

              // Preserve originProjectId for imported prompts
              // First check if this project already has an association (use its originProjectId)
              // If not, look up the original origin from any other project that has this prompt
              // Only use current project ID for brand new prompts with no prior associations anywhere
              const promptId = p.originalId
              const existingOrigin = existingOriginMap.get(promptId)
              const resolvedOriginProjectId = await (async () => {
                if (existingOrigin !== undefined) {
                  return existingOrigin
                }
                // Look up the original originProjectId from any existing association
                const [anyExisting] = await tx
                  .select({originProjectId: projectPrompts.originProjectId})
                  .from(projectPrompts)
                  .where(eq(projectPrompts.promptId, promptId))
                  .limit(1)
                return anyExisting?.originProjectId ?? params.id
              })()

              const insertValues = {
                projectId: params.id,
                promptId: targetPromptId,
                order: orderVal,
                originProjectId: resolvedOriginProjectId,
                ...(archivedVal !== undefined ? {archived: archivedVal} : {}),
                ...(enabledVal !== undefined ? {enabled: enabledVal} : {}),
              }

              const setValues = {
                order: sql`EXCLUDED."order"`,
                updatedAt: new Date(),
                ...(archivedVal !== undefined ? {archived: sql`EXCLUDED.archived`} : {}),
                ...(enabledVal !== undefined ? {enabled: sql`EXCLUDED.enabled`} : {}),
              }

              await tx
                .insert(projectPrompts)
                .values(insertValues)
                .onConflictDoUpdate({target: [projectPrompts.projectId, projectPrompts.promptId], set: setValues})
            } else {
              const headingVal = p.promptHeading || null
              const typeVal = p.type || null
              const h4b = computePromptContentHash(p.originalText, null, headingVal, typeVal)
              const found = await tx.select({id: prompts.id}).from(prompts).where(eq(prompts.contentHash, h4b)).limit(1)
              targetPromptId = await (async () => {
                if (found[0]?.id) {
                  return found[0].id
                }
                const inserted = await tx
                  .insert(prompts)
                  .values({
                    originalText: p.originalText,
                    transformedText: null,
                    promptHeading: headingVal,
                    type: typeVal,
                    contentHash: h4b,
                  })
                  .onConflictDoNothing({target: prompts.contentHash})
                  .returning({id: prompts.id})
                if (inserted[0]?.id) {
                  return inserted[0].id
                }
                const [fallbackPrompt] = await tx
                  .select({id: prompts.id})
                  .from(prompts)
                  .where(eq(prompts.contentHash, h4b))
                  .limit(1)
                if (!fallbackPrompt) {
                  throw new Error('Prompt not found after insert')
                }
                return fallbackPrompt.id
              })()

              const insertValues = {
                projectId: params.id,
                promptId: targetPromptId,
                order: orderVal,
                originProjectId: params.id,
                ...(archivedVal !== undefined ? {archived: archivedVal} : {}),
                ...(enabledVal !== undefined ? {enabled: enabledVal} : {}),
              }

              const setValues = {
                order: sql`EXCLUDED."order"`,
                updatedAt: new Date(),
                ...(archivedVal !== undefined ? {archived: sql`EXCLUDED.archived`} : {}),
                ...(enabledVal !== undefined ? {enabled: sql`EXCLUDED.enabled`} : {}),
              }

              await tx
                .insert(projectPrompts)
                .values(insertValues)
                .onConflictDoUpdate({target: [projectPrompts.projectId, projectPrompts.promptId], set: setValues})
            }
          }
        }

        // If only the model changed, do not remap existing prompt associations

        // Update import route links if provided
        if (body.importRoutes !== undefined) {
          const selectedRoutes = Array.from(
            new Set(
              body.importRoutes.filter((r) => {
                return typeof r === 'string' && r.trim() !== ''
              }),
            ),
          )

          // Clear existing links then (re)insert selected
          await tx.delete(projectRouteLink).where(eq(projectRouteLink.projectId, params.id))

          if (selectedRoutes.length > 0) {
            const routeRows = await tx
              .select({id: importRouteTable.id, route: importRouteTable.route})
              .from(importRouteTable)
              .where(inArray(importRouteTable.route, selectedRoutes))

            if (routeRows.length !== selectedRoutes.length) {
              throw new Error('One or more selected import routes are invalid')
            }

            await tx.insert(projectRouteLink).values(
              routeRows.map((r) => {
                return {projectId: params.id, importRouteId: r.id}
              }),
            )
          }
        }

        // Fetch updated prompts
        const updatedPrompts = await tx
          .select({
            id: prompts.id,
            originalText: prompts.originalText,
            transformedText: prompts.transformedText,
            promptHeading: prompts.promptHeading,
            order: projectPrompts.order,
            archived: projectPrompts.archived,
            promptArchived: prompts.archived,
            type: prompts.type,
            enabled: projectPrompts.enabled,
            originProjectId: projectPrompts.originProjectId,
          })
          .from(projectPrompts)
          .innerJoin(prompts, eq(projectPrompts.promptId, prompts.id))
          .where(eq(projectPrompts.projectId, params.id))
          .orderBy(projectPrompts.order)

        return {project: updatedProject, prompts: updatedPrompts}
      })

      return {data: result}
    },
    {
      body: t.Object({
        name: t.Optional(t.String()),
        description: t.Optional(t.Union([t.String(), t.Null()])),
        dateFrom: t.Optional(t.Union([t.String(), t.Null()])),
        dateTo: t.Optional(t.Union([t.String(), t.Null()])),
        modelId: t.Optional(t.String()),
        useTitle: t.Optional(t.Boolean()),
        useAbstract: t.Optional(t.Boolean()),
        useFulltext: t.Optional(t.Boolean()),
        useFulltextNoImages: t.Optional(t.Boolean()),
        importRoutes: t.Optional(t.Array(t.String())),
        prompts: t.Optional(
          t.Array(
            t.Object({
              originalId: t.Optional(t.String()),
              originalText: t.String(),
              promptHeading: t.Optional(t.String()),
              type: t.Optional(t.String()),
              order: t.Number(),
              archived: t.Optional(t.Boolean()),
              enabled: t.Optional(t.Boolean()),
            }),
          ),
        ),
      }),
    },
  )
  .delete('/api/projects/:id', async ({params}) => {
    const db = getDatabase()
    // Archive the project instead of deleting it
    const [archivedProject] = await db
      .update(projects)
      .set({archived: true, updatedAt: new Date()})
      .where(eq(projects.id, params.id))
      .returning()

    if (!archivedProject) {
      throw new Error('Project not found')
    }

    return {success: true}
  })
  .post('/api/projects/:id/unarchive', async ({params}) => {
    const db = getDatabase()
    const [unarchivedProject] = await db
      .update(projects)
      .set({archived: false, updatedAt: new Date()})
      .where(eq(projects.id, params.id))
      .returning()

    if (!unarchivedProject) {
      throw new Error('Project not found')
    }

    return {success: true}
  })
  .post('/api/projects/:id/clone', async ({params}) => {
    const db = getDatabase()

    // Fetch source project
    const [sourceProject] = await db.select().from(projects).where(eq(projects.id, params.id)).limit(1)

    if (!sourceProject) {
      throw new Error('Project not found')
    }

    // Clone within a transaction
    const result = await db.transaction(async (tx) => {
      // Create the cloned project with a " - Copy" suffix
      const [clonedProject] = await tx
        .insert(projects)
        .values({
          name: `${sourceProject.name} - Copy`,
          description: sourceProject.description,
          engine: sourceProject.engine,
          modelId: sourceProject.modelId,
          useTitle: sourceProject.useTitle,
          useAbstract: sourceProject.useAbstract,
          useFulltext: sourceProject.useFulltext,
          useFulltextNoImages: sourceProject.useFulltextNoImages,
          dateFrom: sourceProject.dateFrom,
          dateTo: sourceProject.dateTo,
          archived: false,
        })
        .returning()

      if (!clonedProject) {
        throw new Error('Failed to create cloned project')
      }

      // Clone project prompts associations
      const sourcePrompts = await tx.select().from(projectPrompts).where(eq(projectPrompts.projectId, params.id))

      if (sourcePrompts.length > 0) {
        await tx.insert(projectPrompts).values(
          sourcePrompts.map((p) => {
            return {
              projectId: clonedProject.id,
              promptId: p.promptId,
              order: p.order,
              archived: p.archived,
              enabled: p.enabled,
              originProjectId: clonedProject.id,
            }
          }),
        )
      }

      // Clone import route links
      const sourceRouteLinks = await tx.select().from(projectRouteLink).where(eq(projectRouteLink.projectId, params.id))

      if (sourceRouteLinks.length > 0) {
        await tx.insert(projectRouteLink).values(
          sourceRouteLinks.map((link) => {
            return {projectId: clonedProject.id, importRouteId: link.importRouteId}
          }),
        )
      }

      // Clone project articles (curated articles)
      const sourceArticles = await tx.select().from(projectArticles).where(eq(projectArticles.projectId, params.id))

      if (sourceArticles.length > 0) {
        await tx.insert(projectArticles).values(
          sourceArticles.map((article) => {
            return {projectId: clonedProject.id, articleId: article.articleId, importedFromProjectId: params.id}
          }),
        )
      }

      return clonedProject
    })

    return {data: result}
  })
