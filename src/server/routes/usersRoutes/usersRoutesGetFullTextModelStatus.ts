import {Elysia, t} from 'elysia'

import {getFullTextModelStatus} from '../../services/fullTextModelStatus.ts'

export const usersRoutesGetFullTextModelStatus = new Elysia().get(
  '/api/users/full-text-model-status',
  async ({query}) => {
    return {data: await getFullTextModelStatus({modelId: query.modelId, role: query.role})}
  },
  {query: t.Object({modelId: t.String({minLength: 1}), role: t.Literal('pdf_conversion')})},
)
