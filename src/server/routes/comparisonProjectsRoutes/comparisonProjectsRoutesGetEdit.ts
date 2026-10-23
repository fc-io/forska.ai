import {Elysia} from 'elysia'

import {getComparisonProjectEditFormData} from './getComparisonProjectEditFormData.ts'

export const comparisonProjectsRoutesGetEdit = new Elysia().get(
  '/api/comparison-projects/:id/edit',
  async (context) => {
    const {params, set} = context
    const data = await getComparisonProjectEditFormData(params.id)

    if (!data) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

    return {data}
  },
)
