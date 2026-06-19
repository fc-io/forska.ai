import {Elysia, t} from 'elysia'

import {getHumanReviewArticlesFromServing} from '../../reviewServing/reviewServingHumanBothUnassessedRouteService.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'

export const projectsRoutesGetArticlesReviewsHuman = new Elysia().post(
  '/api/articlesreviewshuman',
  async ({body}) => {
    await assertProjectIsActive(body.projectId)

    return getHumanReviewArticlesFromServing({...body, limit: parseInt(body.limit, 10), page: parseInt(body.page, 10)})
  },
  {
    body: t.Object({
      cursor: t.Optional(t.String()),
      from: t.Optional(t.String()),
      hasDuplicateStudyRecords: t.Optional(t.Boolean()),
      hasStudyDecisionConflict: t.Optional(t.Boolean()),
      limit: t.String(),
      page: t.String(),
      projectId: t.String(),
      prompts: t.Record(t.String(), t.Array(t.String())),
      to: t.Optional(t.String()),
      search: t.Optional(t.String()),
    }),
  },
)
