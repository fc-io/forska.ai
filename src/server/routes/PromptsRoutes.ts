import {Elysia, t} from 'elysia'

import {withErrorHandler} from '../utils/routeErrorHandler.ts'
import {promptsRoutesDeletePrompt} from './promptsRoutes/promptsRoutesDeletePrompt.ts'
import {promptsRoutesGetDuplicates} from './promptsRoutes/promptsRoutesGetDuplicates.ts'
import {promptsRoutesGetInvalidJudgments} from './promptsRoutes/promptsRoutesGetInvalidJudgments.ts'
import {promptsRoutesGetOrphans} from './promptsRoutes/promptsRoutesGetOrphans.ts'
import {promptsRoutesPatchPrompt} from './promptsRoutes/promptsRoutesPatchPrompt.ts'
import {promptsRoutesPostDeleteInvalidJudgments} from './promptsRoutes/promptsRoutesPostDeleteInvalidJudgments.ts'
import {promptsRoutesPostMerge} from './promptsRoutes/promptsRoutesPostMerge.ts'
import {promptsRoutesPostRegenerateHashes} from './promptsRoutes/promptsRoutesPostRegenerateHashes.ts'
import {promptsReadOnlyRoutes} from './promptsRoutes/promptsRoutesReadOnly.ts'

const promptsUserRoutes = new Elysia().use(withErrorHandler()).patch(
  '/api/prompts/:id',
  async ({params, body, set}) => {
    return promptsRoutesPatchPrompt({params, body, set})
  },
  {body: t.Object({archived: t.Boolean()})},
)

const promptsAdminRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/prompts/duplicates', async () => {
    return promptsRoutesGetDuplicates()
  })
  .post('/api/prompts/regenerate-hashes', async () => {
    return promptsRoutesPostRegenerateHashes()
  })
  .delete('/api/prompts/:id', async ({params, set}) => {
    return promptsRoutesDeletePrompt({params, set})
  })
  .get('/api/prompts/orphans', async () => {
    return promptsRoutesGetOrphans()
  })
  .post(
    '/api/prompts/merge',
    async ({body}) => {
      return promptsRoutesPostMerge({body})
    },
    {body: t.Object({keepPromptId: t.String(), mergePromptIds: t.Array(t.String())})},
  )
  .get('/api/prompts/invalid-judgments', async () => {
    return promptsRoutesGetInvalidJudgments()
  })
  .post(
    '/api/prompts/delete-invalid-judgments',
    async ({body}) => {
      return promptsRoutesPostDeleteInvalidJudgments({body})
    },
    {body: t.Object({judgmentIds: t.Array(t.String())})},
  )

export const promptsRoutes = new Elysia()
  .use(withErrorHandler())
  .use(promptsReadOnlyRoutes)
  .use(promptsUserRoutes)
  .use(promptsAdminRoutes)
