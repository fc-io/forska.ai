import {and, desc, eq, gte, lte, sum} from 'drizzle-orm'
import {Elysia, t} from 'elysia'

import {session} from '../../../auth-schema.ts'
import {tokenUse} from '../../db/schema.ts'
import {requireAdminAuth} from '../utils/authGuard.ts'
import {env} from '../utils/env.ts'
import {getDatabase} from '../utils/getDatabase.ts'
import {tokensRoutesGetTimeline} from './tokensRoutes/tokensRoutesGetTimeline.ts'
import {tokensRoutesGetTimelineAllJobs} from './tokensRoutes/tokensRoutesGetTimelineAllJobs.ts'

export const tokensRoutes = new Elysia()
  .use(requireAdminAuth())
  .post(
    '/api/tokens/usage',
    async ({body}) => {
      try {
        const db = getDatabase()

        // Get userId from sessionId
        const [sessionData] = await db
          .select({userId: session.userId})
          .from(session)
          .where(eq(session.id, body.sessionId))
          .limit(1)

        const [result] = await db
          .insert(tokenUse)
          .values({
            userId: sessionData?.userId ?? null,
            sessionId: body.sessionId,
            // GPU + parallelism metadata
            gpuNnodes: env.GPU_NNODES,
            gpuGpusPerNode: env.GPU_GPUS_PER_NODE,
            gpuTotalGpus: env.GPU_TOTAL_GPUS,
            tpSize: env.TP_SIZE,
            dpSize: env.DP_SIZE,
            gpuShape: env.GPU_SHAPE ?? null,
            sglangMaxRunningRequests: env.SGLANG_MAX_RUNNING_REQUESTS,
            sglangModel: env.SGLANG_MODEL ?? null,
            requests: body.requests,
            totalPromptTokens: body.totalPromptTokens,
            totalCompletionTokens: body.totalCompletionTokens,
            totalTokens: body.totalTokens,
            startedAt: body.startedAt ? new Date(body.startedAt) : undefined,
            finishedAt: body.finishedAt ? new Date(body.finishedAt) : undefined,
            duration: body.duration,
          })
          .returning()

        return {success: true, data: result}
      } catch (error) {
        console.error('Error storing token usage:', error)
        return {success: false, error: error instanceof Error ? error.message : 'Failed to store token usage'}
      }
    },
    {
      body: t.Object({
        sessionId: t.String(),
        requests: t.Number(),
        totalPromptTokens: t.Number(),
        totalCompletionTokens: t.Number(),
        totalTokens: t.Number(),
        startedAt: t.String(),
        finishedAt: t.String(),
        duration: t.Number(),
      }),
    },
  )
  .get('/api/tokens/largest-per-request', async () => {
    try {
      const db = getDatabase()

      const rows = await db
        .select({
          id: tokenUse.id,
          createdAt: tokenUse.createdAt,
          updatedAt: tokenUse.updatedAt,
          judgmentsJobId: tokenUse.judgmentsJobId,
          requests: tokenUse.requests,
          totalPromptTokens: tokenUse.totalPromptTokens,
          totalCompletionTokens: tokenUse.totalCompletionTokens,
          totalTokens: tokenUse.totalTokens,
          duration: tokenUse.duration,
        })
        .from(tokenUse)
        .where(eq(tokenUse.requests, 1))
        .orderBy(desc(tokenUse.totalPromptTokens))
        .limit(5)

      return {data: rows}
    } catch (error) {
      console.error('Error fetching largest-per-request token usage:', error)
      return {data: [], error: 'Failed to fetch largest-per-request token usage'}
    }
  })
  .get('/api/tokens/largest-completion-per-request', async () => {
    try {
      const db = getDatabase()

      const rows = await db
        .select({
          id: tokenUse.id,
          createdAt: tokenUse.createdAt,
          updatedAt: tokenUse.updatedAt,
          judgmentsJobId: tokenUse.judgmentsJobId,
          requests: tokenUse.requests,
          totalPromptTokens: tokenUse.totalPromptTokens,
          totalCompletionTokens: tokenUse.totalCompletionTokens,
          totalTokens: tokenUse.totalTokens,
          duration: tokenUse.duration,
        })
        .from(tokenUse)
        .where(eq(tokenUse.requests, 1))
        .orderBy(desc(tokenUse.totalCompletionTokens))
        .limit(5)

      return {data: rows}
    } catch (error) {
      console.error('Error fetching largest-completion-per-request token usage:', error)
      return {data: [], error: 'Failed to fetch largest-completion-per-request token usage'}
    }
  })
  .get(
    '/api/tokens',
    async ({query}) => {
      try {
        const db = getDatabase()

        // Build where conditions based on query params
        const conditions = []

        if (query.startTime) {
          conditions.push(gte(tokenUse.createdAt, new Date(query.startTime)))
        }

        if (query.endTime) {
          conditions.push(lte(tokenUse.createdAt, new Date(query.endTime)))
        }

        const whereClause = conditions.length > 0 ? and(...conditions) : undefined

        const result = await db
          .select({
            totalPromptTokens: sum(tokenUse.totalPromptTokens),
            totalCompletionTokens: sum(tokenUse.totalCompletionTokens),
            totalTokens: sum(tokenUse.totalTokens),
          })
          .from(tokenUse)
          .where(whereClause)

        const row = result[0]
        return {
          totalPromptTokens: row?.totalPromptTokens ? Number(row.totalPromptTokens) : 0,
          totalCompletionTokens: row?.totalCompletionTokens ? Number(row.totalCompletionTokens) : 0,
          totalTokens: row?.totalTokens ? Number(row.totalTokens) : 0,
        }
      } catch (error) {
        console.error('Error fetching token usage:', error)
        return {totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0, error: 'Failed to fetch token usage'}
      }
    },
    {query: t.Object({startTime: t.Optional(t.String()), endTime: t.Optional(t.String())})},
  )
  .post(
    '/api/tokens/timeline',
    async ({body}) => {
      return await tokensRoutesGetTimeline(body)
    },
    {
      body: t.Object({
        projectId: t.String(),
        interval: t.Union([
          t.Literal('1min'),
          t.Literal('5min'),
          t.Literal('15min'),
          t.Literal('1h'),
          t.Literal('24h'),
          t.Literal('1w'),
          t.Literal('1m'),
        ]),
        startDate: t.String(),
        endDate: t.String(),
      }),
    },
  )
  .post(
    '/api/tokens/timelineAllJobs',
    async ({body}) => {
      return await tokensRoutesGetTimelineAllJobs(body)
    },
    {
      body: t.Object({
        interval: t.Union([
          t.Literal('1min'),
          t.Literal('5min'),
          t.Literal('15min'),
          t.Literal('1h'),
          t.Literal('24h'),
          t.Literal('1w'),
          t.Literal('1m'),
        ]),
        startDate: t.String(),
        endDate: t.String(),
      }),
    },
  )
