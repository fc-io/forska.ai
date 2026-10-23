import {Elysia, t} from 'elysia'

import {withErrorHandler} from '../utils/routeErrorHandler'
import {judgmentWorkflowTopologyTestRoutesPostClaims} from './judgmentWorkflowTopologyTestRoutes/judgmentWorkflowTopologyTestRoutesPostClaims.ts'
import {judgmentWorkflowTopologyTestRoutesPostCleanupStale} from './judgmentWorkflowTopologyTestRoutes/judgmentWorkflowTopologyTestRoutesPostCleanupStale.ts'
import {judgmentWorkflowTopologyTestRoutesPostDrainReviewServingProjection} from './judgmentWorkflowTopologyTestRoutes/judgmentWorkflowTopologyTestRoutesPostDrainReviewServingProjection.ts'
import {judgmentWorkflowTopologyTestRoutesPostEvidence} from './judgmentWorkflowTopologyTestRoutes/judgmentWorkflowTopologyTestRoutesPostEvidence.ts'
import {judgmentWorkflowTopologyTestRoutesPostRealCodexEvidence} from './judgmentWorkflowTopologyTestRoutes/judgmentWorkflowTopologyTestRoutesPostRealCodexEvidence.ts'
import {judgmentWorkflowTopologyTestRoutesPostReconcileProjectRefreshAcks} from './judgmentWorkflowTopologyTestRoutes/judgmentWorkflowTopologyTestRoutesPostReconcileProjectRefreshAcks.ts'
import {judgmentWorkflowTopologyTestRoutesPostSeed} from './judgmentWorkflowTopologyTestRoutes/judgmentWorkflowTopologyTestRoutesPostSeed.ts'

export const judgmentWorkflowTopologyTestRoutes = new Elysia()
  .use(withErrorHandler())
  .post(
    '/api/test/judgment-workflow-topology/cleanup-stale',
    async ({body}) => {
      return judgmentWorkflowTopologyTestRoutesPostCleanupStale({body})
    },
    {body: t.Object({jobIds: t.Optional(t.Array(t.String())), token: t.String()})},
  )
  .post(
    '/api/test/judgment-workflow-topology/claims',
    async ({body}) => {
      return judgmentWorkflowTopologyTestRoutesPostClaims({body})
    },
    {body: t.Object({jobId: t.String(), token: t.String()})},
  )
  .post(
    '/api/test/judgment-workflow-topology/seed',
    async ({body}) => {
      return judgmentWorkflowTopologyTestRoutesPostSeed({body})
    },
    {
      body: t.Object({
        createPausedJob: t.Optional(t.Boolean()),
        fixtureId: t.String({pattern: '^[A-Za-z0-9_-]+$'}),
        providerBaseUrl: t.String(),
        singlePromptProjectA: t.Optional(t.Boolean()),
        token: t.String(),
      }),
    },
  )
  .post(
    '/api/test/judgment-workflow-topology/reconcile-project-refresh-acks',
    async ({body}) => {
      return judgmentWorkflowTopologyTestRoutesPostReconcileProjectRefreshAcks({body})
    },
    {body: t.Object({fixtureId: t.String({pattern: '^[A-Za-z0-9_-]+$'}), token: t.String()})},
  )
  .post(
    '/api/test/judgment-workflow-topology/drain-review-serving-projection',
    async ({body}) => {
      return judgmentWorkflowTopologyTestRoutesPostDrainReviewServingProjection({body})
    },
    {
      body: t.Object({
        fixtureId: t.String({pattern: '^[A-Za-z0-9_-]+$'}),
        maxCycles: t.Optional(t.Number()),
        token: t.String(),
      }),
    },
  )
  .post(
    '/api/test/judgment-workflow-topology/evidence',
    async ({body}) => {
      return judgmentWorkflowTopologyTestRoutesPostEvidence({body})
    },
    {
      body: t.Object({
        fixtureId: t.String({pattern: '^[A-Za-z0-9_-]+$'}),
        jobIds: t.Optional(t.Array(t.String())),
        token: t.String(),
      }),
    },
  )
  .post(
    '/api/test/judgment-workflow-real-codex/evidence',
    async ({body}) => {
      return judgmentWorkflowTopologyTestRoutesPostRealCodexEvidence({body})
    },
    {body: t.Object({modelId: t.String(), projectId: t.String(), promptId: t.String(), token: t.String()})},
  )
