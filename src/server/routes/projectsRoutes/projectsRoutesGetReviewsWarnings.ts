import {Elysia, t} from 'elysia'

import {getApiReadOnlyAppDatabaseService} from '../../services/appReadOnlyDatabaseService.ts'
import {getCurrentReviewConfigHash} from '../../services/reviewServingProjectConfigIdentity.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'
import {getReviewsWarningsPayload} from './projectsRoutesGetReviewsWarnings/getReviewsWarningsPayload.ts'
import {getReviewWarningsWorkloadContext} from './projectsRoutesGetReviewsWarnings/getReviewWarningsWorkloadContext.ts'
import {
  createReviewsWarningsPayloadMemo,
  getReviewsWarningsPayloadMemoKey,
  type ReviewsWarningsPayloadMemoMode,
} from './reviewsWarningsPayloadMemo.ts'

type ReviewsWarningsPayload = Awaited<ReturnType<typeof getReviewsWarningsPayload>>

const reviewsWarningsPayloadMemoTtlMs = 10_000
const reviewsWarningsPayloadMemo = createReviewsWarningsPayloadMemo<ReviewsWarningsPayload>({
  ttlMs: reviewsWarningsPayloadMemoTtlMs,
})

export const resetReviewsWarningsPayloadMemoForTests = () => {
  reviewsWarningsPayloadMemo.clear()
}

const getReviewsWarningsPayloadMemoMode = (body: {
  fresh?: boolean
  includeDiagnosticDetails?: boolean
}): ReviewsWarningsPayloadMemoMode => {
  if (body.includeDiagnosticDetails === true) {
    return 'bypass'
  }

  return body.fresh === true ? 'refresh' : 'memo'
}

export const projectsRoutesGetReviewsWarnings = new Elysia().post(
  '/api/projectsreviewswarnings',
  async ({body}) => {
    const projectId = body.projectId
    const project = await assertProjectIsActive(projectId, getReviewWarningsWorkloadContext(projectId, 'projectAccess'))
    const reviewConfigHash = await getCurrentReviewConfigHash(projectId, {
      database: getApiReadOnlyAppDatabaseService(),
      workloadContext: getReviewWarningsWorkloadContext(projectId, 'reviewConfigHash'),
    })

    return reviewsWarningsPayloadMemo.read({
      compute: () => {
        return getReviewsWarningsPayload({
          includeDiagnosticDetails: body.includeDiagnosticDetails === true,
          projectId,
          reviewConfigHash,
        })
      },
      key: getReviewsWarningsPayloadMemoKey({projectId, projectUpdatedAt: project.updatedAt ?? null, reviewConfigHash}),
      mode: getReviewsWarningsPayloadMemoMode(body),
    })
  },
  {
    body: t.Object({
      fresh: t.Optional(t.Boolean()),
      includeDiagnosticDetails: t.Optional(t.Boolean()),
      projectId: t.String(),
    }),
  },
)
