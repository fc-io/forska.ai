import type {Context} from 'elysia'

import {getHumanAssessmentOverviewProjectsFromServing} from './humanAssessmentRoutesGetOverview.ts'

export const humanAssessmentRoutesGetOverviewBothProjects = async ({
  request: _request,
}: {
  request: Request
  set: Context['set']
}) => {
  const bothPerProject = await getHumanAssessmentOverviewProjectsFromServing('review.both.count')

  return {data: bothPerProject}
}
