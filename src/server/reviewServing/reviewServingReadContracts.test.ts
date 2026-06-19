import {expect, test} from 'bun:test'
import {readFile} from 'fs/promises'

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
  expect(llmRows?.maxPageSize).toBe(500)
  expect(humanRows?.servingTable).toBe('mart.review_article_serving_v4')
  expect(humanRows?.maxPageSize).toBe(500)
  expect(bothRows?.requiredComponents).toContain('humanStatus')
  expect(bothRows?.requiredComponents).toContain('llmStatus')
  expect(bothRows?.maxPageSize).toBe(500)
})

test('direct ordered row contracts advertise only migrated route filters', () => {
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
    [
      'review.llm.rows',
      [
        'duplicateFlag',
        'importRoute',
        'publicationYear',
        'articleCreatedAtFrom',
        'articleCreatedAtTo',
        'searchTokenPrefix',
        'conflictFlag',
        'llmStatus',
        'promptAnswer',
      ],
      ['search'],
      'tokenPrefix',
      ['sort_key DESC', 'article_id ASC'],
      ['sort_key', 'article_id ASC'],
    ],
    [
      'review.human.rows',
      [
        'duplicateFlag',
        'importRoute',
        'publicationYear',
        'articleCreatedAtFrom',
        'articleCreatedAtTo',
        'searchTokenPrefix',
        'conflictFlag',
        'humanStatus',
        'promptAnswer',
      ],
      ['search'],
      'tokenPrefix',
      ['sort_key DESC', 'article_id ASC'],
      ['sort_key', 'article_id ASC'],
    ],
    [
      'review.both.rows',
      [
        'duplicateFlag',
        'importRoute',
        'publicationYear',
        'articleCreatedAtFrom',
        'articleCreatedAtTo',
        'searchTokenPrefix',
        'conflictFlag',
        'humanStatus',
        'llmStatus',
        'promptAnswer',
      ],
      ['search'],
      'tokenPrefix',
      ['sort_key DESC', 'article_id ASC'],
      ['sort_key', 'article_id ASC'],
    ],
    [
      'review.unassessed.rows',
      [
        'duplicateFlag',
        'importRoute',
        'publicationYear',
        'articleCreatedAtFrom',
        'articleCreatedAtTo',
        'searchTokenPrefix',
        'conflictFlag',
        'queueKind',
      ],
      ['search'],
      'tokenPrefix',
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
  expect(detailJudgments?.requiredComponents).toContain('payload')
  expect(detailJudgments?.sort.fields).toEqual([
    "CASE list_mode_key WHEN 'both' THEN 0 WHEN 'llm' THEN 1 WHEN 'human' THEN 2 WHEN 'unassessed' THEN 3 ELSE 4 END",
    'prompt_order ASC NULLS LAST',
    'prompt_id',
  ])
})

test('migrated review count contracts advertise searched-count filter signatures', () => {
  const countContracts = reviewServingReadContractList.filter((contract) => {
    return contract.workloadClass === 'foregroundReviewCount'
  })

  expect(
    countContracts.map((contract) => {
      return [contract.key, contract.searchMode, contract.allowedFilters.includes('searchTokenPrefix')]
    }),
  ).toEqual([
    ['review.llm.count', 'none', true],
    ['review.human.count', 'none', true],
    ['review.both.count', 'none', true],
    ['review.unassessed.count', 'none', true],
    ['review.prompt.badges', 'none', false],
  ])
})

test('count contracts include shared conflict filter scope', () => {
  const countContracts = [
    getReviewServingReadContract('review.llm.count'),
    getReviewServingReadContract('review.human.count'),
    getReviewServingReadContract('review.both.count'),
    getReviewServingReadContract('review.unassessed.count'),
  ]

  expect(
    countContracts.map((contract) => {
      return [contract?.key, contract?.allowedFilters.includes('conflictFlag')]
    }),
  ).toEqual([
    ['review.llm.count', true],
    ['review.human.count', true],
    ['review.both.count', true],
    ['review.unassessed.count', true],
  ])
})

test('queue and count contracts use physical serving-table sort columns', () => {
  const queue = getReviewServingReadContract('review.queue.unassessed')
  const count = getReviewServingReadContract('review.llm.count')
  const badges = getReviewServingReadContract('review.prompt.badges')

  expect(queue?.cursorFields).toEqual([
    'priority_bucket',
    'activity_sort_at',
    'article_id',
    'prompt_id',
    'queue_identity',
  ])
  expect(queue?.sort.fields).toEqual([
    'priority_bucket',
    'activity_sort_at',
    'article_id',
    'prompt_id',
    'queue_identity',
  ])
  expect(queue?.sort.direction).toBe('desc')
  expect(count?.sort.fields).toEqual(['list_mode_key', 'count_kind', 'summary_definition_version', 'filter_key'])
  expect(badges?.sort.fields).toEqual(['list_mode_key', 'count_kind', 'summary_definition_version', 'filter_key'])
})

test('job criteria contracts use job-table cursor and sort columns', () => {
  const jobContracts = [
    getReviewServingReadContract('review.bulk.selection'),
    getReviewServingReadContract('review.bulk.substringSelection'),
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
    ['updated_at', 'job_id'],
  ])
  expect(
    jobContracts.map((contract) => {
      return contract?.maxResultRows
    }),
  ).toEqual([1, 1, 1, 1, 1])
})

test('human filter facets use a dedicated contract', () => {
  const reviewFacets = getReviewServingReadContract('review.filters.facets')
  const humanFacets = getReviewServingReadContract('review.human.filters.facets')
  const humanOptions = getReviewServingReadContract('review.human.filters.options')

  expect(reviewFacets?.key).toBe('review.filters.facets')
  expect(reviewFacets?.allowedFilters).toContain('searchTokenPrefix')
  expect(reviewFacets?.optionalComponents).toEqual(['search'])
  expect(reviewFacets?.searchMode).toBe('tokenPrefix')
  expect(humanFacets?.servingTable).toBe('mart.review_filter_facet_serving_v4')
  expect(humanFacets?.requiredComponents).toEqual([
    'display',
    'humanStatus',
    'posting',
    'projectScope',
    'selectedImport',
    'summary',
  ])
  const humanArticleScopeFilters = [
    'articleCreatedAtFrom',
    'articleCreatedAtTo',
    'conflictFlag',
    'duplicateFlag',
    'humanStatus',
    'importRoute',
    'promptAnswer',
    'publicationYear',
    'searchTokenPrefix',
  ] as const

  expect(humanFacets?.allowedFilters).toEqual(humanArticleScopeFilters)
  expect(humanOptions?.allowedFilters).toEqual(humanArticleScopeFilters)
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
  expect(humanFacets?.optionalComponents).toEqual(['search'])
  expect(humanFacets?.searchMode).toBe('tokenPrefix')
})

test('human payload contracts cover list and detail response judgments', () => {
  const llmListJudgments = getReviewServingReadContract('review.llm.list.judgments')
  const humanListJudgments = getReviewServingReadContract('review.human.list.judgments')
  const bothListJudgments = getReviewServingReadContract('review.both.list.judgments')
  const bothListHumanJudgments = getReviewServingReadContract('review.both.list.humanJudgments')
  const detailHumanJudgments = getReviewServingReadContract('review.detail.humanJudgments')

  expect(llmListJudgments?.requiredComponents).toEqual(['llmStatus', 'summary', 'payload'])
  expect(humanListJudgments?.requiredComponents).toEqual(['humanStatus', 'summary', 'payload'])
  expect(bothListJudgments?.requiredComponents).toEqual(['llmStatus', 'humanStatus', 'summary', 'payload'])
  expect(bothListHumanJudgments?.requiredComponents).toEqual(['llmStatus', 'humanStatus', 'summary', 'payload'])
  expect(detailHumanJudgments?.requiredComponents).toEqual(['humanStatus', 'summary', 'payload'])
  expect(llmListJudgments?.physicalAccessStrategy).toBe('articleSetLookup')
  expect(humanListJudgments?.physicalAccessStrategy).toBe('articleSetLookup')
  expect(bothListJudgments?.physicalAccessStrategy).toBe('articleSetLookup')
  expect(bothListHumanJudgments?.physicalAccessStrategy).toBe('articleSetLookup')
  expect(llmListJudgments?.servingTable).toBe('mart.review_article_judgment_detail_serving_v4')
  expect(humanListJudgments?.servingTable).toBe('mart.review_article_judgment_detail_serving_v4')
  expect(bothListJudgments?.servingTable).toBe('mart.review_article_judgment_detail_serving_v4')
  expect(bothListHumanJudgments?.servingTable).toBe('mart.review_article_judgment_detail_serving_v4')
  expect(detailHumanJudgments?.servingTable).toBe('mart.review_article_judgment_detail_serving_v4')
})

test('review serving contracts represent article-created date ranges explicitly', () => {
  const contracts = [
    getReviewServingReadContract('review.llm.count'),
    getReviewServingReadContract('review.filters.postings'),
    getReviewServingReadContract('review.filters.options'),
    getReviewServingReadContract('review.bulk.selection'),
    getReviewServingReadContract('review.bulk.substringSelection'),
    getReviewServingReadContract('review.export.selection'),
    getReviewServingReadContract('review.pdf.selection'),
  ]

  expect(
    contracts.map((contract) => {
      return [
        contract?.key,
        contract?.allowedFilters.includes('articleCreatedAtFrom'),
        contract?.allowedFilters.includes('articleCreatedAtTo'),
      ]
    }),
  ).toEqual([
    ['review.llm.count', true, true],
    ['review.filters.postings', true, true],
    ['review.filters.options', true, true],
    ['review.bulk.selection', true, true],
    ['review.bulk.substringSelection', true, true],
    ['review.export.selection', true, true],
    ['review.pdf.selection', true, true],
  ])
})

test('filtered row routes have article-set hydration contracts', () => {
  const rowSetContracts = [
    getReviewServingReadContract('review.llm.rowsByArticleSet'),
    getReviewServingReadContract('review.human.rowsByArticleSet'),
    getReviewServingReadContract('review.both.rowsByArticleSet'),
    getReviewServingReadContract('review.unassessed.rowsByArticleSet'),
  ]

  expect(
    rowSetContracts.map((contract) => {
      return [contract?.listMode, contract?.physicalAccessStrategy, contract?.allowedFilters]
    }),
  ).toEqual([
    [
      'llm',
      'articleSetLookup',
      [
        'duplicateFlag',
        'importRoute',
        'publicationYear',
        'articleCreatedAtFrom',
        'articleCreatedAtTo',
        'searchTokenPrefix',
        'articleId',
        'conflictFlag',
        'llmStatus',
        'promptAnswer',
      ],
    ],
    [
      'human',
      'articleSetLookup',
      [
        'duplicateFlag',
        'importRoute',
        'publicationYear',
        'articleCreatedAtFrom',
        'articleCreatedAtTo',
        'searchTokenPrefix',
        'articleId',
        'conflictFlag',
        'humanStatus',
        'promptAnswer',
      ],
    ],
    [
      'both',
      'articleSetLookup',
      [
        'duplicateFlag',
        'importRoute',
        'publicationYear',
        'articleCreatedAtFrom',
        'articleCreatedAtTo',
        'searchTokenPrefix',
        'articleId',
        'conflictFlag',
        'humanStatus',
        'llmStatus',
        'promptAnswer',
      ],
    ],
    [
      'unassessed',
      'articleSetLookup',
      [
        'duplicateFlag',
        'importRoute',
        'publicationYear',
        'articleCreatedAtFrom',
        'articleCreatedAtTo',
        'searchTokenPrefix',
        'articleId',
        'conflictFlag',
        'queueKind',
      ],
    ],
  ])
})

test('search contracts require project scope without blocking async substring on search readiness', () => {
  const tokenPrefix = getReviewServingReadContract('review.search.tokenPrefix')
  const substringAsync = getReviewServingReadContract('review.search.substringAsync')

  expect(tokenPrefix?.requiredComponents).toEqual(['projectScope', 'search'])
  expect(substringAsync?.requiredComponents).toEqual(['projectScope'])
  expect(substringAsync?.optionalComponents).toEqual(['search'])
})

test('bulk add selection models substring search as an async job', () => {
  const tokenPrefixSelection = getReviewServingReadContract('review.bulk.selection')
  const substringSelection = getReviewServingReadContract('review.bulk.substringSelection')

  expect(tokenPrefixSelection?.searchMode).toBe('tokenPrefix')
  expect(substringSelection?.searchMode).toBe('substringAsync')
  expect(substringSelection?.freshnessBehavior).toBe('asyncUnavailable')
  expect(substringSelection?.optionalComponents).toEqual(['search'])
  expect(substringSelection?.allowedFilters).toContain('searchTokenPrefix')
})

test('snapshot contracts align cursor fields with sort keys and required counts', () => {
  const health = getReviewServingReadContract('review.health.snapshot')
  const warning = getReviewServingReadContract('review.warning.snapshot')

  expect(health?.cursorFields).toEqual(['updated_at', 'snapshot_id'])
  expect(warning?.cursorFields).toEqual(['updated_at', 'snapshot_id'])
  expect(warning?.requiredComponents).toContain('queue')
  expect(warning?.optionalComponents).not.toContain('queue')
})

test('US-017 migrated review route inventory rows are mounted or explicitly internal', () => {
  const expectedMountedProductRoutes: string[] = [
    '/api/articlesreviews',
    '/api/articlesreviewscount',
    '/api/articlesreviewshuman',
    '/api/articlesreviewsboth',
    '/api/articlesreviewsunassessed',
    '/api/articlesreviewsfilters',
    '/api/articlesreviewshumanfilters',
    '/api/projectsreview',
    '/api/projectsreviewswarnings',
    '/api/projectsreviewshealth',
    '/api/projects/:id/prompts/:promptId/preview',
    '/api/articles/pdf-fetch-by-filter',
    '/api/projects/add_articles_by_filter',
    '/api/articles/pdf-fetch-by-project',
    '/api/articles/pdf-fetch-bulk',
    '/api/projects/:id/export',
  ]
  const mountedRoutes: string[] = reviewServingReadContractRouteInventory.flatMap((entry) => {
    return entry.mounted ? [entry.productRoute] : []
  })
  const unmountedProductRoutes = reviewServingReadContractRouteInventory.flatMap((entry) => {
    return entry.mounted || entry.productRoute.startsWith('/api/review-serving/') ? [] : [entry.productRoute]
  })

  expect(mountedRoutes).toEqual(expectedMountedProductRoutes)
  expect(unmountedProductRoutes).toEqual([])
})

test('explicit PDF bulk ID route maps to mounted PDF job selection without project-scoped filter surfaces', () => {
  const explicitBulkPdfRoutes = reviewServingReadContractRouteInventory.filter((entry) => {
    return entry.productRoute === '/api/articles/pdf-fetch-bulk'
  })

  expect(explicitBulkPdfRoutes).toEqual([
    {
      contractKeys: ['review.pdf.selection'],
      method: 'POST',
      mounted: true,
      productRoute: '/api/articles/pdf-fetch-bulk',
      routeFile: 'src/server/routes/ArticlesRoutes.ts',
      surfaces: ['pdf', 'bulk'],
    },
  ])
})

test('migrated filter posting and facet contracts are mounted for production routes', () => {
  const postingInventoryEntries = reviewServingReadContractRouteInventory.filter((entry) => {
    return (entry.contractKeys as readonly string[]).includes('review.filters.postings')
  })
  const facetInventoryEntries = reviewServingReadContractRouteInventory.filter((entry) => {
    return (
      (entry.contractKeys as readonly string[]).includes('review.filters.facets')
      || (entry.contractKeys as readonly string[]).includes('review.human.filters.facets')
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
    ['/api/articlesreviews', true],
    ['/api/articlesreviewscount', true],
    ['/api/articlesreviewshuman', true],
    ['/api/articlesreviewsboth', true],
    ['/api/articlesreviewsunassessed', true],
    ['/api/review-serving/filter-postings', false],
  ])
  expect(facetInventoryEntries).toHaveLength(2)
  expect(
    facetInventoryEntries.map((entry) => {
      return entry.mounted
    }),
  ).toEqual([true, true])
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
      const hasRowSetContract = entry.contractKeys.some((contractKey) => {
        return contractKey.endsWith('.rowsByArticleSet')
      })

      return [
        entry.productRoute,
        (entry.contractKeys as readonly string[]).includes('review.filters.postings'),
        hasRowSetContract,
        entry.surfaces,
      ]
    }),
  ).toEqual([
    ['/api/articlesreviews', true, true, ['llm', 'row', 'count', 'badge', 'filter', 'search']],
    ['/api/articlesreviewshuman', true, true, ['human', 'row', 'count', 'filter', 'search']],
    ['/api/articlesreviewsboth', true, true, ['both', 'row', 'count', 'filter', 'search']],
    ['/api/articlesreviewsunassessed', true, true, ['unassessed', 'row', 'count', 'queue', 'filter', 'search']],
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
      return (entry.surfaces as readonly string[]).includes(surface)
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

test('US-017 mounted migrated route files stay behind serving and job seams', async () => {
  const migratedRouteFiles = [
    ...new Set(
      reviewServingReadContractRouteInventory.flatMap((entry) => {
        return entry.mounted ? [entry.routeFile] : []
      }),
    ),
  ]
  const routeSources = await Promise.all(
    migratedRouteFiles.map(async (routeFile) => {
      return [routeFile, await readFile(routeFile, 'utf8')] as const
    }),
  )
  const forbiddenPatterns = [
    /runDuckdbJsonQuery/,
    /selected_scoped_article_import/,
    /articlesReviewsOlap/,
    /articlesReviewsBothOlap/,
    /articlesReviewsFiltersOlap/,
    /unassessedArticlesOlap/,
    /selectArticleIdsOlap/,
    /duckdbOlap/,
    /decodeReviewServingCursor/,
    /buildReviewServingFilterSignature/,
    /getReviewServingFilterSignature/,
    /raw fallback/i,
    /\bOFFSET\b/i,
  ]
  const violations = routeSources.flatMap(([routeFile, source]) => {
    return forbiddenPatterns.flatMap((pattern) => {
      return pattern.test(source) ? [`${routeFile}: ${pattern.source}`] : []
    })
  })

  expect(violations).toEqual([])
})

test('detail read inventory maps to the mounted project review route', () => {
  const detailInventoryEntries = reviewServingReadContractRouteInventory.filter((entry) => {
    return (entry.contractKeys as readonly string[]).includes('review.detail.row')
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
    contractKeys: ['review.bulk.substringSelection'],
    method: 'POST',
    mounted: true,
    routeFile: 'src/server/routes/ProjectsAddArticlesRoutes.ts',
    surfaces: ['bulk', 'filter', 'search'],
  })
})

test('filtered PDF and export inventories map to mounted job routes', () => {
  const pdfByProjectEntry = reviewServingReadContractRouteInventory.find((entry) => {
    return entry.productRoute === '/api/articles/pdf-fetch-by-project'
  })
  const pdfByFilterEntry = reviewServingReadContractRouteInventory.find((entry) => {
    return entry.productRoute === '/api/articles/pdf-fetch-by-filter'
  })
  const exportEntry = reviewServingReadContractRouteInventory.find((entry) => {
    return entry.productRoute === '/api/projects/:id/export'
  })

  expect(pdfByFilterEntry).toMatchObject({mounted: true, surfaces: ['bulk', 'pdf', 'filter', 'search']})
  expect(pdfByProjectEntry).toMatchObject({mounted: true, surfaces: ['pdf', 'bulk', 'filter', 'search']})
  expect(exportEntry).toMatchObject({mounted: true, surfaces: ['export', 'bulk', 'filter', 'search', 'detail']})
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
    'review.llm.rowsByArticleSet',
    'review.llm.count',
    'review.filters.postings',
    'review.prompt.badges',
    'review.llm.list.judgments',
    'review.search.tokenPrefix',
    'review.search.substringAsync',
  ])
})

test('both-list inventory covers LLM and human judgment payloads', () => {
  const bothListInventoryEntry = reviewServingReadContractRouteInventory.find((entry) => {
    return entry.productRoute === '/api/articlesreviewsboth'
  })

  expect(bothListInventoryEntry?.contractKeys).toEqual([
    'review.both.rows',
    'review.both.rowsByArticleSet',
    'review.both.list.judgments',
    'review.both.list.humanJudgments',
    'review.filters.postings',
    'review.both.count',
    'review.search.tokenPrefix',
    'review.search.substringAsync',
  ])
})

test('facet read inventory maps to the mounted review filters route', () => {
  const facetInventoryEntries = reviewServingReadContractRouteInventory.filter((entry) => {
    return (
      (entry.contractKeys as readonly string[]).includes('review.filters.facets')
      && entry.productRoute === '/api/articlesreviewsfilters'
    )
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
      (entry.contractKeys as readonly string[]).includes('review.human.filters.facets')
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
    return (entry.contractKeys as readonly string[]).includes('review.warning.snapshot')
  })

  expect(warningInventoryEntries).toHaveLength(1)
  expect(warningInventoryEntries[0]).toMatchObject({
    method: 'POST',
    mounted: true,
    productRoute: '/api/projectsreviewswarnings',
    routeFile: 'src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts',
  })
})

test('health and prompt preview inventories map only to mounted product routes', () => {
  const healthInventoryEntries = reviewServingReadContractRouteInventory.filter((entry) => {
    return (entry.contractKeys as readonly string[]).includes('review.health.snapshot')
  })
  const previewInventoryEntries = reviewServingReadContractRouteInventory.filter((entry) => {
    return (entry.contractKeys as readonly string[]).includes('review.prompt.preview')
  })

  expect(healthInventoryEntries).toHaveLength(1)
  expect(healthInventoryEntries[0]).toMatchObject({
    method: 'POST',
    mounted: true,
    productRoute: '/api/projectsreviewshealth',
    routeFile: 'src/server/routes/projectsRoutes/projectsRoutesGetReviewsHealth.ts',
    surfaces: ['health'],
  })
  expect(previewInventoryEntries).toHaveLength(1)
  expect(previewInventoryEntries[0]).toMatchObject({
    method: 'GET',
    mounted: true,
    productRoute: '/api/projects/:id/prompts/:promptId/preview',
    routeFile: 'src/server/routes/projectsRoutes/projectsRoutesGetPromptPreview.ts',
    surfaces: ['promptPreview', 'detail'],
  })
})
