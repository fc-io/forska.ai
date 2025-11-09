import {and, eq} from 'drizzle-orm'
import {Elysia} from 'elysia'

import {models} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {env} from '../utils/env.ts'

type ModelRow = typeof models.$inferSelect

const normalizeWorkerUrls = (urls: string[] | null | undefined): string[] => {
  return Array.from(
    new Set(
      (urls ?? [])
        .map((url) => {
          return url.trim()
        })
        .filter((url) => {
          return url.length > 0
        }),
    ),
  )
}

const envWorkerUrls = normalizeWorkerUrls(env.WORKER_URLS)

const syncWorkerUrls = async (db: ReturnType<typeof getDatabase>, modelRow: ModelRow | undefined | null) => {
  if (!modelRow) return modelRow
  if (envWorkerUrls.length === 0) return modelRow
  const existing = normalizeWorkerUrls(modelRow.workerUrls)
  const differs =
    existing.length !== envWorkerUrls.length ||
    envWorkerUrls.some((url) => {
      return !existing.includes(url)
    })
  if (!differs) return modelRow
  const [updated] = await db
    .update(models)
    .set({workerUrls: envWorkerUrls})
    .where(eq(models.id, modelRow.id))
    .returning()
  return updated ?? modelRow
}

export const judgmentsRoutes = new Elysia().get('/api/judgments/model', async ({query}) => {
  try {
    const db = getDatabase()
    const modelName = query.name || 'Qwen3-32B-FP8'
    const provider = query.provider || 'vLLM'
    const baseURL = query.baseURL || 'http://localhost:8000/v1'

    // Check if model exists
    const [existingModel] = await db
      .select()
      .from(models)
      .where(and(eq(models.name, modelName), eq(models.provider, provider), eq(models.baseURL, baseURL)))
      .limit(1)

    const persistedModel =
      existingModel ??
      (await db
        .insert(models)
        .values({name: modelName, provider, baseURL, modelName: '/models/Qwen3-32B-FP8', version: '1.0.0'})
        .returning())[0]

    if (!persistedModel) {
      throw new Error('Failed to ensure model record')
    }

    const syncedModel = await syncWorkerUrls(db, persistedModel)

    return {success: true, data: syncedModel}
  } catch (error) {
    console.error('Error getting/creating model:', error)
    return {success: false, error: 'Failed to get/create model'}
  }
})
