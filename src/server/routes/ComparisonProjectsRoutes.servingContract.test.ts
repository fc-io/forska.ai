import {readFileSync} from 'node:fs'

import {expect, test} from 'bun:test'

const getRouteSource = (routeFile: string) => {
  return readFileSync(new URL(routeFile, import.meta.url), 'utf8').replace(/\r\n?/gu, '\n')
}

const getFunctionBody = (functionName: string, source: string) => {
  const start = source.indexOf(`const ${functionName} =`)
  const nextFunction = source.slice(start + 1).search(/\n(?:export )?const /u)

  if (start === -1) {
    throw new Error(`Missing function ${functionName}`)
  }

  return source.slice(start, nextFunction === -1 ? undefined : start + 1 + nextFunction)
}

const getRouteBody = (routeAnchor: string, source: string) => {
  const start = source.indexOf(routeAnchor)
  const nextRoute = source.indexOf('\n  .', start + 1)

  if (start === -1) {
    throw new Error(`Missing route ${routeAnchor}`)
  }

  return source.slice(start, nextRoute === -1 ? undefined : nextRoute)
}

const expectInOrder = (source: string, before: string, after: string) => {
  const beforeIndex = source.indexOf(before)
  const afterIndex = source.indexOf(after)

  expect(beforeIndex).toBeGreaterThanOrEqual(0)
  expect(afterIndex).toBeGreaterThanOrEqual(0)
  expect(beforeIndex).toBeLessThan(afterIndex)
}

test('comparison product reads are admitted through bounded serving helpers', () => {
  const judgmentPageBody = getFunctionBody(
    'getComparisonProjectJudgmentsPage',
    getRouteSource('./comparisonProjectsRoutes/comparisonProjectsRoutesPostJudgments.ts'),
  )
  const judgmentCountBody = getFunctionBody(
    'getComparisonProjectJudgmentsCount',
    getRouteSource('./comparisonProjectsRoutes/getComparisonProjectJudgmentsCount.ts'),
  )
  const statsBody = getFunctionBody(
    'getComparisonProjectStatsResponse',
    getRouteSource('./comparisonProjectsRoutes/comparisonProjectsRoutesGetStats.ts'),
  )
  const exportBody = getFunctionBody(
    'getComparisonProjectExportResponse',
    getRouteSource(
      './comparisonProjectsRoutes/comparisonProjectsRoutesPostExport/getComparisonProjectExportResponse.ts',
    ),
  )
  const conflictResolutionExportBody = getFunctionBody(
    'getComparisonProjectConflictResolutionExportSourceRows',
    getRouteSource(
      './comparisonProjectsRoutes/comparisonProjectsRoutesPostConflictResolutionsExport/getComparisonProjectConflictResolutionExportSourceRows.ts',
    ),
  )
  const conflictResolutionImportTargetBody = getFunctionBody(
    'getConflictResolutionImportServingCandidateTargetRows',
    getRouteSource(
      './comparisonProjectsRoutes/getConflictResolutionImportTargetArticles/getConflictResolutionImportCandidateTargetRows.ts',
    ),
  )
  const conflictResolutionImportValidationBody = getFunctionBody(
    'validateConflictResolutionImportAnalyzeTarget',
    getRouteSource('./comparisonProjectsRoutes/comparisonProjectConflictResolutionImportRequests.ts'),
  )

  expect(judgmentPageBody).toContain('scope.activeGeneration === null')
  expect(judgmentPageBody).toContain('getComparisonProjectServingJudgmentRowsPage')
  expect(judgmentPageBody).not.toContain('getComparisonProjectScopedArticleBatch')
  expect(judgmentPageBody).not.toContain(' OFFSET ')
  expect(judgmentCountBody).toContain('scope.activeGeneration === null')
  expect(judgmentCountBody).toContain('getComparisonProjectServingJudgmentCount')
  expect(judgmentCountBody).not.toContain('getComparisonProjectScopedArticleBatch')
  expect(judgmentCountBody).not.toContain(' OFFSET ')
  expect(statsBody).toContain('getComparisonProjectStatsWithCategoryBreakdowns')
  expect(statsBody).toContain('generation: scope.activeGeneration')
  expect(statsBody).not.toContain('getComparisonProjectStatsFromCells')
  expect(exportBody).toContain('forEachComparisonProjectServingJudgmentRowBatch')
  expect(exportBody).not.toContain('forEachComparisonProjectJudgmentRowBatch')
  expect(exportBody).not.toContain(' OFFSET ')
  expect(conflictResolutionExportBody).toContain('scope.activeGeneration === null')
  expect(conflictResolutionExportBody).toContain(
    'Conflict resolution export requires an active comparison serving generation',
  )
  expect(conflictResolutionExportBody).toContain('forEachComparisonProjectServingJudgmentArticleIdBatch')
  expect(conflictResolutionExportBody).toContain('getNormalizedComparisonProjectDifferenceFilter')
  expect(conflictResolutionExportBody).toContain('INNER JOIN mart.comparison_article_serving')
  expect(conflictResolutionExportBody).toContain('LEFT JOIN mart.comparison_article_identifier_serving')
  expect(conflictResolutionExportBody).not.toContain('INNER JOIN ${articleTable}')
  expect(conflictResolutionExportBody).not.toContain('LEFT JOIN ${articleIdentifierTable}')
  expect(conflictResolutionImportTargetBody).toContain(
    'getComparisonProjectConflictResolutionImportServingArticleIdTargetArticlesSql',
  )
  expect(conflictResolutionImportTargetBody).toContain(
    'getComparisonProjectConflictResolutionImportServingIdentifierTargetArticlesSql',
  )
  expect(conflictResolutionImportTargetBody).toContain(
    'getComparisonProjectConflictResolutionImportServingIdTitleTargetArticlesSql',
  )
  expect(conflictResolutionImportTargetBody).toContain(
    'getComparisonProjectConflictResolutionImportServingTitleTargetArticlesSql',
  )
  expect(conflictResolutionImportTargetBody).not.toContain('articleTable')
  expect(conflictResolutionImportTargetBody).not.toContain('articleIdentifierTable')
  expect(conflictResolutionImportTargetBody).not.toContain('getArticleScopeConditions')
  expect(conflictResolutionImportValidationBody).toContain('scope.activeGeneration === null')
  expect(conflictResolutionImportValidationBody).toContain(
    'Conflict resolution imports require an active comparison serving generation',
  )
})

test('Covidence export count and CSV read the same bounded serving row batches', () => {
  const covidenceExportFolder = './comparisonProjectsRoutes/comparisonProjectsRoutesPostCovidenceExport'
  const rowBatchBody = getFunctionBody(
    'forEachComparisonProjectCovidenceExportRowBatch',
    getRouteSource(`${covidenceExportFolder}/forEachComparisonProjectCovidenceExportRowBatch.ts`),
  )
  const countBody = getFunctionBody(
    'getComparisonProjectCovidenceExportCount',
    getRouteSource(`${covidenceExportFolder}/getComparisonProjectCovidenceExportCount.ts`),
  )
  const csvBody = getFunctionBody(
    'getComparisonProjectCovidenceExportResponse',
    getRouteSource(`${covidenceExportFolder}/getComparisonProjectCovidenceExportResponse.ts`),
  )

  expect(rowBatchBody).toContain('forEachComparisonProjectServingJudgmentRowBatch')
  expect(rowBatchBody).toContain('getComparisonProjectCovidenceExportSelectedRows')
  expect(rowBatchBody).not.toContain('forEachComparisonProjectJudgmentRowBatch')
  expect(rowBatchBody).not.toContain(' OFFSET ')
  expect(countBody).toContain('forEachComparisonProjectCovidenceExportRowBatch')
  expect(csvBody).toContain('forEachComparisonProjectCovidenceExportRowBatch')
})

test('comparison source writes stay owner routed and queue serving rebuilds', () => {
  const createBody = getRouteBody(
    ".post(\n  '/api/comparison-projects'",
    getRouteSource('./comparisonProjectsRoutes/comparisonProjectsRoutesPostCreate.ts'),
  )
  const createFromProjectBody = getRouteBody(
    ".post(\n  '/api/comparison-projects/from-project'",
    getRouteSource('./comparisonProjectsRoutes/comparisonProjectsRoutesPostFromProject.ts'),
  )
  const patchBody = getRouteBody(
    ".patch(\n  '/api/comparison-projects/:id'",
    getRouteSource('./comparisonProjectsRoutes/comparisonProjectsRoutesPatchUpdate.ts'),
  )
  const purgeHelperBody = getFunctionBody(
    'purgeArchivedComparisonProjectTx',
    getRouteSource('./comparisonProjectsRoutes/comparisonProjectsRoutesDeletePurge.ts'),
  )
  const purgeBody = getRouteBody(
    ".delete(\n  '/api/comparison-projects/:id/purge'",
    getRouteSource('./comparisonProjectsRoutes/comparisonProjectsRoutesDeletePurge.ts'),
  )
  const deleteBody = getRouteBody(
    ".delete(\n  '/api/comparison-projects/:id'",
    getRouteSource('./comparisonProjectsRoutes/comparisonProjectsRoutesDeleteArchive.ts'),
  )
  const unarchiveBody = getRouteBody(
    ".post(\n  '/api/comparison-projects/:id/unarchive'",
    getRouteSource('./comparisonProjectsRoutes/comparisonProjectsRoutesPostUnarchive.ts'),
  )

  expect(createBody).toContain('appDatabaseService.transaction')
  expect(createBody).toContain('createComparisonProjectRecord')
  expectInOrder(
    createBody,
    'checkpointComparisonProjectMutation()',
    'markComparisonProjectServingStaleAndQueueRebuild(createdComparisonProject.id)',
  )
  expect(createFromProjectBody).toContain('appDatabaseService.transaction')
  expect(createFromProjectBody).toContain('createComparisonProjectRecord')
  expectInOrder(
    createFromProjectBody,
    'checkpointComparisonProjectMutation()',
    'markComparisonProjectServingStaleAndQueueRebuild(createdComparisonProject.id)',
  )
  expect(patchBody).toContain('updateComparisonProjectWithRelinkedLinks')
  expectInOrder(
    patchBody,
    'checkpointComparisonProjectMutation()',
    'markComparisonProjectServingStaleAndQueueRebuild(params.id)',
  )
  expect(purgeBody).toContain('appDatabaseService.transaction')
  expect(purgeBody).toContain('purgeArchivedComparisonProjectTx')
  expect(purgeBody).toContain('checkpointComparisonProjectMutation()')
  expect(purgeHelperBody).toContain('cleanupComparisonProjectServing')
  expect(purgeHelperBody).toContain('DELETE FROM ${comparisonProjectTable}')
  expect(deleteBody).toContain('appDatabaseService.transaction')
  expect(deleteBody).toContain('checkpointComparisonProjectMutation()')
  expect(deleteBody).not.toContain('cleanupComparisonProjectServing')
  expect(unarchiveBody).toContain('appDatabaseService.transaction')
  expect(unarchiveBody).toContain('checkpointComparisonProjectMutation()')
})
