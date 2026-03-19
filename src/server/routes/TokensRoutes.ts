import {Elysia, t} from 'elysia'

import {getDateValue} from '../services/appQueryHelpers.ts'
import {getTokenUseQueryService} from '../services/tokenUseQueryService.ts'
import {env} from '../utils/env.ts'
import {tokensRoutesGetFailedRequestById} from './tokensRoutes/tokensRoutesGetFailedRequestById.ts'
import {tokensRoutesGetFailedRequests} from './tokensRoutes/tokensRoutesGetFailedRequests.ts'
import {tokensRoutesGetTimeline} from './tokensRoutes/tokensRoutesGetTimeline.ts'
import {tokensRoutesGetTimelineAllJobs} from './tokensRoutes/tokensRoutesGetTimelineAllJobs.ts'
import {tokensRoutesGetTimelineAllJobsStats} from './tokensRoutes/tokensRoutesGetTimelineAllJobsStats.ts'
import {tokensRoutesGetTimelineStats} from './tokensRoutes/tokensRoutesGetTimelineStats.ts'

export const tokensRoutes = new Elysia()
  .post(
    '/api/tokens/usage',
    async ({body}) => {
      try {
        const result = await getTokenUseQueryService().insertTokenUse({
          judgment_job_id: body.judgmentsJobId ?? null,
          gpu_nnodes: env.GPU_NNODES,
          gpu_gpus_per_node: env.GPU_GPUS_PER_NODE,
          gpu_total_gpus: env.GPU_TOTAL_GPUS,
          tp_size: env.TP_SIZE,
          dp_size: env.DP_SIZE,
          gpu_shape: env.GPU_SHAPE ?? null,
          sglang_max_running_requests: env.SGLANG_MAX_RUNNING_REQUESTS,
          sglang_model: body.sglangModel ?? null,
          requests: body.requests,
          total_prompt_tokens: body.totalPromptTokens,
          total_completion_tokens: body.totalCompletionTokens,
          total_tokens: body.totalTokens,
          successful_requests: body.successfulRequests ?? null,
          failed_requests: body.failedRequests ?? null,
          has_failed_requests: body.hasFailedRequests ?? false,
          failed_requests_details: body.failedRequestsDetails ?? null,
          total_success_prompt_tokens: body.totalSuccessPromptTokens ?? null,
          total_success_completion_tokens: body.totalSuccessCompletionTokens ?? null,
          total_success_tokens: body.totalSuccessTokens ?? null,
          total_failed_prompt_tokens: body.totalFailedPromptTokens ?? null,
          total_failed_completion_tokens: body.totalFailedCompletionTokens ?? null,
          total_failed_tokens: body.totalFailedTokens ?? null,
          started_at: getDateValue(body.startedAt),
          finished_at: getDateValue(body.finishedAt),
          duration: body.duration,
        })

        return {success: true, data: result}
      } catch (error) {
        console.error('Error storing token usage:', error)
        return {success: false, error: error instanceof Error ? error.message : 'Failed to store token usage'}
      }
    },
    {
      body: t.Object({
        judgmentsJobId: t.Optional(t.String()),
        sglangModel: t.Optional(t.String()),
        requests: t.Number(),
        totalPromptTokens: t.Number(),
        totalCompletionTokens: t.Number(),
        totalTokens: t.Number(),
        startedAt: t.String(),
        finishedAt: t.String(),
        duration: t.Number(),
        successfulRequests: t.Optional(t.Number()),
        failedRequests: t.Optional(t.Number()),
        hasFailedRequests: t.Optional(t.Boolean()),
        failedRequestsDetails: t.Optional(t.Array(t.Any())),
        totalSuccessPromptTokens: t.Optional(t.Number()),
        totalSuccessCompletionTokens: t.Optional(t.Number()),
        totalSuccessTokens: t.Optional(t.Number()),
        totalFailedPromptTokens: t.Optional(t.Number()),
        totalFailedCompletionTokens: t.Optional(t.Number()),
        totalFailedTokens: t.Optional(t.Number()),
      }),
    },
  )
  .get('/api/tokens/largest-per-request', async () => {
    try {
      const rows = await getTokenUseQueryService().getLargestSingleRequestRows('total_prompt_tokens')

      return {data: rows}
    } catch (error) {
      console.error('Error fetching largest-per-request token usage:', error)
      return {data: [], error: 'Failed to fetch largest-per-request token usage'}
    }
  })
  .get('/api/tokens/largest-completion-per-request', async () => {
    try {
      const rows = await getTokenUseQueryService().getLargestSingleRequestRows('total_completion_tokens')

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
        return await getTokenUseQueryService().getTotals({startTime: query.startTime, endTime: query.endTime})
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
  .post(
    '/api/tokens/timelineStats',
    async ({body}) => {
      return await tokensRoutesGetTimelineStats(body)
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
      }),
    },
  )
  .post(
    '/api/tokens/timelineAllJobsStats',
    async ({body}) => {
      return await tokensRoutesGetTimelineAllJobsStats(body)
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
      }),
    },
  )
  .post(
    '/api/tokens/failed-requests',
    async ({body}) => {
      return await tokensRoutesGetFailedRequests(body)
    },
    {body: t.Object({limit: t.Optional(t.Number()), offset: t.Optional(t.Number())})},
  )
  .get(
    '/api/tokens/failed-requests/:id',
    async ({params}) => {
      return await tokensRoutesGetFailedRequestById(params.id)
    },
    {params: t.Object({id: t.String()})},
  )
