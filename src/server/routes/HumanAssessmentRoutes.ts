import {Elysia, t} from 'elysia'

import {requireAdminAuth, requireUserAuth} from '../utils/authGuard.ts'
import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {humanAssessmentRoutesGetOverview} from './HumanAssessmentRoutes/humanAssessmentRoutesGetOverview.ts'
import {humanAssessmentRoutesGetOverviewBothProjects} from './HumanAssessmentRoutes/humanAssessmentRoutesGetOverviewBothProjects.ts'
import {humanAssessmentRoutesGetOverviewBothUsers} from './HumanAssessmentRoutes/humanAssessmentRoutesGetOverviewBothUsers.ts'
import {humanAssessmentRoutesPostInit} from './HumanAssessmentRoutes/humanAssessmentRoutesPostInit.ts'
import {humanAssessmentRoutesPostSubmit} from './HumanAssessmentRoutes/humanAssessmentRoutesPostSubmit.ts'

export const humanAssessmentRoutes = new Elysia()
  .use(withErrorHandler())
  .use(
    new Elysia()
      .use(requireAdminAuth())
      .get('/api/humanassessment/overview', async ({request, set}) => {
        return humanAssessmentRoutesGetOverview({request, set})
      })
      .get('/api/humanassessment/overview-both-projects', async ({request, set}) => {
        return humanAssessmentRoutesGetOverviewBothProjects({request, set})
      })
      .get('/api/humanassessment/overview-both-users', async ({request, set}) => {
        return humanAssessmentRoutesGetOverviewBothUsers({request, set})
      }),
  )
  .use(
    new Elysia()
      .use(requireUserAuth())
      .post(
        '/api/humanassessment/init',
        async ({body, request, set}) => {
          return humanAssessmentRoutesPostInit({body, request, set})
        },
        {body: t.Object({projectId: t.String()})},
      )
      .post(
        '/api/humanassessment/submit',
        async ({body, request, set}) => {
          return humanAssessmentRoutesPostSubmit({body, request, set})
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
