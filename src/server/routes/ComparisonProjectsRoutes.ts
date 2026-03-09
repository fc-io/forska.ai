import {asc, desc, eq, inArray, sql} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {
  comparisonProject,
  comparisonProjectPrompt,
  comparisonProjectRouteLink,
  importRoute as importRouteTable,
  models,
  prompts,
} from '../../db/schema.ts'
import {requireUserAuth} from '../utils/authGuard.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'

type PromptSelection = {promptId: string; order: number}
type Database = ReturnType<typeof getDatabase>
type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type DatabaseClient = Database | DatabaseTransaction

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

const getUniqueStringValues = (values: string[]) => {
  return Array.from(
    new Set(
      values.filter((value) => {
        return value.trim() !== ''
      }),
    ),
  )
}

const getUniquePromptSelections = (promptSelections: PromptSelection[]) => {
  const uniqueSelections = promptSelections.reduce<Map<string, PromptSelection>>((selectionMap, selection) => {
    if (!selectionMap.has(selection.promptId)) {
      selectionMap.set(selection.promptId, selection)
    }

    return selectionMap
  }, new Map<string, PromptSelection>())

  return Array.from(uniqueSelections.values()).sort((left, right) => {
    return left.order - right.order
  })
}

const getComparisonProjectPromptCounts = (db: Database) => {
  return db
    .select({
      comparisonProjectId: comparisonProjectPrompt.comparisonProjectId,
      promptCount: sql<number>`count(*)::int`.as('prompt_count'),
    })
    .from(comparisonProjectPrompt)
    .groupBy(comparisonProjectPrompt.comparisonProjectId)
    .as('comparison_project_prompt_counts')
}

const getComparisonProjectRouteCounts = (db: Database) => {
  return db
    .select({
      comparisonProjectId: comparisonProjectRouteLink.comparisonProjectId,
      routeCount: sql<number>`count(*)::int`.as('route_count'),
    })
    .from(comparisonProjectRouteLink)
    .groupBy(comparisonProjectRouteLink.comparisonProjectId)
    .as('comparison_project_route_counts')
}

const getComparisonProjectsList = async (archived: boolean) => {
  const db = getDatabase()
  const promptCounts = getComparisonProjectPromptCounts(db)
  const routeCounts = getComparisonProjectRouteCounts(db)
  const orderByClause = archived ? desc(comparisonProject.createdAt) : asc(comparisonProject.name)

  return db
    .select({
      id: comparisonProject.id,
      name: comparisonProject.name,
      description: comparisonProject.description,
      compareWithHumans: comparisonProject.compareWithHumans,
      useTitle: comparisonProject.useTitle,
      useAbstract: comparisonProject.useAbstract,
      useFulltext: comparisonProject.useFulltext,
      useFulltextNoImages: comparisonProject.useFulltextNoImages,
      dateFrom: comparisonProject.dateFrom,
      dateTo: comparisonProject.dateTo,
      archived: comparisonProject.archived,
      createdAt: comparisonProject.createdAt,
      promptCount: sql<number>`COALESCE(${promptCounts.promptCount}, 0)`,
      routeCount: sql<number>`COALESCE(${routeCounts.routeCount}, 0)`,
    })
    .from(comparisonProject)
    .leftJoin(promptCounts, eq(promptCounts.comparisonProjectId, comparisonProject.id))
    .leftJoin(routeCounts, eq(routeCounts.comparisonProjectId, comparisonProject.id))
    .where(eq(comparisonProject.archived, archived))
    .orderBy(orderByClause)
}

const insertComparisonProjectPromptLinks = async (
  tx: DatabaseClient,
  comparisonProjectId: string,
  promptSelections: PromptSelection[],
) => {
  const promptIds = promptSelections.map((selection) => {
    return selection.promptId
  })

  if (promptIds.length === 0) {
    return
  }

  const promptRows = await tx.select({id: prompts.id}).from(prompts).where(inArray(prompts.id, promptIds))

  if (promptRows.length !== promptIds.length) {
    throw new Error('One or more selected prompts are invalid')
  }

  await tx.insert(comparisonProjectPrompt).values(
    promptSelections.map((selection) => {
      return {comparisonProjectId, promptId: selection.promptId, order: selection.order}
    }),
  )
}

const insertComparisonProjectRouteLinks = async (
  tx: DatabaseClient,
  comparisonProjectId: string,
  importRoutes: string[],
) => {
  if (importRoutes.length === 0) {
    return
  }

  const routeRows = await tx
    .select({id: importRouteTable.id, route: importRouteTable.route})
    .from(importRouteTable)
    .where(inArray(importRouteTable.route, importRoutes))

  if (routeRows.length !== importRoutes.length) {
    throw new Error('One or more selected import routes are invalid')
  }

  await tx.insert(comparisonProjectRouteLink).values(
    routeRows.map((routeRow) => {
      return {comparisonProjectId, importRouteId: routeRow.id}
    }),
  )
}

const getValidatedModelIds = async (tx: DatabaseClient, modelIds: string[]) => {
  if (modelIds.length === 0) {
    return null
  }

  const modelRows = await tx.select({id: models.id}).from(models).where(inArray(models.id, modelIds))

  if (modelRows.length !== modelIds.length) {
    throw new Error('One or more selected models are invalid')
  }

  return modelIds
}

export const comparisonProjectsRoutes = new Elysia()
  .use(withErrorHandler())
  .use(requireUserAuth())
  .get('/api/comparison-projects', async () => {
    const data = await getComparisonProjectsList(false)

    return {data}
  })
  .get('/api/comparison-projects/archived', async () => {
    const data = await getComparisonProjectsList(true)

    return {data}
  })
  .post(
    '/api/comparison-projects',
    async ({body}) => {
      const db = getDatabase()
      const dateFrom = parseOptionalDate(body.dateFrom)
      const dateTo = parseOptionalDate(body.dateTo)

      if (dateFrom && dateTo && dateFrom > dateTo) {
        throw new Error('date_from must be on or before date_to')
      }

      if (body.useFulltext && body.useFulltextNoImages) {
        throw new Error('Cannot enable both "Use Full Text" and "Use Full Text (No Images)" at the same time')
      }

      const uniqueModelIds = getUniqueStringValues(body.modelIds ?? [])
      const uniquePromptSelections = getUniquePromptSelections(body.promptSelections ?? [])
      const uniqueImportRoutes = getUniqueStringValues(body.importRoutes ?? [])

      const createdComparisonProject = await db.transaction(async (tx) => {
        const validatedModelIds = await getValidatedModelIds(tx, uniqueModelIds)
        const [newComparisonProject] = await tx
          .insert(comparisonProject)
          .values({
            name: body.name,
            description: body.description?.trim() || null,
            ownerId: body.ownerId,
            modelIds: validatedModelIds,
            compareWithHumans: body.compareWithHumans ?? false,
            useTitle: body.useTitle ?? true,
            useAbstract: body.useAbstract ?? true,
            useFulltext: body.useFulltext ?? false,
            useFulltextNoImages: body.useFulltextNoImages ?? false,
            dateFrom,
            dateTo,
          })
          .returning()

        if (!newComparisonProject) {
          throw new Error('Failed to create comparison project')
        }

        await insertComparisonProjectPromptLinks(tx, newComparisonProject.id, uniquePromptSelections)
        await insertComparisonProjectRouteLinks(tx, newComparisonProject.id, uniqueImportRoutes)

        return newComparisonProject
      })

      return {data: createdComparisonProject}
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.Union([t.String(), t.Null()])),
        ownerId: t.String(),
        modelIds: t.Optional(t.Array(t.String())),
        compareWithHumans: t.Optional(t.Boolean()),
        dateFrom: t.Optional(t.Union([t.String(), t.Null()])),
        dateTo: t.Optional(t.Union([t.String(), t.Null()])),
        useTitle: t.Optional(t.Boolean()),
        useAbstract: t.Optional(t.Boolean()),
        useFulltext: t.Optional(t.Boolean()),
        useFulltextNoImages: t.Optional(t.Boolean()),
        importRoutes: t.Optional(t.Array(t.String())),
        promptSelections: t.Optional(t.Array(t.Object({promptId: t.String(), order: t.Number()}))),
      }),
    },
  )
  .delete('/api/comparison-projects/:id', async ({params}) => {
    const db = getDatabase()
    const [archivedComparisonProject] = await db
      .update(comparisonProject)
      .set({archived: true, updatedAt: new Date()})
      .where(eq(comparisonProject.id, params.id))
      .returning()

    if (!archivedComparisonProject) {
      throw new Error('Comparison project not found')
    }

    return {success: true}
  })
  .post('/api/comparison-projects/:id/unarchive', async ({params}) => {
    const db = getDatabase()
    const [unarchivedComparisonProject] = await db
      .update(comparisonProject)
      .set({archived: false, updatedAt: new Date()})
      .where(eq(comparisonProject.id, params.id))
      .returning()

    if (!unarchivedComparisonProject) {
      throw new Error('Comparison project not found')
    }

    return {success: true}
  })
