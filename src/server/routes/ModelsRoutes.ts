import {asc} from 'drizzle-orm'
import {Elysia} from 'elysia'

import {models} from '../../db/schema.ts'
import {env} from '../utils/env.ts'
import {requireAdminAuth, requireUserAuth} from '../utils/authGuard.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

export const modelsRoutes = new Elysia()
  .use(withErrorHandler())
  .use(
    new Elysia().use(requireUserAuth()).get('/api/models', async () => {
      const db = getDatabase()
      const list = await db.select().from(models).orderBy(asc(models.createdAt))
      return {data: list}
    }),
  )
  .use(
    new Elysia().use(requireAdminAuth()).get('/api/models/gpu-info', async () => {
      return {
        data: {
          GPU_NNODES: env.GPU_NNODES,
          GPU_GPUS_PER_NODE: env.GPU_GPUS_PER_NODE,
          GPU_SHAPE: env.GPU_SHAPE,
          GPU_TOTAL_GPUS: env.GPU_TOTAL_GPUS,
          TP_SIZE: env.TP_SIZE,
          DP_SIZE: env.DP_SIZE,
          SGLANG_MAX_RUNNING_REQUESTS: env.SGLANG_MAX_RUNNING_REQUESTS,
          WORKER_URLS: env.WORKER_URLS,
          SGLANG_MODEL: env.SGLANG_MODEL,
        },
      }
    }),
  )
