import {expect, test} from 'bun:test'

import {
  namedReviewFastCountDefinitions,
  namedReviewFastCountKeys,
  reviewServingFilterKeys,
  reviewServingPhysicalAccessStrategies,
  reviewServingProjectionComponents,
  reviewServingReadContractKeys,
  reviewServingWorkloadClasses,
} from './reviewServingContracts.ts'
import {
  getMissingReviewServingReadContractKeys,
  getReviewServingReadContract,
  reviewServingReadContractList,
  reviewServingReadContractRouteInventory,
  reviewServingReadSurfaces,
} from './reviewServingReadContracts.ts'

test('review serving read contracts cover every registered hot read key', () => {
  const duplicateContractKeys = reviewServingReadContractList
    .map((contract) => {
      return contract.key
    })
    .filter((contractKey, index, contractKeys) => {
      return contractKeys.indexOf(contractKey) !== index
    })

  expect(getMissingReviewServingReadContractKeys()).toEqual([])
  expect(duplicateContractKeys).toEqual([])
  expect(reviewServingReadContractList).toHaveLength(reviewServingReadContractKeys.length)
})

test('review serving read contracts declare every static registry field', () => {
  const workloadClasses = new Set<string>(reviewServingWorkloadClasses)
  const filterKeys = new Set<string>(reviewServingFilterKeys)
  const physicalAccessStrategies = new Set<string>(reviewServingPhysicalAccessStrategies)
  const freshnessBehaviors = new Set(['allowStaleSnapshot', 'asyncUnavailable', 'requireReadySnapshot'])
  const projectionComponents = new Set<string>(reviewServingProjectionComponents)
  const invalidContracts = reviewServingReadContractList.filter((contract) => {
    return (
      !workloadClasses.has(contract.workloadClass)
      || !Array.isArray(contract.cursorFields)
      || !Array.isArray(contract.allowedFilters)
      || contract.allowedFilters.some((filterKey) => {
        return typeof filterKey !== 'string' || !filterKeys.has(filterKey)
      })
      || !physicalAccessStrategies.has(contract.physicalAccessStrategy)
      || !Array.isArray(contract.namedFastCounts)
      || !freshnessBehaviors.has(contract.freshnessBehavior)
      || contract.servingTable.length === 0
      || !Array.isArray(contract.requiredComponents)
      || contract.requiredComponents.length === 0
      || contract.requiredComponents.some((component) => {
        return typeof component !== 'string' || !projectionComponents.has(component)
      })
      || !Array.isArray(contract.optionalComponents)
      || contract.optionalComponents.some((component) => {
        return typeof component !== 'string' || !projectionComponents.has(component)
      })
      || contract.maxPageSize < 1
      || contract.maxResultRows < 0
      || contract.maxEstimatedResultBytes < 1
      || contract.timeoutMs < 1
      || contract.sort.fields.length === 0
    )
  })

  expect(
    invalidContracts.map((contract) => {
      return contract.key
    }),
  ).toEqual([])
})

test('review serving read contracts only reference named fast counts', () => {
  const countKeys = new Set(namedReviewFastCountKeys)
  const unknownCountKeys = reviewServingReadContractList.flatMap((contract) => {
    return contract.namedFastCounts.filter((countKey) => {
      return !countKeys.has(countKey)
    })
  })

  expect(unknownCountKeys).toEqual([])
})

test('named fast count definitions use explicit versions', () => {
  const missingVersions = namedReviewFastCountKeys.filter((countKey) => {
    return namedReviewFastCountDefinitions[countKey].summaryDefinitionVersion.length === 0
  })

  expect(missingVersions).toEqual([])
})

test('contracts advertising queue-backed LLM unassessed counts require queue projection state', () => {
  const contracts = reviewServingReadContractList.filter((contract) => {
    return contract.namedFastCounts.includes('review.llm.unassessedByPrompt')
  })
  const contractsMissingQueue = contracts.filter((contract) => {
    return !contract.requiredComponents.includes('queue')
  })

  expect(contractsMissingQueue).toEqual([])
})

test('contracts advertising fast counts require each count dependency component', () => {
  const contractsMissingCountDependencies = reviewServingReadContractList.filter((contract) => {
    return contract.namedFastCounts.some((countKey) => {
      return namedReviewFastCountDefinitions[countKey].requiredComponents.some((component) => {
        return !contract.requiredComponents.includes(component)
      })
    })
  })

  expect(
    contractsMissingCountDependencies.map((contract) => {
      return contract.key
    }),
  ).toEqual([])
})

test('normal foreground row contracts require ready snapshots and serving tables', () => {
  const llmRows = getReviewServingReadContract('review.llm.rows')
  const humanRows = getReviewServingReadContract('review.human.rows')
  const bothRows = getReviewServingReadContract('review.both.rows')

  expect(llmRows?.freshnessBehavior).toBe('requireReadySnapshot')
  expect(humanRows?.servingTable).toBe('mart.review_article_serving_v4')
  expect(bothRows?.requiredComponents).toContain('humanStatus')
  expect(bothRows?.requiredComponents).toContain('llmStatus')
})

test('direct ordered row contracts do not advertise filters ignored by row SQL', () => {
  const orderedRowContracts = reviewServingReadContractList.filter((contract) => {
    return (
      contract.physicalAccessStrategy === 'orderedPrefix' && contract.servingTable === 'mart.review_article_serving_v4'
    )
  })

  expect(
    orderedRowContracts.map((contract) => {
      return [
        contract.key,
        contract.allowedFilters,
        contract.optionalComponents,
        contract.searchMode,
        contract.cursorFields,
        contract.sort.fields,
      ]
    }),
  ).toEqual([
    ['review.llm.rows', [], [], 'none', ['sort_key DESC', 'article_id ASC'], ['sort_key', 'article_id ASC']],
    ['review.human.rows', [], [], 'none', ['sort_key DESC', 'article_id ASC'], ['sort_key', 'article_id ASC']],
    ['review.both.rows', [], [], 'none', ['sort_key DESC', 'article_id ASC'], ['sort_key', 'article_id ASC']],
    [
      'review.unassessed.rows',
      [],
      [],
      'none',
      ['activity_sort_at DESC', 'article_id DESC'],
      ['activity_sort_at', 'article_id'],
    ],
  ])
})

test('prompt preview contract does not advertise prompt filters on article payload serving rows', () => {
  const promptPreview = getReviewServingReadContract('review.prompt.preview')

  expect(promptPreview?.allowedFilters).toEqual([])
  expect(promptPreview?.cursorFields).toEqual(['article_created_at ASC NULLS LAST', 'article_id'])
  expect(promptPreview?.servingTable).toBe('mart.review_article_serving_payload_v4')
  expect(promptPreview?.sort).toEqual({direction: 'asc', fields: ['article_created_at ASC NULLS LAST', 'article_id']})
})

test('unassessed row contract requires display and payload dependencies', () => {
  const unassessedRows = getReviewServingReadContract('review.unassessed.rows')

  expect(unassessedRows?.requiredComponents).toEqual([
    'display',
    'projectScope',
    'selectedImport',
    'payload',
    'judgmentInputContent',
    'llmStatus',
    'queue',
    'summary',
  ])
})

test('detail row contract does not pin article lookups to a list mode', () => {
  const detailRow = getReviewServingReadContract('review.detail.row')
  const detailJudgments = getReviewServingReadContract('review.detail.judgments')

  expect(detailRow?.listMode).toBeNull()
  expect(detailRow?.servingTable).toBe('mart.review_article_serving_v4')
  expect(detailRow?.sort.fields[0]).toContain('CASE list_mode_key')
  expect(detailJudgments?.servingTable).toBe('mart.review_article_judgment_detail_serving_v4')
  expect(detailJudgments?.allowedFilters).toEqual(['articleId'])
  expect(detailJudgments?.sort.fields).toEqual([
    "CASE list_mode_key WHEN 'both' THEN 0 WHEN 'llm' THEN 1 WHEN 'human' THEN 2 WHEN 'unassessed' THEN 3 ELSE 4 END",
    'prompt_order ASC NULLS LAST',
    'prompt_id',
  ])
})

test('count contracts do not advertise unsupported searched-count reads', () => {
  const countContracts = reviewServingReadContractList.filter((contract) => {
    return contract.workloadClass === 'foregroundReviewCount'
  })

  expect(
    countContracts.map((contract) => {
      return [contract.key, contract.searchMode, contract.allowedFilters.includes('searchTokenPrefix')]
    }),
  ).toEqual([
    ['review.llm.count', 'none', false],
    ['review.human.count', 'none', false],
    ['review.both.count', 'none', false],
    ['review.unassessed.count', 'none', false],
    ['review.prompt.badges', 'none', false],
  ])
})

test('queue and count contracts use physical serving-table sort columns', () => {
  const queue = getReviewServingReadContract('review.queue.unassessed')
  const count = getReviewServingReadContract('review.llm.count')
  const badges = getReviewServingReadContract('review.prompt.badges')

  expect(queue?.cursorFields).toEqual(['priority_bucket', 'activity_sort_at', 'article_id'])
  expect(queue?.sort.fields).toEqual(['priority_bucket', 'activity_sort_at', 'article_id'])
  expect(queue?.sort.direction).toBe('desc')
  expect(count?.sort.fields).toEqual(['list_mode_key', 'count_kind', 'summary_definition_version', 'filter_key'])
  expect(badges?.sort.fields).toEqual(['list_mode_key', 'count_kind', 'summary_definition_version', 'filter_key'])
})

test('job criteria contracts use job-table cursor and sort columns', () => {
  const jobContracts = [
    getReviewServingReadContract('review.bulk.selection'),
    getReviewServingReadContract('review.export.selection'),
    getReviewServingReadContract('review.pdf.selection'),
    getReviewServingReadContract('review.search.substringAsync'),
  ]

  expect(
    jobContracts.map((contract) => {
      return contract?.cursorFields
    }),
  ).toEqual([
    ['updated_at', 'job_id'],
    ['updated_at', 'job_id'],
    ['updated_at', 'job_id'],
    ['updated_at', 'job_id'],
  ])
  expect(
    jobContracts.map((contract) => {
      return contract?.sort.fields
    }),
  ).toEqual([
    ['updated_at', 'job_id'],
    ['updated_at', 'job_id'],
    ['updated_at', 'job_id'],
    ['updated_at', 'job_id'],
  ])
  expect(
    jobContracts.map((contract) => {
      return contract?.maxResultRows
    }),
  ).toEqual([1, 1, 1, 1])
})

test('human filter facets use a dedicated contract', () => {
  const reviewFacets = getReviewServingReadContract('review.filters.facets')
  const humanFacets = getReviewServingReadContract('review.human.filters.facets')
  const humanOptions = getReviewServingReadContract('review.human.filters.options')

  expect(reviewFacets?.key).toBe('review.filters.facets')
  expect(humanFacets?.servingTable).toBe('mart.review_filter_facet_serving_v4')
  expect(humanFacets?.requiredComponents).toEqual([
    'display',
    'humanStatus',
    'posting',
    'projectScope',
    'selectedImport',
    'summary',
  ])
  expect(humanFacets?.allowedFilters).toEqual(['humanStatus', 'promptAnswer'])
  expect(humanFacets?.namedFastCounts).toEqual([
    'review.human.filter.promptAnswer',
    'review.human.filter.summaryAnswer',
  ])
  expect(humanOptions?.requiredComponents).toEqual([
    'display',
    'humanStatus',
    'posting',
    'projectScope',
    'selectedImport',
    'summary',
  ])
  expect(humanOptions?.requiredComponents).not.toContain('llmStatus')
})

test('human payload contracts cover list and detail response judgments', () => {
  const humanListJudgments = getReviewServingReadContract('review.human.list.judgments')
  const bothListHumanJudgments = getReviewServingReadContract('review.both.list.humanJudgments')
  const detailHumanJudgments = getReviewServingReadContract('review.detail.humanJudgments')

  expect(humanListJudgments?.requiredComponents).toEqual(['humanStatus', 'summary'])
  expect(bothListHumanJudgments?.requiredComponents).toEqual(['humanStatus', 'summary'])
  expect(detailHumanJudgments?.requiredComponents).toEqual(['humanStatus', 'summary'])
  expect(humanListJudgments?.servingTable).toBe('mart.review_article_judgment_detail_serving_v4')
  expect(bothListHumanJudgments?.servingTable).toBe('mart.review_article_judgment_detail_serving_v4')
  expect(detailHumanJudgments?.servingTable).toBe('mart.review_article_judgment_detail_serving_v4')
})

test('search contracts require project scope without blocking async substring on search readiness', () => {
  const tokenPrefix = getReviewServingReadContract('review.search.tokenPrefix')
  const substringAsync = getReviewServingReadContract('review.search.substringAsync')

  expect(tokenPrefix?.requiredComponents).toEqual(['projectScope', 'search'])
  expect(substringAsync?.requiredComponents).toEqual(['projectScope'])
  expect(substringAsync?.optionalComponents).toEqual(['search'])
})

test('snapshot contracts align cursor fields with sort keys and required counts', () => {
  const health = getReviewServingReadContract('review.health.snapshot')
  const warning = getReviewServingReadContract('review.warning.snapshot')

  expect(health?.cursorFields).toEqual(['updated_at', 'snapshot_id'])
  expect(warning?.cursorFields).toEqual(['updated_at', 'snapshot_id'])
  expect(warning?.requiredComponents).toContain('queue')
  expect(warning?.optionalComponents).not.toContain('queue')
})

test('mounted routes stay off incomplete option, count, detail, warning, and preview coverage', () => {
  const incompleteProductRoutes = new Set([
    '/api/articles/pdf-fetch-by-filter',
    '/api/articles/pdf-fetch-by-project',
    '/api/articlesreviews',
    '/api/articlesreviewsboth',
    '/api/articlesreviewscount',
    '/api/articlesreviewsfilters',
    '/api/articlesreviewshuman',
    '/api/articlesreviewshumanfilters',
    '/api/projects/add_articles_by_filter',
    '/api/articlesreviewsunassessed',
    '/api/projectsreview',
    '/api/projectsreviewswarnings',
    '/api/projects/:id/prompts/:promptId/preview',
    '/api/projects/:id/export',
  ])
  const mountedIncompleteRoutes = reviewServingReadContractRouteInventory.filter((entry) => {
    return entry.mounted && incompleteProductRoutes.has(entry.productRoute)
  })
  const mountedPostingRoutes = reviewServingReadContractRouteInventory.filter((entry) => {
    return entry.mounted && entry.contractKeys.includes('review.filters.postings')
  })
  const mountedFacetRoutes = reviewServingReadContractRouteInventory.filter((entry) => {
    return entry.mounted && entry.contractKeys.includes('review.filters.facets')
  })

  expect(mountedIncompleteRoutes).toEqual([])
  expect(mountedPostingRoutes).toEqual([])
  expect(mountedFacetRoutes).toEqual([])
})

test('explicit PDF bulk ID route is not mapped to project-scoped review serving selection', () => {
  const explicitBulkPdfRoutes = reviewServingReadContractRouteInventory.filter((entry) => {
    return entry.productRoute === '/api/articles/pdf-fetch-bulk'
  })

  expect(explicitBulkPdfRoutes).toEqual([])
})

test('future filter posting and facet contracts stay unmounted until route shapes are complete', () => {
  const postingInventoryEntries = reviewServingReadContractRouteInventory.filter((entry) => {
    return entry.contractKeys.includes('review.filters.postings')
  })
  const facetInventoryEntries = reviewServingReadContractRouteInventory.filter((entry) => {
    return (
      entry.contractKeys.includes('review.filters.facets') || entry.contractKeys.includes('review.human.filters.facets')
    )
  })
  const optionInventoryEntries = reviewServingReadContractRouteInventory.filter((entry) => {
    return entry.contractKeys.some((contractKey) => {
      return contractKey === 'review.filters.options' || contractKey === 'review.human.filters.options'
    })
  })

  expect(
    postingInventoryEntries.map((entry) => {
      return [entry.productRoute, entry.mounted]
    }),
  ).toEqual([
    ['/api/articlesreviews', false],
    ['/api/articlesreviewscount', false],
    ['/api/articlesreviewshuman', false],
    ['/api/articlesreviewsboth', false],
    ['/api/articlesreviewsunassessed', false],
    ['/api/review-serving/filter-postings', false],
  ])
  expect(facetInventoryEntries).toHaveLength(2)
  expect(
    facetInventoryEntries.map((entry) => {
      return entry.mounted
    }),
  ).toEqual([false, false])
  expect(optionInventoryEntries).toHaveLength(2)
  expect(
    optionInventoryEntries.map((entry) => {
      return entry.contractKeys
    }),
  ).toEqual([
    ['review.filters.facets', 'review.filters.options', 'review.search.tokenPrefix', 'review.search.substringAsync'],
    [
      'review.human.filters.facets',
      'review.human.filters.options',
      'review.search.tokenPrefix',
      'review.search.substringAsync',
    ],
  ])
})

test('filtered row product routes include posting-intersection coverage', () => {
  const rowProductRoutes = new Set([
    '/api/articlesreviews',
    '/api/articlesreviewshuman',
    '/api/articlesreviewsboth',
    '/api/articlesreviewsunassessed',
  ])
  const rowInventoryEntries = reviewServingReadContractRouteInventory.filter((entry) => {
    return rowProductRoutes.has(entry.productRoute)
  })

  expect(
    rowInventoryEntries.map((entry) => {
      return [entry.productRoute, entry.contractKeys.includes('review.filters.postings'), entry.surfaces]
    }),
  ).toEqual([
    ['/api/articlesreviews', true, ['llm', 'row', 'count', 'badge', 'filter', 'search']],
    ['/api/articlesreviewshuman', true, ['human', 'row', 'count', 'filter', 'search']],
    ['/api/articlesreviewsboth', true, ['both', 'row', 'count', 'filter', 'search']],
    ['/api/articlesreviewsunassessed', true, ['unassessed', 'row', 'count', 'queue', 'filter', 'search']],
  ])
})

test('review serving read contracts use planned Phase 1 physical table names', () => {
  const allowedTables = new Set([
    'app.review_bulk_operation_job',
    'app.review_search_job',
    'app.review_serving_snapshot_manifest',
    'mart.review_article_filter_posting_serving_v4',
    'mart.review_article_count_serving_v4',
    'mart.review_article_judgment_detail_serving_v4',
    'mart.review_article_serving_payload_v4',
    'mart.review_article_serving_v4',
    'mart.review_filter_facet_serving_v4',
    'mart.review_filter_option_serving_v4',
    'mart.review_title_search_serving_v4',
    'mart.review_unassessed_queue_serving_v4',
  ])
  const unexpectedTables = reviewServingReadContractList
    .map((contract) => {
      return contract.servingTable
    })
    .filter((servingTable) => {
      return !allowedTables.has(servingTable)
    })

  expect(unexpectedTables).toEqual([])
})

test('review serving read contracts never point at raw fallback tables', () => {
  const forbiddenTables = new Set([
    'app.article',
    'app.judgment',
    'app.judgment_human',
    'app.judgment_human_summary',
    'app.project_article',
    'mart.project_scope_article',
    'mart.review_article_serving_detail',
  ])
  const rawFallbackContracts = reviewServingReadContractList.filter((contract) => {
    return forbiddenTables.has(contract.servingTable)
  })

  expect(
    rawFallbackContracts.map((contract) => {
      return contract.key
    }),
  ).toEqual([])
})

test('review serving migration inventory maps contracts to product routes and planned surfaces', () => {
  const contractKeys = new Set(reviewServingReadContractKeys)
  const readSurfaces = new Set(reviewServingReadSurfaces)
  const mappedContractKeys = [
    ...new Set(
      reviewServingReadContractRouteInventory.flatMap((entry) => {
        return entry.contractKeys
      }),
    ),
  ]
  const unknownContractKeys = mappedContractKeys.filter((contractKey) => {
    return !contractKeys.has(contractKey)
  })
  const missingContractKeys = reviewServingReadContractKeys.filter((contractKey) => {
    return !mappedContractKeys.includes(contractKey)
  })
  const unknownSurfaces = reviewServingReadContractRouteInventory.flatMap((entry) => {
    return entry.surfaces.filter((surface) => {
      return !readSurfaces.has(surface)
    })
  })
  const missingSurfaces = reviewServingReadSurfaces.filter((surface) => {
    return !reviewServingReadContractRouteInventory.some((entry) => {
      return entry.surfaces.includes(surface)
    })
  })
  const missingRoutes = reviewServingReadContractRouteInventory.filter((entry) => {
    return entry.productRoute.length === 0 || entry.routeFile.length === 0
  })

  expect(unknownContractKeys).toEqual([])
  expect(missingContractKeys).toEqual([])
  expect(unknownSurfaces).toEqual([])
  expect(missingSurfaces).toEqual([])
  expect(missingRoutes).toEqual([])
})

test('detail read inventory maps to the mounted project review route', () => {
  const detailInventoryEntries = reviewServingReadContractRouteInventory.filter((entry) => {
    return entry.contractKeys.includes('review.detail.row')
  })

  expect(detailInventoryEntries).toHaveLength(1)
  expect(detailInventoryEntries[0]).toMatchObject({
    contractKeys: [
      'review.detail.row',
      'review.detail.payload',
      'review.detail.judgments',
      'review.detail.humanJudgments',
      'review.prompt.badges',
    ],
    method: 'POST',
    productRoute: '/api/projectsreview',
    routeFile: 'src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts',
  })
})

test('add-articles filter inventory maps to the mounted bulk selection route', () => {
  const addArticlesInventoryEntries = reviewServingReadContractRouteInventory.filter((entry) => {
    return entry.productRoute === '/api/projects/add_articles_by_filter'
  })

  expect(addArticlesInventoryEntries).toHaveLength(1)
  expect(addArticlesInventoryEntries[0]).toMatchObject({
    contractKeys: ['review.bulk.selection'],
    method: 'POST',
    mounted: false,
    routeFile: 'src/server/routes/ProjectsAddArticlesRoutes.ts',
    surfaces: ['bulk', 'filter', 'search'],
  })
})

test('filtered PDF and export inventories stay unmounted until full response coverage is migrated', () => {
  const pdfByProjectEntry = reviewServingReadContractRouteInventory.find((entry) => {
    return entry.productRoute === '/api/articles/pdf-fetch-by-project'
  })
  const exportEntry = reviewServingReadContractRouteInventory.find((entry) => {
    return entry.productRoute === '/api/projects/:id/export'
  })

  expect(pdfByProjectEntry).toMatchObject({mounted: false, surfaces: ['pdf', 'bulk', 'filter', 'search']})
  expect(exportEntry).toMatchObject({mounted: false, surfaces: ['export', 'bulk', 'filter', 'search', 'detail']})
})

test('count read inventory maps to the mounted review count route', () => {
  const countInventoryEntries = reviewServingReadContractRouteInventory.filter((entry) => {
    return entry.productRoute === '/api/articlesreviewscount'
  })

  expect(countInventoryEntries).toHaveLength(1)
  expect(countInventoryEntries[0]).toMatchObject({
    method: 'POST',
    productRoute: '/api/articlesreviewscount',
    routeFile: 'src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsCount.ts',
    contractKeys: [
      'review.llm.count',
      'review.filters.postings',
      'review.search.tokenPrefix',
      'review.search.substringAsync',
    ],
    surfaces: ['count', 'filter', 'search'],
  })
})

test('list read inventory covers total count and inline judgments', () => {
  const listInventoryEntry = reviewServingReadContractRouteInventory.find((entry) => {
    return entry.productRoute === '/api/articlesreviews'
  })

  expect(listInventoryEntry?.contractKeys).toEqual([
    'review.llm.rows',
    'review.llm.count',
    'review.filters.postings',
    'review.prompt.badges',
    'review.detail.judgments',
    'review.search.tokenPrefix',
    'review.search.substringAsync',
  ])
})

test('facet read inventory maps to the mounted review filters route', () => {
  const facetInventoryEntries = reviewServingReadContractRouteInventory.filter((entry) => {
    return entry.contractKeys.includes('review.filters.facets') && entry.productRoute === '/api/articlesreviewsfilters'
  })

  expect(facetInventoryEntries).toHaveLength(1)
  expect(facetInventoryEntries[0]).toMatchObject({
    contractKeys: [
      'review.filters.facets',
      'review.filters.options',
      'review.search.tokenPrefix',
      'review.search.substringAsync',
    ],
    method: 'GET',
    productRoute: '/api/articlesreviewsfilters',
    routeFile: 'src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsFilters.ts',
  })
})

test('human facet read inventory maps to the mounted human review filters route', () => {
  const humanFacetInventoryEntries = reviewServingReadContractRouteInventory.filter((entry) => {
    return (
      entry.contractKeys.includes('review.human.filters.facets')
      && entry.productRoute === '/api/articlesreviewshumanfilters'
    )
  })

  expect(humanFacetInventoryEntries).toHaveLength(1)
  expect(humanFacetInventoryEntries[0]).toMatchObject({
    contractKeys: [
      'review.human.filters.facets',
      'review.human.filters.options',
      'review.search.tokenPrefix',
      'review.search.substringAsync',
    ],
    method: 'GET',
    productRoute: '/api/articlesreviewshumanfilters',
    routeFile: 'src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHumanFilters.ts',
  })
})

test('warning read inventory maps to the mounted project warnings route', () => {
  const warningInventoryEntries = reviewServingReadContractRouteInventory.filter((entry) => {
    return entry.contractKeys.includes('review.warning.snapshot')
  })

  expect(warningInventoryEntries).toHaveLength(1)
  expect(warningInventoryEntries[0]).toMatchObject({
    method: 'POST',
    productRoute: '/api/projectsreviewswarnings',
    routeFile: 'src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts',
  })
})
