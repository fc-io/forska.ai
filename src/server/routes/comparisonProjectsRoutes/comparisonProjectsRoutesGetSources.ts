import {Elysia} from 'elysia'

import {getComparisonProjectSources} from './getComparisonProjectSources.ts'

export const comparisonProjectsRoutesGetSources = new Elysia().get('/api/comparison-projects/sources', async () => {
  const data = await getComparisonProjectSources()

  return {data}
})
