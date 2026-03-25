import {Elysia, t} from 'elysia'

import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {humanAssessmentRoutesGetOverview} from './HumanAssessmentRoutes/humanAssessmentRoutesGetOverview.ts'
import {humanAssessmentRoutesGetOverviewBothProjects} from './HumanAssessmentRoutes/humanAssessmentRoutesGetOverviewBothProjects.ts'
import {humanAssessmentRoutesPostInit} from './HumanAssessmentRoutes/humanAssessmentRoutesPostInit.ts'
import {humanAssessmentRoutesPostSubmit} from './HumanAssessmentRoutes/humanAssessmentRoutesPostSubmit.ts'
import {assertProjectIsActive} from './projectsRoutes/projectAccessGuard.ts'

export const humanAssessmentRoutes = new Elysia()
  .use(withErrorHandler())
  .use(
    new Elysia()
      .get('/api/humanassessment/overview', async ({request, set}) => {
        return humanAssessmentRoutesGetOverview({request, set})
      })
      .get('/api/humanassessment/overview-both-projects', async ({request, set}) => {
        return humanAssessmentRoutesGetOverviewBothProjects({request, set})
      }),
  )
  .use(
    new Elysia()
      .post(
        '/api/humanassessment/init',
        async ({body, set}) => {
          await assertProjectIsActive(body.projectId)
          return humanAssessmentRoutesPostInit({body, set})
        },
        {body: t.Object({projectId: t.String()})},
      )
      .post(
        '/api/humanassessment/submit',
        async ({body, set}) => {
          await assertProjectIsActive(body.projectId)
          return humanAssessmentRoutesPostSubmit({body, set})
        },
        {
          body: t.Object({
            projectId: t.String(),
            answers: t.Array(
              t.Object({judgmentHumanId: t.String(), answer: t.String(), comment: t.Optional(t.String())}),
            ),
          }),
        },
      ),
  )
