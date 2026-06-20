import {Buffer} from 'node:buffer'
import {readFile} from 'node:fs/promises'

import {expect, test} from 'bun:test'

import type {DuckdbWorkloadContext} from '../utils/duckdbService.ts'
import type {ReviewServingProjectionComponent, ReviewServingSnapshotStatus} from './reviewServingContracts.ts'
import {getReviewFiltersFromServing} from './reviewServingFilterRouteService.ts'
import type {ReviewServingManifestRepositoryDatabase} from './reviewServingManifestRepository.ts'
import type {ReviewServingReaderDatabase} from './reviewServingReader.ts'

const components: readonly ReviewServingProjectionComponent[] = [
  'display',
  'projectScope',
  'selectedImport',
  'llmStatus',
  'humanStatus',
  'posting',
  'summary',
  'search',
]
const forbiddenSqlFragments = [
  'FROM app.article',
  'FROM app.judgment',
  'FROM app.judgment_human',
  'selected_scoped_article_import',
  'OFFSET',
  'json_extract',
  'json_extract_string',
]

const getComponentState = (inputComponents: readonly ReviewServingProjectionComponent[] = components) => {
  return {
    optional: [],
    required: inputComponents.map((component) => {
      return {
        baseGeneration: '1',
        component,
        patchWatermark: '2',
        projectionIdentity: `${component}-identity`,
        requirement: 'required' as const,
      }
    }),
  }
}

const getSnapshotRow = (
  status: ReviewServingSnapshotStatus,
  inputComponents: readonly ReviewServingProjectionComponent[] = components,
) => {
  return {
    componentStateJson: getComponentState(inputComponents),
    composedIdentityJson: {snapshot: `${status}-snapshot`},
    lastError: status === 'failed' ? 'projection failed' : null,
    lastKnownGoodSnapshotId: status === 'active' ? 'retired-snapshot' : null,
    optionalComponentsJson: [],
    projectId: 'project-1',
    requiredComponentsJson: inputComponents,
    reviewConfigHash: 'config-1',
    selectedImportSnapshotId: 'selected-import-snapshot-1',
    snapshotId: `${status}-snapshot`,
    snapshotStatus: status,
    sourceWatermarksJson: {},
    validationResultJson: null,
  }
}

const createManifestDatabase = (
  status: ReviewServingSnapshotStatus | 'missing',
  inputComponents: readonly ReviewServingProjectionComponent[] = components,
) => {
  const database: ReviewServingManifestRepositoryDatabase = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      if (!statement.includes('FROM app.review_serving_snapshot_manifest')) {
        return []
      }

      if (status === 'missing') {
        return []
      }

      if (statement.includes('snapshot_id =')) {
        return [getSnapshotRow(status, inputComponents)] as T[]
      }

      if (statement.includes("snapshot_status = 'active'")) {
        return status === 'active' ? ([getSnapshotRow('active', inputComponents)] as T[]) : []
      }

      if (statement.includes("snapshot_status = 'retired'")) {
        return status === 'retired' ? ([getSnapshotRow('retired', inputComponents)] as T[]) : []
      }

      return [getSnapshotRow(status, inputComponents)] as T[]
    },
    run: async () => {},
    transaction: async (operation) => {
      return operation(database)
    },
  }

  return database
}

const createReaderDatabase = () => {
  const statements: string[] = []
  const database: ReviewServingReaderDatabase = {
    queryJson: async <T>(statement: string, _workloadContext?: DuckdbWorkloadContext): Promise<T[]> => {
      statements.push(statement)

      if (statement.includes('FROM mart.review_filter_option_serving_v4')) {
        return [
          {
            count_value: 3,
            facet_key: 'promptAnswer',
            facet_value: 'yes',
            filter_kind: 'review',
            option_payload_json: {filterType: 'enum', promptId: 'prompt-1', value: 'yes'},
            option_value_key: 'review:promptAnswer:prompt-1:yes',
            prompt_id: 'prompt-1',
          },
          {
            count_value: 1,
            facet_key: 'promptAnswer',
            facet_value: '5',
            filter_kind: 'review',
            option_payload_json: {filterType: 'numeric', promptId: 'prompt-2', value: '5'},
            option_value_key: 'review:promptAnswer:prompt-2:5',
            prompt_id: 'prompt-2',
          },
          {
            count_value: 1,
            facet_key: 'promptAnswer',
            facet_value: '10',
            filter_kind: 'review',
            option_payload_json: {filterType: 'numeric', promptId: 'prompt-2', value: '10'},
            option_value_key: 'review:promptAnswer:prompt-2:10',
            prompt_id: 'prompt-2',
          },
          {
            count_value: 1,
            facet_key: 'publicationYear',
            facet_value: '2026',
            filter_kind: 'review',
            option_payload_json: {facetKey: 'publicationYear', filterType: 'enum', value: '2026'},
            option_value_key: 'review:publicationYear:2026',
          },
        ] as T[]
      }

      return [
        {
          availability: 'ready',
          count_value: 3,
          facet_key: 'promptAnswer',
          facet_kind: 'review',
          facet_value: 'yes',
          prompt_id: 'prompt-1',
          summary_identity: 'review.filter.promptAnswer',
        },
      ] as T[]
    },
  }

  return {database, statements}
}

test('review filter route service reads facet and option contracts without raw fallback SQL', async () => {
  const reader = createReaderDatabase()
  const response = await getReviewFiltersFromServing({
    dependencies: {
      currentReviewConfigHash: 'config-1',
      database: reader.database,
      manifestDatabase: createManifestDatabase('active'),
    },
    mode: 'review',
    params: {covidenceConflicts: '1', covidenceDuplicates: '1', projectId: 'project-1', search: 'heart'},
    promptRows: [
      {id: 'prompt-1', promptHeading: 'Prompt 1', originalText: 'Prompt one', type: 'string'},
      {id: 'prompt-2', promptHeading: 'Prompt 2', originalText: 'Prompt two', type: "string.integer | 'unknown'"},
    ],
  })
  const sql = reader.statements.join('\n')

  expect(response.filters).toEqual([
    {answeredOriginalValues: ['yes'], filterType: 'enum', promptId: 'prompt-1', promptName: 'Prompt 1'},
    {
      bins: [
        {label: '5', max: 5, min: 5},
        {label: '10', max: 10, min: 10},
      ],
      filterType: 'numeric',
      promptId: 'prompt-2',
      promptName: 'Prompt 2',
      specialValues: ['unknown'],
    },
  ])
  expect(response.facets[0]).toMatchObject({facet_key: 'promptAnswer', summary_identity: 'review.filter.promptAnswer'})
  expect(response.filterOptions[0]).toMatchObject({optionValueKey: 'review:promptAnswer:prompt-1:yes'})
  expect(response.searchScope).toMatchObject({mode: 'tokenPrefix', searchIdentity: 'search-identity', text: 'heart'})
  expect(reader.statements).toHaveLength(5)
  expect(sql).toContain('FROM mart.review_filter_facet_serving_v4')
  expect(sql).toContain('FROM mart.review_filter_option_serving_v4')
  expect(sql).toContain("AND facet_kind = 'review'")
  expect(sql).toContain('AND search_identity = ')
  forbiddenSqlFragments.forEach((fragment) => {
    expect(sql).not.toContain(fragment)
  })
})

test('review filter route service tokenizes search text like row reads', async () => {
  const reader = createReaderDatabase()

  const response = await getReviewFiltersFromServing({
    dependencies: {
      currentReviewConfigHash: 'config-1',
      database: reader.database,
      manifestDatabase: createManifestDatabase('active'),
    },
    mode: 'review',
    params: {projectId: 'project-1', search: 'COVID-19 heart failure'},
    promptRows: [],
  })

  const sql = reader.statements.join('\n')
  const filterSignatures = response.diagnostics.map((diagnostic) => {
    return Buffer.from(diagnostic.filterSignature ?? '', 'base64url').toString('utf8')
  })

  expect(response.searchScope).toMatchObject({mode: 'tokenPrefix', text: 'COVID-19 heart failure'})
  expect(filterSignatures[0]).toContain('"searchTokenPrefixes":["19","covid","failure","heart"]')
  expect(sql).not.toContain('"searchTokenPrefix":"covid-19"')
})

test('human filter route service keeps summary-mode answer scope from serving options', async () => {
  const statements: string[] = []
  const database: ReviewServingReaderDatabase = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      statements.push(statement)

      return statement.includes('FROM mart.review_filter_option_serving_v4')
        ? ([
            {
              count_value: 2,
              facet_key: 'promptAnswer',
              facet_value: 'include',
              filter_kind: 'human',
              option_payload_json: {filterType: 'enum', promptId: 'summary', summaryMode: true, value: 'include'},
              option_value_key: 'human:promptAnswer:summary:include',
              prompt_id: 'summary',
            },
          ] as T[])
        : ([] as T[])
    },
  }
  const response = await getReviewFiltersFromServing({
    dependencies: {currentReviewConfigHash: 'config-1', database, manifestDatabase: createManifestDatabase('active')},
    mode: 'human',
    params: {projectId: 'project-1'},
    promptRows: [{id: 'prompt-1', originalText: 'Prompt 1', promptHeading: 'Prompt 1', type: 'string'}],
  })

  expect(response.filters).toEqual([
    {
      answeredOriginalValues: ['include'],
      filterType: 'enum',
      promptId: 'summary',
      promptName: 'Overall human screening decision',
    },
  ])
  expect(statements.join('\n')).toContain("AND facet_kind = 'human'")
})

test('human filter route service keeps summary-mode filter when scoped options are empty', async () => {
  const database: ReviewServingReaderDatabase = {
    queryJson: async <T>(): Promise<T[]> => {
      return []
    },
  }
  const response = await getReviewFiltersFromServing({
    dependencies: {currentReviewConfigHash: 'config-1', database, manifestDatabase: createManifestDatabase('active')},
    mode: 'human',
    params: {projectId: 'project-1'},
    promptRows: [{id: 'prompt-1', originalText: 'Prompt 1', promptHeading: 'Prompt 1', type: 'string'}],
  })

  expect(response.filters).toEqual([
    {
      answeredOriginalValues: [],
      filterType: 'enum',
      promptId: 'summary',
      promptName: 'Overall human screening decision',
    },
  ])
})

test('human filter route service keeps prompt filters for prompt-mode projects', async () => {
  const database: ReviewServingReaderDatabase = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      return statement.includes('FROM mart.review_filter_option_serving_v4')
        ? ([
            {
              count_value: 2,
              facet_key: 'promptAnswer',
              facet_value: 'include',
              filter_kind: 'human',
              option_payload_json: {filterType: 'enum', promptId: 'prompt-1', value: 'include'},
              option_value_key: 'human:promptAnswer:prompt-1:include',
              prompt_id: 'prompt-1',
            },
          ] as T[])
        : ([] as T[])
    },
  }
  const response = await getReviewFiltersFromServing({
    dependencies: {currentReviewConfigHash: 'config-1', database, manifestDatabase: createManifestDatabase('active')},
    humanJudgmentMode: 'prompt',
    mode: 'human',
    params: {projectId: 'project-1'},
    promptRows: [{id: 'prompt-1', originalText: 'Prompt 1', promptHeading: 'Prompt 1', type: 'string'}],
  })

  expect(response.filters).toEqual([
    {answeredOriginalValues: ['include'], filterType: 'enum', promptId: 'prompt-1', promptName: 'Prompt 1'},
  ])
})

test('filter route service uses no-search identity when search component is absent', async () => {
  const statements: string[] = []
  const database: ReviewServingReaderDatabase = {
    queryJson: async <T>(statement: string): Promise<T[]> => {
      statements.push(statement)

      return [] as T[]
    },
  }
  const componentsWithoutSearch = components.filter((component) => {
    return component !== 'search'
  })
  const response = await getReviewFiltersFromServing({
    dependencies: {
      currentReviewConfigHash: 'config-1',
      database,
      manifestDatabase: createManifestDatabase('active', componentsWithoutSearch),
    },
    mode: 'review',
    params: {projectId: 'project-1'},
    promptRows: [],
  })

  expect(response.searchScope.searchIdentity).toBe('')
  expect(statements.join('\n')).toContain("search_identity = ''")
  expect(statements.join('\n')).not.toContain('$missingIdentity')
})

test('filter contracts cover synchronous combinations with bounded serving access', async () => {
  const source = await readFile(new URL('./reviewServingReadContracts.ts', import.meta.url), 'utf8')
  const routeSource = await readFile(
    new URL('../routes/projectsRoutes/projectsRoutesGetArticlesReviewsFilters.ts', import.meta.url),
    'utf8',
  )
  const humanRouteSource = await readFile(
    new URL('../routes/projectsRoutes/projectsRoutesGetArticlesReviewsHumanFilters.ts', import.meta.url),
    'utf8',
  )

  expect(source).toContain("physicalAccessStrategy: 'orderedPrefix'")
  expect(source).toContain("physicalAccessStrategy: 'postingIntersection'")
  expect(source).toContain("physicalAccessStrategy: 'summaryLookup'")
  expect(source).toContain("'review.filters.facets'")
  expect(source).toContain("'review.filters.options'")
  expect(source).toContain("'review.human.filters.facets'")
  expect(source).toContain("'review.human.filters.options'")
  expect(source).toContain("namedFastCounts: ['review.human.filter.promptAnswer', 'review.human.filter.summaryAnswer']")
  expect(`${routeSource}\n${humanRouteSource}`).not.toContain('articlesReviewsFiltersOlap')
  expect(`${routeSource}\n${humanRouteSource}`).not.toContain('getAppDatabaseService')
})
