import {Elysia, t} from 'elysia'

import {withErrorHandler} from '../utils/routeErrorHandler'
import {llmStatusRoutesGetLlmStatus} from './llmStatusRoutes/llmStatusRoutesGetLlmStatus.ts'

export {__resetLlmStatusCacheForTests} from './llmStatusRoutes/llmStatusRoutesGetLlmStatus.ts'

export const llmStatusRoutes = new Elysia().use(withErrorHandler()).get(
  '/api/llmstatus',
  async ({query}) => {
    return llmStatusRoutesGetLlmStatus({query})
  },
  {query: t.Object({fresh: t.Optional(t.String())})},
)
