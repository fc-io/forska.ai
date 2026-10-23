import {Elysia} from 'elysia'

import {getComparisonProjectsList} from './getComparisonProjectsList.ts'

export const comparisonProjectsRoutesGetList = new Elysia().get('/api/comparison-projects', async () => {
  const data = await getComparisonProjectsList(false)

  return {data}
})
