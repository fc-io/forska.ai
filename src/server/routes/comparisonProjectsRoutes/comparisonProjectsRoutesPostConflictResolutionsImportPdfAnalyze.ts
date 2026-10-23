import {Elysia, t} from 'elysia'

import {
  type ComparisonProjectConflictResolutionPdfImportBody,
  getComparisonProjectConflictResolutionPdfImportRequest,
  validateConflictResolutionImportAnalyzeTarget,
} from './comparisonProjectConflictResolutionImportRequests.ts'
import {appDatabaseService} from './comparisonProjectRouteServices.ts'
import type {ComparisonProjectScope} from './comparisonProjectScopeTypes.ts'
import {getComparisonProjectScope} from './getComparisonProjectScope.ts'
import {getConflictResolutionArtifactImportAnalysis} from './getConflictResolutionArtifactImportAnalysis.ts'
import {getPdfImportAnalyzeResult} from './getPdfImportAnalyzeResult.ts'

const analyzeComparisonProjectConflictResolutionPdfImport = async (
  scope: ComparisonProjectScope,
  body: ComparisonProjectConflictResolutionPdfImportBody,
) => {
  validateConflictResolutionImportAnalyzeTarget(scope)

  const {artifact, importMode, overwriteMode, parsedImport, pdfUndecidedMode, pdfWarnings, reviewer} =
    await getComparisonProjectConflictResolutionPdfImportRequest(scope, body)
  const {analyzeResult} = await getConflictResolutionArtifactImportAnalysis({
    body: {artifact, importMode, overwriteMode},
    scope,
    tx: appDatabaseService,
  })

  return getPdfImportAnalyzeResult({
    analyzeResult,
    importMode,
    parsedImport,
    pdfUndecidedMode,
    pdfWarnings,
    reviewer,
    scope,
    tx: appDatabaseService,
  })
}

export const comparisonProjectsRoutesPostConflictResolutionsImportPdfAnalyze = new Elysia().post(
  '/api/comparison-projects/:id/conflict-resolutions/import/pdf/analyze',
  async (context) => {
    const {params, set} = context
    const scope = await getComparisonProjectScope(params.id)

    if (!scope) {
      set.status = 404
      return {data: null, error: 'Comparison project not found'}
    }

    const data = await analyzeComparisonProjectConflictResolutionPdfImport(scope, context.body)

    return {data}
  },
  {
    body: t.Object({
      file: t.File(),
      importMode: t.Optional(t.String()),
      overwriteMode: t.Optional(t.String()),
      pdfUndecidedMode: t.Optional(t.String()),
    }),
  },
)
