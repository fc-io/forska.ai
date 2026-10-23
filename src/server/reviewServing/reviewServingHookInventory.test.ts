import {readFileSync} from 'node:fs'
import {join, relative} from 'node:path'

import {expect, test} from 'bun:test'

const workspaceRoot = join(import.meta.dir, '../../..')

type HookInventoryEntry = {
  filePath: string
  label: string
  markers: string[]
  outOfPhase2ScopeReason?: string
  symbol?: string
}

const integrationMarkers = [
  'appendArticleReviewServingDeltas',
  'appendArticleReviewServingDeltasForIds',
  'appendHumanJudgmentReviewServingDeltas',
  'appendImportRouteArticleDelta',
  'appendLlmJudgmentReviewServingDeltas',
  'appendProjectReviewConfigReviewServingDelta',
  'appendProjectReviewConfigReviewServingDeltas',
  'appendProjectScopeArticleReviewServingDelta',
  'appendProjectScopeArticleReviewServingDeltas',
  'appendPromptConfigReviewServingDelta',
  'appendPromptConfigReviewServingDeltas',
  'createReviewBulkOperationJob',
  'insertArticlesIntoProject',
  'judgeStoreJudgment',
  'storeImportedArticleChunkInTx',
  'storeImportedArticlesInTx',
  'syncImportedArticlesInTx',
  'syncCovidenceProjectScopeFromConfig',
  'immutablePromptIdentityReviewServingFields',
  'upsertReviewImportArticleHotField',
  'upsertReviewImportArticleHotFields',
]

const hookInventory: HookInventoryEntry[] = [
  {
    filePath: 'src/server/services/articleImportStoreService.ts',
    label: 'article import store transaction core',
    markers: ['storeImportedArticleChunkInTx'],
    symbol: 'storeImportedArticlesInTx',
  },
  {
    filePath: 'src/server/services/articleImportStoreService.ts',
    label: 'article import store exported transaction wrapper',
    markers: ['storeImportedArticlesInTx'],
    symbol: 'storeImportedArticlesWithTx',
  },
  {
    filePath: 'src/server/services/articleImportStoreService.ts',
    label: 'article import sync exported transaction wrapper',
    markers: ['syncImportedArticlesInTx'],
    symbol: 'syncImportedArticlesWithTx',
  },
  {
    filePath: 'src/server/services/articleImportStoreService.ts',
    label: 'import-route current-link upsert',
    markers: ['appendImportRouteArticleDelta'],
    symbol: 'upsertArticleImportRouteCurrentLinks',
  },
  {
    filePath: 'src/server/services/articleImportStoreService.ts',
    label: 'import-route source-record upsert',
    markers: ['upsertReviewImportArticleHotFields', 'appendImportRouteArticleDelta'],
    symbol: 'upsertArticleImportRouteSourceRecords',
  },
  {
    filePath: 'src/server/services/articleImportStoreService.ts',
    label: 'stale import-route link cleanup',
    markers: ['upsertReviewImportArticleHotField', 'appendImportRouteArticleDelta'],
    symbol: 'clearStaleImportRouteLinks',
  },
  {
    filePath: 'src/server/services/structuredFileImportService.ts',
    label: 'structured-file import caller',
    markers: ['storeImportedArticlesWithTx'],
  },
  {
    filePath: 'src/server/services/covidenceImportService.ts',
    label: 'Covidence import caller and seeded writes',
    markers: [
      'syncImportedArticlesWithTx',
      'appendHumanJudgmentReviewServingDeltas',
      'appendProjectReviewConfigReviewServingDelta',
      'appendPromptConfigReviewServingDelta',
      'appendProjectScopeArticleReviewServingDeltas',
    ],
  },
  {
    filePath: 'src/server/routes/DataSourcesImportRoutes/dataSourcesImportRoutesPostStructuredFile.ts',
    label: 'data-source structured-file import route',
    markers: [],
    outOfPhase2ScopeReason: 'immutable structured-file data-source route does not write imported articles in Phase 2',
    symbol: 'dataSourcesImportRoutesPostStructuredFile',
  },
  {
    filePath: 'src/server/routes/DataSourcesImportRoutes/startCovidencePackageImportInBackground.ts',
    label: 'data-source Covidence background package import',
    markers: ['syncCovidenceProjectScopeFromConfig'],
    symbol: 'runCovidencePackageImport',
  },
  {
    filePath: 'src/server/services/articleImportStoreService.ts',
    label: 'canonical article import updates',
    markers: ['appendArticleReviewServingDeltas'],
    symbol: 'updateExistingCanonicalArticlesInTx',
  },
  {
    filePath: 'src/server/services/articleCanonicalMatcher.ts',
    label: 'canonical article matcher creates',
    markers: ['appendArticleReviewServingDeltas'],
    symbol: 'insertCreatedArticles',
  },
  {
    filePath: 'src/server/services/pdfFetchJobs.ts',
    label: 'PDF fetch full-text update path',
    markers: ['appendArticleReviewServingDeltas'],
    symbol: 'fetchAndStoreForRow',
  },
  {
    filePath: 'src/server/fullText/canonicalFullTextStore.ts',
    label: 'converted and rebuilt canonical full-text update paths',
    markers: ['appendArticleReviewServingDeltas'],
    symbol: 'storeConvertedFullText',
  },
  {
    filePath: 'src/server/cron/fullTextConversionJobs.ts',
    label: 'full-text conversion cron update path',
    markers: ['storeConvertedFullText'],
  },
  {
    filePath: 'src/server/utils/ensureFullText.ts',
    label: 'on-demand full-text conversion update path',
    markers: ['storeConvertedFullText'],
    symbol: 'ensureFullText',
  },
  {
    filePath: 'src/server/routes/articleAdminRoutes/articleAdminRoutesPostFetchPdf.ts',
    label: 'article admin content update path',
    markers: ['appendArticleReviewServingDeltas'],
  },
  {
    filePath: 'src/server/routes/articleAdminRoutes/articleAdminRoutesPostUploadPdf.ts',
    label: 'article admin content update path',
    markers: ['appendArticleReviewServingDeltas'],
  },
  {
    filePath: 'src/server/routes/articleAdminRoutes/articleAdminRoutesPostConversionReconvert.ts',
    label: 'article admin content update path',
    markers: ['appendArticleReviewServingDeltas'],
  },
  {
    filePath: 'src/server/routes/articlesRoutes/articlesRoutesPostPdfFetchReset.ts',
    label: 'article upload/reset route updates',
    markers: ['appendArticleReviewServingDeltasForIds'],
  },
  {
    filePath: 'src/server/routes/articlesRoutes/articlesRoutesPostBatchUpsert.ts',
    label: 'article upload/reset route updates',
    markers: ['storeImportedArticlesWithTx'],
  },
  {
    filePath: 'src/server/cron/judgmentsJobs/judgmentsJobsMarkDirtyWork.ts',
    label: 'SQLite outbox dirty-work commit',
    markers: ['insertJudgments'],
    symbol: 'commitJudgmentSqliteOutboxImportDirtyWork',
  },
  {
    filePath: 'src/server/cron/judgmentsJobs/judgmentsJobsMarkDirtyWork.ts',
    label: 'SQLite outbox judgment insert',
    markers: ['appendLlmJudgmentReviewServingDeltas'],
    symbol: 'insertJudgments',
  },
  {
    filePath: 'src/agent/judge/storeSinglePromptJudgment.ts',
    label: 'single-prompt judgment store',
    markers: ['judgeStoreJudgment'],
    symbol: 'storeSinglePromptJudgment',
  },
  {
    filePath: 'src/agent/judge/judgeStoreJudgment.ts',
    label: 'direct LLM judgment store',
    markers: ['appendLlmJudgmentReviewServingDeltas'],
    symbol: 'judgeStoreJudgment',
  },
  {
    filePath: 'src/server/routes/PromptsRoutes.ts',
    label: 'prompt merge LLM delete path',
    markers: ['appendLlmJudgmentReviewServingDeltas'],
    symbol: 'resolveJudgmentPromptCollisions',
  },
  {
    filePath: 'src/server/routes/PromptsRoutes.ts',
    label: 'prompt merge human duplicate delete path',
    markers: [],
    outOfPhase2ScopeReason: 'human hard deletes need a future judgment.human.deleted change kind before ledger wiring',
    symbol: 'resolveJudgmentHumanPromptCollisions',
  },
  {
    filePath: 'src/server/routes/projectsRoutes/projectsRoutesPatchEdit/softDeleteProjectPromptLlmJudgmentsTx.ts',
    label: 'project prompt LLM cleanup delete path',
    markers: ['appendLlmJudgmentReviewServingDeltas'],
    symbol: 'softDeleteProjectPromptLlmJudgmentsTx',
  },
  {
    filePath: 'src/server/services/projectTransfer/projectTransferCommitWriter.ts',
    label: 'project-transfer LLM judgment imports',
    markers: ['appendLlmJudgmentReviewServingDeltas'],
  },
  {
    filePath: 'src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostSubmit.ts',
    label: 'human assessment prompt submit',
    markers: ['appendHumanJudgmentReviewServingDeltas'],
    symbol: 'humanAssessmentRoutesPostSubmit',
  },
  {
    filePath: 'src/server/routes/PromptsRoutes.ts',
    label: 'prompt merge human judgment moves',
    markers: ['appendHumanJudgmentReviewServingDeltas'],
  },
  {
    filePath: 'src/server/routes/projectsRoutes/projectsRoutesPostClone/copyCloneSourceRowsTx.ts',
    label: 'project clone summary-mode human judgments',
    markers: ['appendHumanJudgmentReviewServingDeltas'],
  },
  {
    filePath: 'src/server/services/projectTransfer/projectTransferCommitWriter.ts',
    label: 'project-transfer human judgment imports',
    markers: ['appendHumanJudgmentReviewServingDeltas'],
  },
  {
    filePath: 'src/server/routes/projectsRoutes/upsertProjectPromptTx.ts',
    label: 'project prompt upsert',
    markers: ['appendPromptConfigReviewServingDelta'],
    symbol: 'upsertProjectPromptTx',
  },
  {
    filePath: 'src/server/routes/projectsRoutes/appendProjectReviewConfigDeltaIfNeeded.ts',
    label: 'project create/edit/clone and import-route config edits',
    markers: ['appendProjectReviewConfigReviewServingDelta'],
  },
  {
    filePath: 'src/server/routes/projectsRoutes/projectsRoutesPostClone/copyCloneSourceRowsTx.ts',
    label: 'project clone article scope copies',
    markers: ['appendProjectScopeArticleReviewServingDeltas'],
  },
  {
    filePath: 'src/server/routes/PromptsRoutes.ts',
    label: 'prompt identity and review-config changes',
    markers: ['appendProjectReviewConfigReviewServingDeltas', 'appendPromptConfigReviewServingDeltas'],
  },
  {
    filePath: 'src/server/services/immutablePromptService.ts',
    label: 'immutable prompt identity fields',
    markers: ['immutablePromptIdentityReviewServingFields'],
  },
  {
    filePath: 'src/server/services/insertArticlesIntoProject.ts',
    label: 'direct project article bulk inserts',
    markers: ['appendProjectScopeArticleReviewServingDeltas'],
    symbol: 'insertArticlesIntoProject',
  },
  {
    filePath: 'src/server/routes/ProjectArticlesRoutes.ts',
    label: 'project article route add/delete',
    markers: ['insertArticlesIntoProject', 'appendProjectScopeArticleReviewServingDelta'],
  },
  {
    filePath: 'src/server/routes/ProjectsAddArticlesRoutes.ts',
    label: 'project add-articles route fan-in',
    markers: ['createReviewBulkOperationJob'],
  },
  {
    filePath: 'src/server/routes/subprojectsRoutes/subprojectsRoutesPostCreate/insertSubproject.ts',
    label: 'subproject project-article writes',
    markers: ['appendProjectScopeArticleReviewServingDeltas'],
  },
]

const getSource = (filePath: string) => {
  return readFileSync(join(workspaceRoot, filePath), 'utf8')
}

const getSymbolScope = (source: string, symbol: string) => {
  const symbolPattern = new RegExp(`(^|\\n)(export\\s+)?(const|function)\\s+${symbol}\\b`)
  const match = source.match(symbolPattern)

  if (match?.index === undefined) {
    return null
  }

  const startIndex = match.index
  const nextTopLevelMatch = source.slice(startIndex + 1).match(/\n(?:export\s+)?(?:const|function|type)\s+\w+/)
  const endIndex = nextTopLevelMatch?.index ? startIndex + 1 + nextTopLevelMatch.index : source.length

  return source.slice(startIndex, endIndex)
}

const getCheckedSource = (entry: HookInventoryEntry) => {
  const source = getSource(entry.filePath)

  return entry.symbol ? getSymbolScope(source, entry.symbol) : source
}

const getMissingInventoryEntries = () => {
  return hookInventory.flatMap((entry) => {
    const checkedSource = getCheckedSource(entry)
    const scopedLabel = `${relative(workspaceRoot, join(workspaceRoot, entry.filePath))}: ${entry.label}`

    if (!checkedSource) {
      return [`${scopedLabel} missing hook symbol ${entry.symbol ?? '<file>'}`]
    }

    if (entry.outOfPhase2ScopeReason) {
      return []
    }

    const missingMarkers = entry.markers.filter((marker) => {
      return !checkedSource.includes(marker)
    })

    return missingMarkers.length === 0 ? [] : [`${scopedLabel} missing ${missingMarkers.join(', ')}`]
  })
}

test('Phase 2 hook inventory entries are wired to review-serving integration markers or documented out of scope', () => {
  expect(getMissingInventoryEntries()).toEqual([])
})

test('Phase 2 hook inventory uses only known review-serving integration markers', () => {
  const unknownMarkers = hookInventory.flatMap((entry) => {
    return entry.markers.filter((marker) => {
      return (
        !integrationMarkers.includes(marker)
        && !hookInventory.some((otherEntry) => {
          return otherEntry.symbol === marker
        })
      )
    })
  })

  expect(unknownMarkers).toEqual([])
})

test('Phase 2 hook inventory keeps product routes on existing read contracts', () => {
  const guardedRoutes = [
    'src/server/routes/HumanAssessmentRoutes/humanAssessmentRoutesPostSubmit.ts',
    'src/server/routes/ProjectArticlesRoutes.ts',
    'src/server/routes/ProjectsAddArticlesRoutes.ts',
    'src/server/routes/ProjectsRoutes.ts',
    'src/server/routes/PromptsRoutes.ts',
    'src/server/routes/projectsRoutes/getProjectRow.ts',
    'src/server/routes/projectsRoutes/projectsRoutesDeleteProject.ts',
    'src/server/routes/projectsRoutes/projectsRoutesGetArchived.ts',
    'src/server/routes/projectsRoutes/projectsRoutesGetProject.ts',
    'src/server/routes/projectsRoutes/projectsRoutesGetProjects.ts',
    'src/server/routes/projectsRoutes/projectsRoutesGetProjectsWithoutJobs.ts',
    'src/server/routes/projectsRoutes/projectsRoutesPatchEdit.ts',
    'src/server/routes/projectsRoutes/projectsRoutesPatchEdit/applyProjectPromptEditsTx.ts',
    'src/server/routes/projectsRoutes/projectsRoutesPatchEdit/canEditPromptsWithJudgmentJob.ts',
    'src/server/routes/projectsRoutes/projectsRoutesPatchEdit/deleteProjectHumanPromptAnswersForChangedPromptLinksTx.ts',
    'src/server/routes/projectsRoutes/projectsRoutesPatchEdit/getCurrentProjectImportRoutes.ts',
    'src/server/routes/projectsRoutes/projectsRoutesPatchEdit/getExistingProjectPromptComparisonRows.ts',
    'src/server/routes/projectsRoutes/projectsRoutesPatchEdit/getProjectEditResponsePrompts.ts',
    'src/server/routes/projectsRoutes/projectsRoutesPatchEdit/getProjectPromptLlmCleanupCandidateRowsTx.ts',
    'src/server/routes/projectsRoutes/projectsRoutesPatchEdit/markComparisonServingStaleForProjectPromptEditTx.ts',
    'src/server/routes/projectsRoutes/projectsRoutesPatchEdit/resolveProjectPromptEditsTx.ts',
    'src/server/routes/projectsRoutes/projectsRoutesPatchEdit/runProjectEditTransaction.ts',
    'src/server/routes/projectsRoutes/projectsRoutesPatchEdit/softDeleteProjectPromptLlmJudgmentsTx.ts',
    'src/server/routes/projectsRoutes/projectsRoutesPatchProject.ts',
    'src/server/routes/projectsRoutes/projectsRoutesPostClone.ts',
    'src/server/routes/projectsRoutes/projectsRoutesPostClone/copyCloneSourceRowsTx.ts',
    'src/server/routes/projectsRoutes/projectsRoutesPostCreate.ts',
    'src/server/routes/projectsRoutes/projectsRoutesPostUnarchive.ts',
    'src/server/routes/projectsRoutes/updateProjectTx.ts',
    'src/server/routes/projectsRoutes/upsertProjectPromptTx.ts',
    'src/server/routes/SubprojectsRoutes.ts',
    'src/server/routes/subprojectsRoutes/subprojectsRoutesGetSources.ts',
    'src/server/routes/subprojectsRoutes/subprojectsRoutesPostCreate.ts',
    'src/server/routes/subprojectsRoutes/subprojectsRoutesPostCreate/collectSubprojectArticleIds.ts',
    'src/server/routes/subprojectsRoutes/subprojectsRoutesPostCreate/insertSubproject.ts',
    'src/server/routes/subprojectsRoutes/subprojectsRoutesPostCreate/linkProjectPromptTx.ts',
    'src/server/routes/subprojectsRoutes/subprojectsRoutesPostCreate/queryAllArticlesInScope.ts',
    'src/server/routes/subprojectsRoutes/subprojectsRoutesPostCreate/queryArticlesWithPromptFilters.ts',
    'src/server/routes/articleAdminRoutes/articleAdminRoutesGetAdminInfo.ts',
    'src/server/routes/articleAdminRoutes/articleAdminRoutesPostCanonicalFullTextRebuild.ts',
    'src/server/routes/articleAdminRoutes/articleAdminRoutesPostConversionReconvert.ts',
    'src/server/routes/articleAdminRoutes/articleAdminRoutesPostConversionReconvert/assertReconvertCandidate.ts',
    'src/server/routes/articleAdminRoutes/articleAdminRoutesPostConvertPdf.ts',
    'src/server/routes/articleAdminRoutes/articleAdminRoutesPostFetchPdf.ts',
    'src/server/routes/articleAdminRoutes/articleAdminRoutesPostUploadPdf.ts',
    'src/server/routes/articleAdminRoutes/articleAdminRoutesPostUploadPdf/storeUploadedPdf.ts',
    'src/server/routes/articleAdminRoutes/conversionReconvertBody.ts',
    'src/server/routes/articlesRoutes/articlesRoutesDeleteArticle.ts',
    'src/server/routes/articlesRoutes/articlesRoutesGetArticle.ts',
    'src/server/routes/articlesRoutes/articlesRoutesGetArticle/getArticleJudgmentValue.ts',
    'src/server/routes/articlesRoutes/articlesRoutesGetConversionStats.ts',
    'src/server/routes/articlesRoutes/articlesRoutesGetLatest.ts',
    'src/server/routes/articlesRoutes/articlesRoutesGetPdfFetchJob.ts',
    'src/server/routes/articlesRoutes/articlesRoutesGetSearch.ts',
    'src/server/routes/articlesRoutes/articlesRoutesPostBatchUpsert.ts',
    'src/server/routes/articlesRoutes/articlesRoutesPostConversionReset.ts',
    'src/server/routes/articlesRoutes/articlesRoutesPostPdfFetchBulk.ts',
    'src/server/routes/articlesRoutes/articlesRoutesPostPdfFetchByFilter.ts',
    'src/server/routes/articlesRoutes/articlesRoutesPostPdfFetchByProject.ts',
    'src/server/routes/articlesRoutes/articlesRoutesPostPdfFetchByProject/dateFilters.ts',
    'src/server/routes/articlesRoutes/articlesRoutesPostPdfFetchReset.ts',
    'src/server/routes/articlesRoutes/pdfSelectionDetailReadiness.ts',
  ]
  const forbiddenServingSwitchMarkers = guardedRoutes.flatMap((filePath) => {
    const source = getSource(filePath)
    const forbiddenMarkers = [
      'review_article_serving_v4',
      'review_snapshot_manifest_v4',
      'promoteReviewServingSnapshot',
    ]

    return forbiddenMarkers
      .filter((marker) => {
        return source.includes(marker)
      })
      .map((marker) => {
        return `${filePath}: ${marker}`
      })
  })

  expect(forbiddenServingSwitchMarkers).toEqual([])
})

test('Phase 2 integrated write hooks do not populate serving projections, promote snapshots, or fan out import scope', () => {
  const integratedHookFiles = [
    ...new Set(
      hookInventory
        .filter((entry) => {
          return !entry.outOfPhase2ScopeReason
        })
        .map((entry) => {
          return entry.filePath
        }),
    ),
  ]
  const forbiddenWriteMarkers = [
    'INSERT INTO mart.review_',
    'UPDATE mart.review_',
    'DELETE FROM mart.review_',
    'INSERT INTO app.review_serving_snapshot_manifest',
    'UPDATE app.review_serving_snapshot_manifest',
    'promoteReviewServingSnapshot',
    'project-scale selected-import fanout',
  ]
  const forbiddenMatches = integratedHookFiles.flatMap((filePath) => {
    const source = getSource(filePath)

    return forbiddenWriteMarkers
      .filter((marker) => {
        return source.includes(marker)
      })
      .map((marker) => {
        return `${filePath}: ${marker}`
      })
  })

  expect(forbiddenMatches).toEqual([])
})
