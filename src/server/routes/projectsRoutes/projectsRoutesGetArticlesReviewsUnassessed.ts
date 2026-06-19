import {Elysia, t} from 'elysia'

import {getUnassessedReviewArticlesFromServing} from '../../reviewServing/reviewServingHumanBothUnassessedRouteService.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'

export const projectsRoutesGetArticlesReviewsUnassessed = new Elysia().post(
  '/api/articlesreviewsunassessed',
  async ({body}) => {
    const page = parseInt(body?.page || '1', 10)
    const limit = parseInt(body?.limit || '100', 10)

    await assertProjectIsActive(body.projectId)

    return getUnassessedReviewArticlesFromServing({
      cursor: body.cursor,
      hasDuplicateStudyRecords: body.hasDuplicateStudyRecords,
      hasStudyDecisionConflict: body.hasStudyDecisionConflict,
      projectId: body.projectId,
      from: body.from,
      to: body.to,
      limit,
      page,
      search: body.search,
    })
  },
  {
    body: t.Object({
      cursor: t.Optional(t.String()),
      limit: t.String(),
      page: t.String(),
      projectId: t.String(),
      hasDuplicateStudyRecords: t.Optional(t.Boolean()),
      hasStudyDecisionConflict: t.Optional(t.Boolean()),
      from: t.Optional(t.String()),
      to: t.Optional(t.String()),
      search: t.Optional(t.String()),
    }),
  },
)
