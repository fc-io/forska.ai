import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {expect, test} from 'bun:test'

const repoRoot = join(import.meta.dir, '../../..')

const readSource = (filePath: string) => {
  return readFileSync(join(repoRoot, filePath), 'utf8')
}

const getMatches = (filePaths: string[], markers: string[]) => {
  return filePaths.flatMap((filePath) => {
    const source = readSource(filePath)

    return markers.flatMap((marker) => {
      return source.includes(marker) ? [`${filePath}: ${marker}`] : []
    })
  })
}

const importWriteEntrypoints = [
  'src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostStructuredFileCreate.ts',
  'src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostStructuredFile.ts',
  'src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.ts',
  'src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidence.ts',
  'src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostPubmed.ts',
  'src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostEuropePmcPpr.ts',
  'src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostFhirEhrPatients.ts',
  'src/agent/arxivWorkflow/arxivWorkflowStoreEntires.ts',
  'src/agent/biorxivWorkflowStoreEntries.ts',
  'src/agent/medrxivWorkflowStoreEntries.ts',
  'src/agent/pubmedWorkflowStoreEntries.ts',
  'src/agent/europePmcPprWorkflowStoreEntries.ts',
  'src/agent/fhirEhrPatientsWorkflow/fhirEhrPatientsWorkflowStoreEntries.ts',
  'src/server/services/structuredFileImportService.ts',
  'src/server/services/articleImportStoreService.ts',
]

const importStoreWorkloadEntrypoints = [
  'src/server/services/articleImportStoreService.ts',
  'src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostStructuredFileCreate.ts',
  'src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidence.ts',
  'src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostCovidenceCreate.ts',
  'src/agent/fhirEhrPatientsWorkflow/fhirEhrPatientsWorkflowStoreEntries.ts',
]

const agentStoreEntrypoints = [
  'src/agent/arxivWorkflow/arxivWorkflowStoreEntires.ts',
  'src/agent/biorxivWorkflowStoreEntries.ts',
  'src/agent/medrxivWorkflowStoreEntries.ts',
  'src/agent/pubmedWorkflowStoreEntries.ts',
  'src/agent/europePmcPprWorkflowStoreEntries.ts',
  'src/agent/fhirEhrPatientsWorkflow/fhirEhrPatientsWorkflowStoreEntries.ts',
]

const metadataMutationEntrypoints = [
  'src/server/routes/PromptsRoutes.ts',
  'src/server/routes/SubprojectsRoutes.ts',
  'src/server/routes/ProviderModelsRoutes.ts',
  'src/server/routes/ProviderConnectionsRoutes.ts',
  'src/server/providers/providerModelRepository.ts',
  'src/server/providers/providerConnectionRepository.ts',
]

test('import and source-metadata writes keep review-serving delta append hooks', () => {
  const articleImportStoreSource = readSource('src/server/services/articleImportStoreService.ts')
  const covidenceImportSource = readSource('src/server/services/covidenceImportService.ts')
  const structuredFileImportSource = readSource('src/server/services/structuredFileImportService.ts')

  expect(articleImportStoreSource).toContain('appendArticleReviewServingDeltas')
  expect(articleImportStoreSource).toContain('appendReviewServingImportRunArticleDelta')
  expect(articleImportStoreSource).toContain('upsertReviewImportArticleHotField')
  expect(articleImportStoreSource).toContain('clearStaleImportRouteLinks')
  expect(articleImportStoreSource).toContain("changeKind: 'importRoute.article.removed'")
  expect(articleImportStoreSource).toContain("changeKind: 'importRoute.article.rankFields.updated'")
  expect(articleImportStoreSource).toContain("'sourceMetadata'")
  expect(covidenceImportSource).toContain('appendProjectScopeArticleReviewServingDeltas')
  expect(covidenceImportSource).toContain('appendHumanJudgmentReviewServingDeltas')
  expect(covidenceImportSource).toContain('appendProjectReviewConfigReviewServingDelta')
  expect(covidenceImportSource).toContain('appendPromptConfigReviewServingDelta')
  expect(structuredFileImportSource).toContain('storeImportedArticlesWithTx')
})

test('broad import store paths carry explicit DuckDB workload contexts', () => {
  const articleImportStoreSource = readSource('src/server/services/articleImportStoreService.ts')

  expect(articleImportStoreSource).toContain('articleImportStoreWorkloadContext')
  expect(articleImportStoreSource).toContain("workloadClass: 'background.importStore'")
  expect(articleImportStoreSource).toContain("routeOrJobKey: 'import.storeArticles'")
  expect(articleImportStoreSource).toContain('}, articleImportStoreWorkloadContext)')

  const missingContextMatches = importStoreWorkloadEntrypoints.filter((filePath) => {
    return !readSource(filePath).includes('articleImportStoreWorkloadContext')
  })

  expect(missingContextMatches).toEqual([])
})

test('agent import workflows use the shared import store batch path', () => {
  const missingStorePathMatches = agentStoreEntrypoints.filter((filePath) => {
    return !readSource(filePath).includes('storeImportedArticles')
  })
  const missingBatchMatches = agentStoreEntrypoints.filter((filePath) => {
    const source = readSource(filePath)

    return !source.includes('batch') && !source.includes('SHARD_COUNT')
  })

  expect(missingStorePathMatches).toEqual([])
  expect(missingBatchMatches).toEqual([])
})

test('import create paths do not synchronously fan out affected projects after source writes', () => {
  const forbiddenMatches = getMatches(importWriteEntrypoints, [
    'markImportedArticleProjectsDirty',
    'markProjectRefreshesDirtyByImportRouteIds',
    'markArticleProjectsDirtyAtomically',
    'getDirtyProjectsForProjectIds',
    'await requestReviewServingV4Rebuild',
    'await rebuildProjectReviewServingBatch',
    'rebuildProjectReviewServingBatch(',
    'setupProjectReviewServingStaging',
    'promoteReviewServingSnapshot',
    'INSERT INTO mart.review_',
    'UPDATE mart.review_',
    'DELETE FROM mart.review_',
    'SELECT DISTINCT project_import_route.project_id AS projectId',
  ])

  expect(forbiddenMatches).toEqual([])
})

test('prompt subproject model and provider mutations use enqueue or delta markers without project-scale scans', () => {
  const promptsSource = readSource('src/server/routes/PromptsRoutes.ts')
  const subprojectsSource = readSource('src/server/routes/SubprojectsRoutes.ts')
  const providerModelSource = readSource('src/server/providers/providerModelRepository.ts')
  const providerConnectionSource = readSource('src/server/providers/providerConnectionRepository.ts')

  expect(promptsSource).toContain('appendProjectReviewConfigReviewServingDeltas')
  expect(promptsSource).toContain('appendPromptConfigReviewServingDeltas')
  expect(subprojectsSource).toContain('appendProjectReviewConfigReviewServingDelta')
  expect(subprojectsSource).toContain('appendPromptConfigReviewServingDeltas')
  expect(subprojectsSource).toContain('appendProjectScopeArticleReviewServingDeltas')
  expect(providerModelSource).toContain('advanceTargetStateDirtyTokensAtomically')
  expect(providerConnectionSource).toContain('advanceTargetStateDirtyTokensAtomically')
  expect(providerModelSource).toContain('appendProviderModelExecutionIdentityReviewServingDeltas')
  expect(providerConnectionSource).toContain('appendProviderConnectionExecutionIdentityReviewServingDeltas')
  expect(providerModelSource).toContain('sourceMutationKey: `providerModel.update|')
  expect(providerConnectionSource).toContain('sourceMutationKey: `providerConnection.update|')
  expect(providerConnectionSource).toContain("sourceMutationKey: 'providerConnection.archive'")

  const forbiddenMatches = getMatches(metadataMutationEntrypoints, [
    'getProjectMartDirtyRefreshStateService',
    'requestReviewServingV4Rebuild',
    'rebuildProjectReviewServingBatch',
    'setupProjectReviewServingStaging',
    'promoteReviewServingSnapshot',
    'INSERT INTO mart.review_',
    'UPDATE mart.review_',
    'DELETE FROM mart.review_',
  ])

  expect(forbiddenMatches).toEqual([])
})
