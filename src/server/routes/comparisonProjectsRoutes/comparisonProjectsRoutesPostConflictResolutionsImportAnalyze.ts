import {Elysia, t} from 'elysia'

import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getComparisonProjectScope} from './getComparisonProjectScope.ts'
import {getConflictResolutionArtifactImportAnalysis} from './getConflictResolutionArtifactImportAnalysis.ts'

const analyzeComparisonProjectConflictResolutionImport = async (scope: ComparisonProjectScope, body: unknown) => {
  const {analyzeResult} = await getConflictResolutionArtifactImportAnalysis({body, scope, tx: appDatabaseService})

  return analyzeResult
}

export const comparisonProjectsRoutesPostConflictResolutionsImportAnalyze = new Elysia().post(
  '/api/comparison-projects/:id/conflict-resolutions/import/analyze',
  async (context) => {
    const {params, set} = context
    const scope = await getComparisonProjectScope(params.id)

    if (!scope) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

    const data = await analyzeComparisonProjectConflictResolutionImport(scope, context.body)

    return {data}
  },
  {body: t.Any()},
)
