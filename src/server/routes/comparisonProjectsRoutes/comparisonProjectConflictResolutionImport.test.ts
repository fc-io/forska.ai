import {expect, test} from 'bun:test'

import {
  type ComparisonProjectConflictResolutionImportSourceRow,
  type ComparisonProjectConflictResolutionImportTargetArticle,
  getComparisonProjectConflictResolutionImportPlan,
  getComparisonProjectConflictResolutionImportSourcesSql,
  getComparisonProjectConflictResolutionImportSourceValue,
  normalizeComparisonProjectConflictResolutionImportDoi,
  normalizeComparisonProjectConflictResolutionImportExternalArticleId,
  normalizeComparisonProjectConflictResolutionImportTitle,
} from './comparisonProjectConflictResolutionImport.ts'

const getSourceRow = (
  overrides: Partial<ComparisonProjectConflictResolutionImportSourceRow> = {},
): ComparisonProjectConflictResolutionImportSourceRow => {
  return {
    doi: null,
    externalArticleId: 'source-ext-1',
    resolutionValue: 'yes',
    sourceRowId: 'source-row-1',
    title: 'Source title',
    ...overrides,
  }
}

const getTargetArticle = (
  overrides: Partial<ComparisonProjectConflictResolutionImportTargetArticle> = {},
): ComparisonProjectConflictResolutionImportTargetArticle => {
  return {
    articleId: 'target-article-1',
    doi: null,
    externalArticleId: 'source-ext-1',
    isConflictResolutionEligible: true,
    title: 'Source title',
    ...overrides,
  }
}

const getPlan = (params: {
  sourceRows: ComparisonProjectConflictResolutionImportSourceRow[]
  targetArticles: ComparisonProjectConflictResolutionImportTargetArticle[]
  targetSummaryOptionValues?: string[]
}) => {
  return getComparisonProjectConflictResolutionImportPlan({
    sourceRows: params.sourceRows,
    targetArticles: params.targetArticles,
    targetSummaryOptionValues: params.targetSummaryOptionValues ?? ['yes', 'no', 'maybe'],
  })
}

const getErrorCodes = (params: ReturnType<typeof getPlan>) => {
  return params.errors.map((error) => {
    return error.code
  })
}

test('import source query selects only eligible comparison projects in newest order', () => {
  const sql = getComparisonProjectConflictResolutionImportSourcesSql({
    comparisonProjectConflictResolutionTable: 'app.comparison_project_conflict_resolution',
    comparisonProjectTable: 'app.comparison_project',
  })
  const source = getComparisonProjectConflictResolutionImportSourceValue({
    createdAt: '2026-05-30T10:00:00.000Z',
    description: null,
    humanJudgmentMode: null,
    id: 'comparison-project-1',
    name: 'Eligible source',
    resolutionCount: '3',
  })

  expect(sql).toContain('INNER JOIN app.comparison_project_conflict_resolution cr')
  expect(sql).toContain('WHERE cp.archived = FALSE')
  expect(sql).toContain('AND cp.allow_conflict_resolution = TRUE')
  expect(sql).toContain('COUNT(cr.article_id) AS resolutionCount')
  expect(sql).toContain('ORDER BY cp.created_at DESC, cp.name ASC, cp.id ASC')
  expect(source).toEqual({
    createdAt: new Date('2026-05-30T10:00:00.000Z'),
    description: null,
    humanJudgmentMode: 'prompt',
    id: 'comparison-project-1',
    name: 'Eligible source',
    resolutionCount: 3,
  })
})

test('import plan matches articles by normalized DOI', () => {
  expect(normalizeComparisonProjectConflictResolutionImportDoi(' DOI:10.1000/Example ')).toBe('10.1000/example')
  expect(normalizeComparisonProjectConflictResolutionImportDoi('https://dx.doi.org/10.1000/Example')).toBe(
    '10.1000/example',
  )

  const plan = getPlan({
    sourceRows: [
      getSourceRow({doi: ' https://doi.org/10.1000/Example ', externalArticleId: 'source-ext-does-not-match'}),
    ],
    targetArticles: [getTargetArticle({doi: 'doi:10.1000/example', externalArticleId: 'target-ext-does-not-match'})],
  })

  expect(plan.errors).toEqual([])
  expect(plan.skipCounts).toEqual({noTargetMatch: 0, noUsableKey: 0, notConflicting: 0})
  expect(plan.candidates).toEqual([
    {
      resolutionValue: 'yes',
      sourceRows: [{matchKey: '10.1000/example', matchKind: 'doi', sourceRowId: 'source-row-1'}],
      targetArticleId: 'target-article-1',
    },
  ])
})

test('import plan matches articles by normalized external ID and title', () => {
  expect(normalizeComparisonProjectConflictResolutionImportExternalArticleId(' External-1 ')).toBe('external-1')
  expect(normalizeComparisonProjectConflictResolutionImportTitle(' A   Multi\nLine   Title ')).toBe(
    'a multi line title',
  )

  const plan = getPlan({
    sourceRows: [getSourceRow({externalArticleId: ' External-1 ', title: ' A   Multi\nLine   Title '})],
    targetArticles: [getTargetArticle({externalArticleId: 'external-1', title: 'a multi line title'})],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toMatchObject([
    {
      resolutionValue: 'yes',
      sourceRows: [{matchKind: 'id-title', sourceRowId: 'source-row-1'}],
      targetArticleId: 'target-article-1',
    },
  ])
})

test('import plan prefers DOI over external ID and title when both match different targets', () => {
  const plan = getPlan({
    sourceRows: [getSourceRow({doi: '10.1000/preferred', externalArticleId: 'shared-ext', title: 'Shared title'})],
    targetArticles: [
      getTargetArticle({
        articleId: 'target-doi',
        doi: 'doi:10.1000/preferred',
        externalArticleId: 'different-ext',
        title: 'Different title',
      }),
      getTargetArticle({
        articleId: 'target-id-title',
        doi: null,
        externalArticleId: 'shared-ext',
        title: 'Shared title',
      }),
    ],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toMatchObject([{sourceRows: [{matchKind: 'doi'}], targetArticleId: 'target-doi'}])
})

test('import plan reports duplicate source and target keys as hard errors', () => {
  const plan = getPlan({
    sourceRows: [
      getSourceRow({doi: '10.1000/source-duplicate', externalArticleId: 'source-a', sourceRowId: 'source-doi-a'}),
      getSourceRow({doi: 'DOI:10.1000/source-duplicate', externalArticleId: 'source-b', sourceRowId: 'source-doi-b'}),
      getSourceRow({doi: null, externalArticleId: 'source-shared', sourceRowId: 'source-id-title-a', title: 'Shared'}),
      getSourceRow({
        doi: null,
        externalArticleId: 'SOURCE-SHARED',
        sourceRowId: 'source-id-title-b',
        title: ' Shared ',
      }),
    ],
    targetArticles: [
      getTargetArticle({articleId: 'target-doi-a', doi: '10.1000/target-duplicate', externalArticleId: 'target-a'}),
      getTargetArticle({articleId: 'target-doi-b', doi: 'doi:10.1000/target-duplicate', externalArticleId: 'target-b'}),
      getTargetArticle({
        articleId: 'target-id-title-a',
        doi: null,
        externalArticleId: 'target-shared',
        title: 'Shared',
      }),
      getTargetArticle({
        articleId: 'target-id-title-b',
        doi: null,
        externalArticleId: 'TARGET-SHARED',
        title: 'Shared',
      }),
    ],
  })
  const errorCodes = getErrorCodes(plan)

  expect(errorCodes).toContain('duplicate-source-doi-key')
  expect(errorCodes).toContain('duplicate-target-doi-key')
  expect(errorCodes).toContain('duplicate-source-id-title-key')
  expect(errorCodes).toContain('duplicate-target-id-title-key')
  expect(plan.candidates).toEqual([])
})

test('import plan reports conflicting source resolution values for the same target article', () => {
  const plan = getPlan({
    sourceRows: [
      getSourceRow({doi: '10.1000/shared-target', resolutionValue: 'yes', sourceRowId: 'source-doi'}),
      getSourceRow({
        doi: null,
        externalArticleId: 'shared-ext',
        resolutionValue: 'no',
        sourceRowId: 'source-id-title',
        title: 'Shared title',
      }),
    ],
    targetArticles: [
      getTargetArticle({
        articleId: 'target-shared',
        doi: '10.1000/shared-target',
        externalArticleId: 'shared-ext',
        title: 'Shared title',
      }),
    ],
  })

  expect(getErrorCodes(plan)).toContain('conflicting-source-resolution-values')
  expect(plan.errors[0]).toMatchObject({targetArticleId: 'target-shared', values: ['yes', 'no']})
  expect(plan.candidates).toEqual([])
})

test('import plan reports resolution values missing from target summary options', () => {
  const plan = getPlan({
    sourceRows: [getSourceRow({resolutionValue: 'unclear'})],
    targetArticles: [getTargetArticle()],
    targetSummaryOptionValues: ['yes', 'no'],
  })

  expect(plan.errors).toMatchObject([
    {code: 'invalid-source-resolution-value', sourceRowIds: ['source-row-1'], value: 'unclear'},
  ])
  expect(plan.candidates).toEqual([])
})

test('import plan skips source rows without a usable matching key', () => {
  const plan = getPlan({
    sourceRows: [getSourceRow({doi: null, externalArticleId: ' ', title: null})],
    targetArticles: [getTargetArticle()],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toEqual([])
  expect(plan.skipCounts).toEqual({noTargetMatch: 0, noUsableKey: 1, notConflicting: 0})
  expect(plan.skippedRows).toEqual([{reason: 'no-usable-key', sourceRowId: 'source-row-1'}])
})

test('import plan skips source rows without a target match', () => {
  const plan = getPlan({
    sourceRows: [getSourceRow({doi: '10.1000/source', externalArticleId: 'shared-ext', title: 'Shared title'})],
    targetArticles: [getTargetArticle({doi: '10.1000/target', externalArticleId: 'shared-ext', title: 'Shared title'})],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toEqual([])
  expect(plan.skipCounts).toEqual({noTargetMatch: 1, noUsableKey: 0, notConflicting: 0})
  expect(plan.skippedRows).toEqual([{reason: 'no-target-match', sourceRowId: 'source-row-1'}])
})

test('import plan skips target articles that are not conflict-resolution eligible', () => {
  const plan = getPlan({
    sourceRows: [getSourceRow()],
    targetArticles: [getTargetArticle({isConflictResolutionEligible: false})],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toEqual([])
  expect(plan.skipCounts).toEqual({noTargetMatch: 0, noUsableKey: 0, notConflicting: 1})
  expect(plan.skippedRows).toEqual([{reason: 'not-conflicting', sourceRowId: 'source-row-1'}])
})
