import {expect, test} from 'bun:test'

import {type ReviewServingDirtyWorkClaim} from './reviewServingDirtyWorkService.ts'
import {
  getReviewServingFilterOptionIdentity,
  projectReviewServingFilterOptions,
  type ReviewServingFilterOptionProjectorDatabase,
} from './reviewServingFilterOptionProjector.ts'
import {createReviewServingManifestTestStore} from './reviewServingManifestTestStore.ts'

const optionClaim = (input?: Partial<ReviewServingDirtyWorkClaim>): ReviewServingDirtyWorkClaim => {
  return {
    articleId: 'article-1',
    dirtyKind: 'judgment.llm.updated',
    dirtyRangeEnd: null,
    dirtyRangeStart: null,
    dirtyWorkId: 'dirty-work-1',
    firstSourceHighWaterMark: 10,
    latestDeltaId: 'delta-1',
    latestSourceHighWaterMark: 12,
    projectId: 'project-1',
    projectionComponent: 'summary',
    projectionIdentity: 'filter-option:identity-1',
    scopeId: 'project-1:article-1',
    scopeKind: 'article',
    sourcePartition: 'review-filter-option:article-1',
    status: 'running',
    ...input,
  }
}

const projectInput = (input?: {
  claims?: readonly ReviewServingDirtyWorkClaim[]
  filterOptionIdentity?: string
  listModeKeys?: readonly string[]
  optionMode?: 'human' | 'review'
  searchIdentity?: string
  searchTitle?: string | null
}) => {
  return {
    claims: input?.claims ?? [optionClaim()],
    baseGeneration: 5,
    definitionVersion: 'summary-v1-test',
    displayIdentity: 'display:identity-1',
    filterOptionIdentity: input?.filterOptionIdentity ?? 'filter-option:identity-1',
    listModeKeys: input?.listModeKeys ?? ['llm'],
    optionMode: input?.optionMode ?? 'review',
    payloadIdentity: 'payload:identity-1',
    projectId: 'project-1',
    projectScopeIdentity: 'projectScope:identity-1',
    projectionIdentity: 'filter-option:identity-1',
    reviewConfigHash: 'review-config-1',
    searchIdentity: input?.searchIdentity ?? 'search:none',
    searchTitle: input?.searchTitle,
    selectedImportSnapshotId: 'selected-import-snapshot-1',
    snapshotId: 'snapshot-1',
  }
}

const sourceRow = (input?: Record<string, unknown>) => {
  return {
    answerId: null,
    countValue: 3,
    facetKey: 'promptAnswer',
    facetValue: 'yes',
    filterKind: 'review',
    numericMax: null,
    numericMin: null,
    optionValueKey: 'review:promptAnswer:prompt-1:yes',
    promptId: 'prompt-1',
    ...input,
  }
}

const createFilterOptionDatabase = (input?: {sourceRows?: readonly Record<string, unknown>[]}) => {
  const manifestStore = createReviewServingManifestTestStore()
  const statements: string[] = []
  const database: ReviewServingFilterOptionProjectorDatabase = {
    queryJson: async <T>(statement: string) => {
      statements.push(statement)

      const manifestResult = manifestStore.getQueryResult<T>(statement)

      if (manifestResult !== null) {
        return manifestResult
      }

      if (statement.includes('finalized_facet_options') || statement.includes('review_facet_options')) {
        return (input?.sourceRows ?? []) as T[]
      }

      return [] as T[]
    },
    run: async (statement: string) => {
      statements.push(statement)
      manifestStore.run(statement)
    },
    transaction: async (operation) => {
      return operation(database)
    },
  }

  return {database, statements}
}

const hasOptionValue = (rows: readonly Record<string, unknown>[], expected: Record<string, unknown>) => {
  return rows.some((row) => {
    return Object.entries(expected).every(([key, value]) => {
      return row[key] === value
    })
  })
}

const countOccurrences = (value: string, search: string) => {
  return value.split(search).length - 1
}

test('projects supported enum option payloads into scoped option rows', async () => {
  const {database, statements} = createFilterOptionDatabase({sourceRows: [sourceRow()]})

  const result = await projectReviewServingFilterOptions(projectInput(), database)
  const joined = statements.join('\n')

  expect(result.optionRowCount).toBe(1)
  expect(
    hasOptionValue(result.optionValues, {
      count_value: 3,
      facet_key: 'promptAnswer',
      facet_value: 'yes',
      filter_kind: 'review',
      option_value_key: 'review:promptAnswer:prompt-1:yes',
      prompt_id: 'prompt-1',
    }),
  ).toBe(true)
  expect(joined).toContain('DELETE FROM mart.review_filter_option_serving_v4')
  expect(joined).toContain('INSERT INTO mart.review_filter_option_serving_v4')
  expect(joined).not.toContain('UPDATE mart.review_filter_option_serving_v4')
  expect(joined.indexOf('INSERT INTO mart.review_filter_option_serving_v4')).toBeLessThan(
    joined.indexOf('INSERT INTO app.review_projection_identity_manifest'),
  )
  const insertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_filter_option_serving_v4')
  })
  expect(insertStatement).not.toContain('WHERE NOT EXISTS')
  expect(joined).not.toContain('numericPromptAnswer')
  expect(joined).not.toContain('numeric_options')
})

test('no-search option projection reuses finalized facet rows for migrated facet option identities', async () => {
  const {database, statements} = createFilterOptionDatabase({
    sourceRows: [
      sourceRow({
        countValue: 4,
        facetKey: 'duplicateFlag',
        facetValue: 'false',
        optionValueKey: 'review:duplicateFlag:false',
        promptId: null,
      }),
      sourceRow({
        countValue: 2,
        facetKey: 'publicationYear',
        facetValue: '2026',
        optionValueKey: 'review:publicationYear:2026',
        promptId: null,
      }),
      sourceRow(),
    ],
  })

  const result = await projectReviewServingFilterOptions(projectInput(), database)
  const finalizedFacetStatement = statements.find((statement) => {
    return statement.includes('finalized_facet_options')
  })
  const fallbackStatement = statements.find((statement) => {
    return statement.includes('option_specific_options')
  })

  expect(result.optionRowCount).toBe(3)
  expect(finalizedFacetStatement).toContain('FROM mart.review_filter_facet_serving_v4 facet')
  expect(finalizedFacetStatement).toContain("'review.filter.duplicateFlag'")
  expect(finalizedFacetStatement).toContain("'review.filter.importRoute'")
  expect(finalizedFacetStatement).toContain("'review.filter.promptAnswer'")
  expect(finalizedFacetStatement).toContain("'review.filter.publicationYear'")
  expect(finalizedFacetStatement).toContain('summary_identity_filter(summary_identity, summary_definition_version)')
  expect(finalizedFacetStatement).toContain(
    'summary_identity.summary_definition_version = facet.summary_definition_version',
  )
  expect(finalizedFacetStatement).toContain("facet.availability = 'ready'")
  expect(finalizedFacetStatement).not.toContain('mart.review_article_serving_payload_v4')
  expect(finalizedFacetStatement).not.toContain('mart.review_article_judgment_detail_serving_v4')
  expect(fallbackStatement).toContain("'conflictFlag' AS facetKey")
  expect(fallbackStatement).toContain("'llmStatus' AS facetKey")
  expect(fallbackStatement).toContain("'humanStatus' AS facetKey")
  expect(fallbackStatement).toContain('scoped_selected_article AS')
  expect(fallbackStatement).toContain('FROM mart.review_article_serving_base_v4 serving')
  expect(fallbackStatement).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
  expect(fallbackStatement).toContain('INNER JOIN list_mode_key_filter list_mode_key_filter ON TRUE')
  expect(fallbackStatement).toContain("('llm', list_mode_state.has_llm_list_mode)")
  expect(fallbackStatement).toContain("('human', list_mode_state.has_human_list_mode)")
  expect(fallbackStatement).toContain("('both', list_mode_state.has_both_list_mode)")
  expect(fallbackStatement).toContain("('unassessed', list_mode_state.has_unassessed_list_mode)")
  expect(fallbackStatement).toContain('list_mode_key_filter.list_mode_key = list_mode_key.list_mode_key')
  expect(fallbackStatement).toContain('list_mode_key.has_list_mode IS TRUE')
  expect(fallbackStatement).not.toContain('list_contains(list_mode_state.list_mode_keys')
  expect(countOccurrences(fallbackStatement ?? '', 'FROM mart.review_article_serving_base_v4 serving')).toBe(1)
  expect(countOccurrences(fallbackStatement ?? '', 'INNER JOIN mart.review_article_serving_list_mode_state_v4')).toBe(1)
  expect(fallbackStatement).not.toContain('FROM mart.review_article_serving_v4 serving')
  expect(fallbackStatement).toContain('selected.llm_status IS NOT NULL')
  expect(fallbackStatement).toContain('selected.human_status IS NOT NULL')
  expect(fallbackStatement).toContain("concat('review:llmStatus:', selected.llm_status)")
  expect(fallbackStatement).toContain("concat('review', ':humanStatus:', selected.human_status)")
  expect(fallbackStatement).toContain('COUNT(DISTINCT selected.article_id) AS countValue')
  expect(fallbackStatement).toContain('COALESCE(list_mode_state.conflict_flag, FALSE) AS conflict_flag')
  expect(fallbackStatement).not.toContain('selected.import_route_id')
  expect(fallbackStatement).not.toContain('selected.publication_year')
  expect(fallbackStatement).not.toContain('LEFT JOIN app.review_selected_article_import_v4')
  expect(fallbackStatement).not.toContain('LEFT JOIN app.review_import_article_hot_field')
  expect(fallbackStatement).not.toContain('active_article AS')
  expect(fallbackStatement).not.toContain('\n        selected_article AS')
  expect(fallbackStatement).not.toContain('serving.llm_status_key')
  expect(fallbackStatement).not.toContain('serving.human_status_key')
  expect(fallbackStatement).not.toContain('answered_original')
})

test('filter-option no-ack snapshot passes do not publish shared manifests or watermarks', async () => {
  const {database, statements} = createFilterOptionDatabase({sourceRows: [sourceRow()]})

  await projectReviewServingFilterOptions({...projectInput(), acknowledgeClaims: false}, database)
  const joined = statements.join('\n')

  expect(joined).not.toContain('INSERT INTO app.review_projection_identity_manifest')
  expect(joined).not.toContain('INSERT INTO app.review_serving_projector_watermark')
  expect(joined).not.toContain('INSERT INTO app.review_serving_dirty_work_ack')
})

test('filter option refresh can insert rows idempotently without deleting existing scoped options', async () => {
  const {database, statements} = createFilterOptionDatabase({sourceRows: [sourceRow()]})

  const result = await projectReviewServingFilterOptions({...projectInput(), deleteExisting: false}, database)
  const joined = statements.join('\n')
  const insertStatement = statements.find((statement) => {
    return statement.includes('INSERT INTO mart.review_filter_option_serving_v4')
  })

  expect(result.optionRowCount).toBe(1)
  expect(joined).not.toContain('DELETE FROM mart.review_filter_option_serving_v4')
  expect(insertStatement).toBeDefined()
  expect(insertStatement).not.toContain('ON CONFLICT')
  expect(insertStatement).not.toContain('DO UPDATE SET')
  expect(insertStatement).not.toContain('count_value = excluded.count_value')
  expect(insertStatement).not.toContain('option_payload_json')
  expect(insertStatement).not.toContain('option_updated_at')
  expect(insertStatement).toContain('WHERE NOT EXISTS')
})

test('source query preserves active search and filter scope without using posting rows as response rows', async () => {
  const {database, statements} = createFilterOptionDatabase({sourceRows: [sourceRow()]})

  await projectReviewServingFilterOptions(
    projectInput({
      filterOptionIdentity: 'identity:search',
      listModeKeys: ['llm', 'human'],
      searchIdentity: 'search:title',
      searchTitle: 'heart',
    }),
    database,
  )
  const sourceStatement = statements.find((statement) => {
    return statement.includes('scoped_selected_article')
  })
  const joined = statements.join('\n')

  expect(sourceStatement).toContain('scoped_selected_article AS')
  expect(sourceStatement).toContain('mart.review_article_serving_base_v4 serving')
  expect(sourceStatement).toContain('INNER JOIN mart.review_article_serving_list_mode_state_v4 list_mode_state')
  expect(sourceStatement).toContain('INNER JOIN list_mode_key_filter list_mode_key_filter ON TRUE')
  expect(sourceStatement).toContain("('llm', list_mode_state.has_llm_list_mode)")
  expect(sourceStatement).toContain("('human', list_mode_state.has_human_list_mode)")
  expect(sourceStatement).toContain("('both', list_mode_state.has_both_list_mode)")
  expect(sourceStatement).toContain("('unassessed', list_mode_state.has_unassessed_list_mode)")
  expect(sourceStatement).toContain('list_mode_key_filter.list_mode_key = list_mode_key.list_mode_key')
  expect(sourceStatement).toContain('list_mode_key.has_list_mode IS TRUE')
  expect(sourceStatement).not.toContain('list_contains(list_mode_state.list_mode_keys')
  expect(countOccurrences(sourceStatement ?? '', 'FROM mart.review_article_serving_base_v4 serving')).toBe(1)
  expect(countOccurrences(sourceStatement ?? '', 'INNER JOIN mart.review_article_serving_list_mode_state_v4')).toBe(1)
  expect(sourceStatement).not.toContain('FROM mart.review_article_serving_v4 serving')
  expect(sourceStatement).not.toContain('INNER JOIN mart.review_article_serving_payload_v4 payload')
  expect(sourceStatement).not.toContain("payload.display_identity = 'display:identity-1'")
  expect(sourceStatement).not.toContain("payload.payload_identity = 'payload:identity-1'")
  expect(sourceStatement).toContain('LEFT JOIN app.article article')
  expect(sourceStatement).toContain('LEFT JOIN app.review_selected_article_import_v4 selected_base')
  expect(sourceStatement).toContain('LEFT JOIN app.review_import_article_hot_field selected_hot')
  expect(sourceStatement).toContain(
    "COALESCE(COALESCE(CASE WHEN NOT COALESCE(selected_base.tombstone, FALSE) THEN selected_hot.article_title ELSE NULL END, article.article_title), '')",
  )
  expect(sourceStatement).toContain("LIKE LOWER('%heart%')")
  expect(sourceStatement).toContain("('llm'), ('human')")
  expect(sourceStatement).toContain('mart.review_article_judgment_detail_serving_v4 detail')
  expect(sourceStatement).toContain(
    "'duplicateFlag' AS facetKey, CAST(selected.duplicate_flag AS VARCHAR) AS facetValue",
  )
  expect(sourceStatement).toContain("'conflictFlag' AS facetKey, CAST(selected.conflict_flag AS VARCHAR) AS facetValue")
  expect(sourceStatement).toContain('COALESCE(list_mode_state.duplicate_flag, FALSE)')
  expect(sourceStatement).toContain('COALESCE(list_mode_state.conflict_flag, FALSE)')
  expect(sourceStatement).toContain(
    'CASE WHEN COALESCE(selected_base.tombstone, FALSE) THEN NULL ELSE selected_hot.publication_year END AS publication_year',
  )
  expect(sourceStatement).toContain("'importRoute' AS facetKey, selected.import_route_id AS facetValue")
  expect(sourceStatement).toContain('selected.import_route_id IS NOT NULL')
  expect(sourceStatement).toContain('selected.publication_year IS NOT NULL')
  expect(sourceStatement).toContain('selected.llm_status IS NOT NULL')
  expect(sourceStatement).toContain('selected.human_status IS NOT NULL')
  expect(sourceStatement).toContain('selected.llm_status AS facetValue')
  expect(sourceStatement).toContain('COUNT(DISTINCT selected.article_id) AS countValue')
  expect(sourceStatement).not.toContain('serving.selected_import_route_id')
  expect(sourceStatement).not.toContain('serving.publication_year')
  expect(sourceStatement).not.toContain('serving.llm_status_key')
  expect(sourceStatement).not.toContain('serving.human_status_key')
  expect(sourceStatement).not.toContain('active_article AS')
  expect(sourceStatement).not.toContain('\n        selected_article AS')
  expect(sourceStatement).toContain('detail.answered_original AS answerValue')
  expect(sourceStatement).toContain('unnest(detail.answered_original_as_array) AS answerValue')
  expect(joined).toContain("search_identity IS NOT DISTINCT FROM 'search:title'")
  expect(joined).toContain("filter_option_identity IS NOT DISTINCT FROM 'identity:search'")
})

test('search-scoped human option reconstruction follows project human judgment mode', async () => {
  const {database, statements} = createFilterOptionDatabase({sourceRows: [sourceRow({filterKind: 'human'})]})

  await projectReviewServingFilterOptions(
    projectInput({
      filterOptionIdentity: 'identity:human-search',
      listModeKeys: ['human'],
      optionMode: 'human',
      searchIdentity: 'search:title',
      searchTitle: 'heart',
    }),
    database,
  )
  const sourceStatement = statements.find((statement) => {
    return statement.includes('review_facet_options')
  })

  expect(sourceStatement).toContain('project_settings AS')
  expect(sourceStatement).toContain(
    "SELECT COALESCE((SELECT project.human_judgment_mode FROM app.project project WHERE project.id = 'project-1'), 'prompt') AS human_judgment_mode",
  )
  expect(sourceStatement).toContain('CROSS JOIN project_settings')
  expect(sourceStatement).toContain("project_settings.human_judgment_mode <> 'summary'")
  expect(sourceStatement).toContain("project_settings.human_judgment_mode = 'summary'")
  expect(sourceStatement).toContain("answer.prompt_id <> 'summary'")
  expect(sourceStatement).toContain("answer.prompt_id = 'summary'")
})

test('human option projection keeps prompt answers separate from summary-mode answers', async () => {
  const {database, statements} = createFilterOptionDatabase({
    sourceRows: [
      sourceRow({
        facetKey: 'promptAnswer',
        filterKind: 'human',
        optionValueKey: 'human:promptAnswer:prompt-1:yes',
        promptId: 'prompt-1',
      }),
      sourceRow({
        facetKey: 'promptAnswer',
        filterKind: 'human',
        optionValueKey: 'human:promptAnswer:summary:include',
        promptId: 'summary',
      }),
    ],
  })

  const result = await projectReviewServingFilterOptions(projectInput({optionMode: 'human'}), database)
  const sourceStatement = statements.find((statement) => {
    return statement.includes('finalized_facet_options')
  })

  expect(sourceStatement).toContain("'review.human.filter.promptAnswer'")
  expect(sourceStatement).toContain("'review.human.filter.summaryAnswer'")
  expect(sourceStatement).toContain("facet.summary_identity = 'review.human.filter.summaryAnswer'")
  expect(sourceStatement).toContain("THEN 'promptAnswer'")
  expect(sourceStatement).not.toContain("detail.payload_kind = 'human'")
  expect(sourceStatement).not.toContain('human_summary_options')
  expect(
    hasOptionValue(result.optionValues, {
      facet_key: 'promptAnswer',
      filter_kind: 'human',
      option_value_key: 'human:promptAnswer:prompt-1:yes',
      prompt_id: 'prompt-1',
    }),
  ).toBe(true)
  expect(
    hasOptionValue(result.optionValues, {
      facet_key: 'promptAnswer',
      filter_kind: 'human',
      option_value_key: 'human:promptAnswer:summary:include',
      prompt_id: 'summary',
    }),
  ).toBe(true)
})

test('filter option identity includes mode, list modes, search scope, filter keys, and summary versions', () => {
  const reviewIdentity = getReviewServingFilterOptionIdentity({
    filterKeys: ['promptAnswer', 'publicationYear'],
    listModeKeys: ['human', 'llm'],
    optionMode: 'review',
    searchIdentity: 'search:none',
  })
  const humanIdentity = getReviewServingFilterOptionIdentity({
    filterKeys: ['promptAnswer', 'publicationYear'],
    listModeKeys: ['human', 'llm'],
    optionMode: 'human',
    searchIdentity: 'search:none',
  })
  const oldVersionIdentity = getReviewServingFilterOptionIdentity({
    filterKeys: ['promptAnswer', 'publicationYear'],
    listModeKeys: ['human', 'llm'],
    optionMode: 'review',
    searchIdentity: 'search:none',
    summaryDefinitionVersions: {promptAnswer: 'old-summary:v0'},
  })

  expect(reviewIdentity).toContain('review-filter-prompt-answer:v1')
  expect(reviewIdentity).toContain('search:none')
  expect(reviewIdentity).toContain('llm')
  expect(reviewIdentity).not.toBe(humanIdentity)
  expect(reviewIdentity).not.toBe(oldVersionIdentity)
})
