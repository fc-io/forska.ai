import {Elysia, t} from 'elysia'

import {getComparisonJudgmentContextsByIds} from '../../services/comparisonJudgmentContext.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'

const comparisonJudgmentContextLookupLimit = 100

export const comparisonProjectsRoutesPostJudgmentContexts = new Elysia().post(
  '/api/comparison-projects/judgment-contexts',
  async (context) => {
    const data = await getComparisonJudgmentContextsByIds(appDatabaseService, context.body.ids)

    return {data}
  },
  {
    body: t.Object({
      ids: t.Array(t.String({pattern: '^[0-9a-f]{64}$'}), {maxItems: comparisonJudgmentContextLookupLimit}),
    }),
  },
)
