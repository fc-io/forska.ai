import {Elysia, t} from 'elysia'

import {withErrorHandler} from '../utils/routeErrorHandler'
import {claimJudgmentJobPrompts} from './judgmentsJobsRoutes/claimJudgmentJobPrompts.ts'
import {completeJudgmentJobPrompt} from './judgmentsJobsRoutes/completeJudgmentJobPrompt.ts'
import {fetchJudgmentExecutionSnapshot} from './judgmentsJobsRoutes/fetchJudgmentExecutionSnapshot.ts'
import {judgmentsJobsRoutesDeleteJob} from './judgmentsJobsRoutes/judgmentsJobsRoutesDeleteJob.ts'
import {judgmentsJobsRoutesGetJob} from './judgmentsJobsRoutes/judgmentsJobsRoutesGetJob.ts'
import {judgmentsJobsRoutesGetJobHealth} from './judgmentsJobsRoutes/judgmentsJobsRoutesGetJobHealth.ts'
import {judgmentsJobsRoutesGetJobRuntime} from './judgmentsJobsRoutes/judgmentsJobsRoutesGetJobRuntime.ts'
import {judgmentsJobsRoutesGetJobs} from './judgmentsJobsRoutes/judgmentsJobsRoutesGetJobs.ts'
import {judgmentsJobsRoutesGetJobsHealth} from './judgmentsJobsRoutes/judgmentsJobsRoutesGetJobsHealth.ts'
import {judgmentsJobsRoutesGetProviderTelemetryHistory} from './judgmentsJobsRoutes/judgmentsJobsRoutesGetProviderTelemetryHistory.ts'
import {judgmentsJobsRoutesGetRunning} from './judgmentsJobsRoutes/judgmentsJobsRoutesGetRunning.ts'
import {judgmentsJobsRoutesGetStopConditionDefaults} from './judgmentsJobsRoutes/judgmentsJobsRoutesGetStopConditionDefaults.ts'
import {judgmentsJobsRoutesGetTotalTokenUsage} from './judgmentsJobsRoutes/judgmentsJobsRoutesGetTotalTokenUsage.ts'
import {judgmentsJobsRoutesGetUnassessedArticles} from './judgmentsJobsRoutes/judgmentsJobsRoutesGetUnassessedArticles.ts'
import {judgmentsJobsRoutesGetUnassessedCount} from './judgmentsJobsRoutes/judgmentsJobsRoutesGetUnassessedCount.ts'
import {judgmentsJobsRoutesPatchJob} from './judgmentsJobsRoutes/judgmentsJobsRoutesPatchJob.ts'
import {judgmentsJobsRoutesPostCheckpoint} from './judgmentsJobsRoutes/judgmentsJobsRoutesPostCheckpoint.ts'
import {judgmentsJobsRoutesPostDrain} from './judgmentsJobsRoutes/judgmentsJobsRoutesPostDrain.ts'
import {judgmentsJobsRoutesPostJob} from './judgmentsJobsRoutes/judgmentsJobsRoutesPostJob.ts'
import {judgmentsJobsRoutesPostPreflight} from './judgmentsJobsRoutes/judgmentsJobsRoutesPostPreflight.ts'
import {judgmentsJobsRoutesPostQuarantine} from './judgmentsJobsRoutes/judgmentsJobsRoutesPostQuarantine.ts'
import {judgmentsJobsRoutesPostRepair} from './judgmentsJobsRoutes/judgmentsJobsRoutesPostRepair.ts'
import {judgmentsJobsRoutesPostRepairOrphanedQueue} from './judgmentsJobsRoutes/judgmentsJobsRoutesPostRepairOrphanedQueue.ts'
import {judgmentsJobsRoutesPostStartClean} from './judgmentsJobsRoutes/judgmentsJobsRoutesPostStartClean.ts'
import {judgmentsJobsRoutesPostUnquarantine} from './judgmentsJobsRoutes/judgmentsJobsRoutesPostUnquarantine.ts'
import {
  judgmentClaimRequestSchema,
  judgmentCompletionBodySchema,
  judgmentJobStopConditionValueSchema,
  judgmentProviderTelemetryHistoryQuerySchema,
  judgmentSnapshotQuerySchema,
  judgmentWorkerHeartbeatBodySchema,
  systemSqliteFallbackStepsSchema,
} from './judgmentsJobsRoutes/judgmentsJobsRoutesSchemas.ts'
import {recordJudgmentJobWorkerHeartbeat} from './judgmentsJobsRoutes/recordJudgmentJobWorkerHeartbeat.ts'

export const judgmentsJobsRoutes = new Elysia()
  .use(withErrorHandler())
  .post(
    '/api/judgmentsjobs',
    async ({body}) => {
      return judgmentsJobsRoutesPostJob({body})
    },
    {body: t.Object({projectId: t.String(), agentConfig: t.Optional(t.Any())})},
  )
  .get(
    '/api/judgmentsjobs/:id/health',
    async ({params, request}) => {
      return judgmentsJobsRoutesGetJobHealth({params, request})
    },
    {params: t.Object({id: t.String()})},
  )
  .post(
    '/api/judgmentsjobs/:id/claims',
    async ({params, body}) => {
      return claimJudgmentJobPrompts(params.id, body)
    },
    {body: judgmentClaimRequestSchema, params: t.Object({id: t.String()})},
  )
  .post(
    '/api/judgmentsjobs/:id/claim',
    async ({params, body}) => {
      return claimJudgmentJobPrompts(params.id, body)
    },
    {body: judgmentClaimRequestSchema, params: t.Object({id: t.String()})},
  )
  .post(
    '/api/judgmentsjobs/:id/completions',
    async ({params, body}) => {
      return completeJudgmentJobPrompt(params.id, body)
    },
    {body: judgmentCompletionBodySchema, params: t.Object({id: t.String()})},
  )
  .post(
    '/api/judgmentsjobs/:id/complete',
    async ({params, body}) => {
      return completeJudgmentJobPrompt(params.id, body)
    },
    {body: judgmentCompletionBodySchema, params: t.Object({id: t.String()})},
  )
  .get('/api/judgmentsjobs-running', async ({request}) => {
    return judgmentsJobsRoutesGetRunning({request})
  })
  .get(
    '/api/judgmentsjobs-provider-telemetry-history',
    async ({query, request}) => {
      return judgmentsJobsRoutesGetProviderTelemetryHistory({query, request})
    },
    {query: judgmentProviderTelemetryHistoryQuerySchema},
  )
  .post(
    '/api/judgmentsjobs-worker-heartbeats',
    async ({body}) => {
      return recordJudgmentJobWorkerHeartbeat(body)
    },
    {body: judgmentWorkerHeartbeatBodySchema},
  )
  .get(
    '/api/judgmentsjobs/:id/runtime',
    async ({params, request}) => {
      return judgmentsJobsRoutesGetJobRuntime({params, request})
    },
    {params: t.Object({id: t.String()})},
  )
  .get(
    '/api/judgmentsjobs/execution-snapshots/:executionSnapshotId',
    async ({params, query}) => {
      return fetchJudgmentExecutionSnapshot(params.executionSnapshotId, query)
    },
    {params: t.Object({executionSnapshotId: t.String()}), query: judgmentSnapshotQuerySchema},
  )
  .get(
    '/api/judgmentsjobs-execution-snapshots/:executionSnapshotId',
    async ({params, query}) => {
      return fetchJudgmentExecutionSnapshot(params.executionSnapshotId, query)
    },
    {params: t.Object({executionSnapshotId: t.String()}), query: judgmentSnapshotQuerySchema},
  )
  .get(
    '/api/judgmentsjobs/:id/stop-condition-defaults',
    async ({params, request}) => {
      return judgmentsJobsRoutesGetStopConditionDefaults({params, request})
    },
    {params: t.Object({id: t.String()})},
  )
  .get(
    '/api/judgmentsjobs/:id',
    async ({params, request}) => {
      return judgmentsJobsRoutesGetJob({params, request})
    },
    {params: t.Object({id: t.String()})},
  )
  .get(
    '/api/judgmentsjobs-unassessed-count',
    async ({query}) => {
      return judgmentsJobsRoutesGetUnassessedCount({query})
    },
    {query: t.Object({jobId: t.String()})},
  )
  .get(
    '/api/judgmentsjobs-unassessed-articles',
    async ({query}) => {
      return judgmentsJobsRoutesGetUnassessedArticles({query})
    },
    {query: t.Object({jobId: t.String()})},
  )
  .get('/api/judgmentsjobs', async ({request}) => {
    return judgmentsJobsRoutesGetJobs({request})
  })
  .get('/api/judgmentsjobs-health', async ({request}) => {
    return judgmentsJobsRoutesGetJobsHealth({request})
  })
  .get('/api/judgmentsjobs-total-token-usage', async () => {
    return judgmentsJobsRoutesGetTotalTokenUsage()
  })
  .patch(
    '/api/judgmentsjobs/:id',
    async ({params, body}) => {
      return judgmentsJobsRoutesPatchJob({params, body})
    },
    {
      params: t.Object({id: t.String()}),
      body: t.Object({
        status: t.Optional(
          t.Union([
            t.Literal('not_started'),
            t.Literal('waiting_on_llm_connection'),
            t.Literal('waiting_on_db_connection'),
            t.Literal('running'),
            t.Literal('paused'),
            t.Literal('failed'),
            t.Literal('completed'),
            t.Literal('project_removed'),
          ]),
        ),
        error: t.Optional(t.Array(t.String())),
        stopAfterArticles: t.Optional(judgmentJobStopConditionValueSchema),
        stopAfterTotalTokens: t.Optional(judgmentJobStopConditionValueSchema),
        stopAt: t.Optional(judgmentJobStopConditionValueSchema),
        stopWhenHumanAnsweredDone: t.Optional(judgmentJobStopConditionValueSchema),
      }),
    },
  )
  .post(
    '/api/judgmentsjobs/:id/start-clean',
    async ({params}) => {
      return judgmentsJobsRoutesPostStartClean({params})
    },
    {params: t.Object({id: t.String()})},
  )
  .post(
    '/api/judgmentsjobs/:id/preflight',
    async ({params}) => {
      return judgmentsJobsRoutesPostPreflight({params})
    },
    {params: t.Object({id: t.String()})},
  )
  .post(
    '/api/judgmentsjobs/:id/drain',
    async ({params, body}) => {
      return judgmentsJobsRoutesPostDrain({params, body})
    },
    {
      params: t.Object({id: t.String()}),
      body: t.Optional(
        t.Object({
          claimedBy: t.Optional(t.String()),
          systemSqliteFallbackSteps: t.Optional(systemSqliteFallbackStepsSchema),
        }),
      ),
    },
  )
  .post(
    '/api/judgmentsjobs/:id/checkpoint',
    async ({params, body}) => {
      return judgmentsJobsRoutesPostCheckpoint({params, body})
    },
    {
      params: t.Object({id: t.String()}),
      body: t.Optional(
        t.Object({
          claimedBy: t.Optional(t.String()),
          systemSqliteFallbackSteps: t.Optional(systemSqliteFallbackStepsSchema),
        }),
      ),
    },
  )
  .post(
    '/api/judgmentsjobs/:id/quarantine',
    async ({params, body}) => {
      return judgmentsJobsRoutesPostQuarantine({params, body})
    },
    {params: t.Object({id: t.String()}), body: t.Optional(t.Object({reason: t.Optional(t.String())}))},
  )
  .post(
    '/api/judgmentsjobs/:id/unquarantine',
    async ({params}) => {
      return judgmentsJobsRoutesPostUnquarantine({params})
    },
    {params: t.Object({id: t.String()})},
  )
  .post(
    '/api/judgmentsjobs/:id/repair',
    async ({params, body}) => {
      return judgmentsJobsRoutesPostRepair({params, body})
    },
    {
      params: t.Object({id: t.String()}),
      body: t.Optional(
        t.Object({
          claimedBy: t.Optional(t.String()),
          systemSqliteFallbackSteps: t.Optional(systemSqliteFallbackStepsSchema),
        }),
      ),
    },
  )
  .post(
    '/api/judgmentsjobs/:id/repair-orphaned-queue',
    async ({params, body}) => {
      return judgmentsJobsRoutesPostRepairOrphanedQueue({params, body})
    },
    {
      params: t.Object({id: t.String()}),
      body: t.Optional(
        t.Object({
          claimedBy: t.Optional(t.String()),
          systemSqliteFallbackSteps: t.Optional(systemSqliteFallbackStepsSchema),
        }),
      ),
    },
  )
  .delete(
    '/api/judgmentsjobs/:id',
    async ({params}) => {
      return judgmentsJobsRoutesDeleteJob({params})
    },
    {params: t.Object({id: t.String()})},
  )
