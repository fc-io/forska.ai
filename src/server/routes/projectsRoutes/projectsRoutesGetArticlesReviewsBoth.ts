import {Elysia, t} from 'elysia'

import {getBothReviewArticlesFromServing} from '../../reviewServing/reviewServingHumanBothUnassessedRouteService.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'

export const projectsRoutesGetArticlesReviewsBoth = new Elysia().post(
  '/api/articlesreviewsboth',
  async ({body}) => {
    const page = parseInt(body?.page || '1', 10)
    const limit = parseInt(body?.limit || '100', 10)

    await assertProjectIsActive(body.projectId)

    return getBothReviewArticlesFromServing({
      cursor: body.cursor,
      hasDuplicateStudyRecords: body.hasDuplicateStudyRecords,
      hasStudyDecisionConflict: body.hasStudyDecisionConflict,
      projectId: body.projectId,
      page,
      limit,
      from: body.from,
      to: body.to,
      search: body.search,
      prompts: body.prompts,
    })
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
