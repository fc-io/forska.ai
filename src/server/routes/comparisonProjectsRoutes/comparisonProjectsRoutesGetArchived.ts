import {Elysia} from 'elysia'

import {getComparisonProjectsList} from './getComparisonProjectsList.ts'

export const comparisonProjectsRoutesGetArchived = new Elysia().get('/api/comparison-projects/archived', async () => {
  const data = await getComparisonProjectsList(true)

  return {data}
})
