import {and, eq} from 'drizzle-orm'
import {Elysia} from 'elysia'

import {models} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'

export const judgmentsRoutes = new Elysia().get('/api/judgments/model', async ({query}) => {
  try {
    const db = getDatabase()
    const modelName = query.name || 'Qwen3-32B-FP8'
    const provider = query.provider || 'vLLM'
    const baseURL = query.baseURL || 'http://localhost:8000/v1'

    // Check if model exists
    let [model] = await db
      .select()
      .from(models)
      .where(and(eq(models.name, modelName), eq(models.provider, provider), eq(models.baseURL, baseURL)))
      .limit(1)

    // Create if doesn't exist
    if (!model) {
      ;[model] = await db
        .insert(models)
        .values({name: modelName, provider, baseURL, modelName: './models/Qwen3-32B-FP8', version: '1.0.0'})
        .returning()
    }

    return {success: true, data: model}
  } catch (error) {
    console.error('Error getting/creating model:', error)
    return {success: false, error: 'Failed to get/create model'}
  }
})
