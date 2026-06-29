import {readFileSync} from 'node:fs'

import {expect, test} from 'bun:test'

const routeSource = readFileSync(new URL('./ComparisonProjectsRoutes.ts', import.meta.url), 'utf8')

const getFunctionBody = (functionName: string) => {
  const start = routeSource.indexOf(`const ${functionName} =`)
  const nextFunction = routeSource.indexOf('\nconst ', start + 1)

  if (start === -1 || nextFunction === -1) {
    throw new Error(`Missing function ${functionName}`)
  }

  return routeSource.slice(start, nextFunction)
}

const getRouteBody = (routeAnchor: string) => {
  const start = routeSource.indexOf(routeAnchor)
  const nextRoute = routeSource.indexOf('\n  .', start + 1)

  if (start === -1 || nextRoute === -1) {
    throw new Error(`Missing route ${routeAnchor}`)
  }

  return routeSource.slice(start, nextRoute)
}

test('comparison product reads are admitted through bounded serving helpers', () => {
  const judgmentPageBody = getFunctionBody('getComparisonProjectJudgmentsPage')
  const judgmentCountBody = getFunctionBody('getComparisonProjectJudgmentsCount')
  const statsBody = getFunctionBody('getComparisonProjectStatsResponse')
  const exportBody = getFunctionBody('getComparisonProjectExportResponse')
  const conflictResolutionExportBody = getFunctionBody('getComparisonProjectConflictResolutionExportSourceRows')
  const conflictResolutionImportTargetBody = getFunctionBody('getConflictResolutionImportServingCandidateTargetRows')
  const conflictResolutionImportValidationBody = getFunctionBody('validateConflictResolutionImportAnalyzeTarget')

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

test('comparison source writes stay owner routed and queue serving rebuilds', () => {
  const createBody = getRouteBody(".post(\n    '/api/comparison-projects'")
  const createFromProjectBody = getRouteBody(".post(\n    '/api/comparison-projects/from-project'")
  const patchBody = getRouteBody(".patch(\n    '/api/comparison-projects/:id'")
  const deleteBody = getRouteBody(".delete('/api/comparison-projects/:id'")

  expect(createBody).toContain('appDatabaseService.transaction')
  expect(createBody).toContain('createComparisonProjectRecord')
  expect(createBody).toContain('markComparisonProjectServingStaleAndQueueRebuild(createdComparisonProject.id)')
  expect(createFromProjectBody).toContain('appDatabaseService.transaction')
  expect(createFromProjectBody).toContain('createComparisonProjectRecord')
  expect(createFromProjectBody).toContain(
    'markComparisonProjectServingStaleAndQueueRebuild(createdComparisonProject.id)',
  )
  expect(patchBody).toContain('updateComparisonProjectWithRelinkedLinks')
  expect(patchBody).toContain('markComparisonProjectServingStaleAndQueueRebuild(params.id)')
  expect(deleteBody).toContain('appDatabaseService.transaction')
  expect(deleteBody).toContain('cleanupComparisonProjectServing')
})
