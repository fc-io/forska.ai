import {and, eq} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {judgments, models} from '../../db/schema.ts'
import {getDatabase} from '../utils/getDatabase.ts'

export const judgmentsRoutes = new Elysia()
  .get('/api/judgments/model', async ({query}) => {
    try {
      const db = getDatabase()
      const modelName = query.name || 'Qwen3-32B-FP8'
      const provider = query.provider || 'vLLM'
      const baseURL = query.baseURL || 'http://localhost:8000/v1'

      // Check if model exists
      let [model] = await db
        .select()
        .from(models)
        .where(
          and(
            eq(models.name, modelName),
            eq(models.provider, provider),
            eq(models.baseURL, baseURL),
          ),
        )
        .limit(1)

      // Create if doesn't exist
      if (!model) {
        ;[model] = await db
          .insert(models)
          .values({
            name: modelName,
            provider,
            baseURL,
            modelName: './models/Qwen3-32B-FP8',
            version: '1.0.0',
          })
          .returning()
      }

      return {success: true, data: model}
    } catch (error) {
      console.error('Error getting/creating model:', error)
      return {success: false, error: 'Failed to get/create model'}
    }
  })
  .post(
    '/api/judgments/store',
    async ({body}) => {
      console.log('/api/judgments/store')

      try {
        const db = getDatabase()

        // Check if judgment already exists for this combination
        const existingJudgment = await db
          .select()
          .from(judgments)
          .where(
            and(
              eq(judgments.articleId, body.articleId),
              eq(judgments.modelId, body.modelId),
              eq(judgments.promptId, body.promptId),
            ),
          )
          .limit(1)

        if (existingJudgment.length > 0) {
          // Update existing judgment
          const [updatedJudgment] = await db
            .update(judgments)
            .set({
              answeredOriginal: body.answeredOriginal,
              answeredTransformed: body.answeredTransformed || null,
              confidenceOriginal: body.confidenceOriginal || null,
              explanation: body.explanation || null,
              quotes: body.quotes || null,
              updatedAt: new Date(),
            })
            .where(eq(judgments.id, existingJudgment[0].id))
            .returning()

          return {success: true, data: updatedJudgment}
        } else {
          console.log('no existing judgment')
          // Insert new judgment
          const [newJudgment] = await db
            .insert(judgments)
            .values({
              articleId: body.articleId,
              modelId: body.modelId,
              promptId: body.promptId,
              answeredOriginal: body.answeredOriginal,
              answeredTransformed: body.answeredTransformed || null,
              confidenceOriginal: body.confidenceOriginal || null,
              explanation: body.explanation || null,
              quotes: body.quotes || null,
            })
            .returning()

          return {success: true, data: newJudgment}
        }
      } catch (error) {
        console.error('Error storing judgment:', error)
        return {success: false, error: 'Failed to store judgment'}
      }
    },
    {
      body: t.Object({
        articleId: t.String(),
        modelId: t.String(),
        promptId: t.String(),
        answeredOriginal: t.String(),
        answeredTransformed: t.Optional(t.String()),
        confidenceOriginal: t.Optional(t.Number()),
        explanation: t.Optional(t.String()),
        quotes: t.Optional(t.Any()),
      }),
    },
  )
