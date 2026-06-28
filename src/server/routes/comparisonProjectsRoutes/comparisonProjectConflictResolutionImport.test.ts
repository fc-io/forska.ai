import {expect, test} from 'bun:test'

import {
  type ComparisonProjectConflictResolutionTransferArtifactV1,
  comparisonProjectConflictResolutionTransferFormat,
  comparisonProjectConflictResolutionTransferVersion,
} from './comparisonProjectConflictResolutionFileTransfer.ts'
import {
  type ComparisonProjectConflictResolutionImportMode,
  type ComparisonProjectConflictResolutionImportSourceRow,
  type ComparisonProjectConflictResolutionImportTargetArticle,
  getComparisonProjectConflictResolutionImportAnalyzeResult,
  getComparisonProjectConflictResolutionImportArticleIdTargetArticlesSql,
  getComparisonProjectConflictResolutionImportCommitResult,
  getComparisonProjectConflictResolutionImportDoiTargetArticlesSql,
  getComparisonProjectConflictResolutionImportIdentifierTargetArticlesSql,
  getComparisonProjectConflictResolutionImportIdTitleKey,
  getComparisonProjectConflictResolutionImportIdTitleTargetArticlesSql,
  getComparisonProjectConflictResolutionImportPlan,
  getComparisonProjectConflictResolutionImportServingArticleIdTargetArticlesSql,
  getComparisonProjectConflictResolutionImportServingIdentifierTargetArticlesSql,
  getComparisonProjectConflictResolutionImportServingIdTitleTargetArticlesSql,
  getComparisonProjectConflictResolutionImportServingTitleTargetArticlesSql,
  getComparisonProjectConflictResolutionImportSourceRowsFromTransferArtifact,
  getComparisonProjectConflictResolutionImportSourceRowsSql,
  getComparisonProjectConflictResolutionImportSourcesSql,
  getComparisonProjectConflictResolutionImportSourceValue,
  getComparisonProjectConflictResolutionImportTitleKey,
  getComparisonProjectConflictResolutionImportTitleTargetArticlesSql,
  mergeComparisonProjectConflictResolutionImportTargetArticleRows,
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
    sourceArticleId: 'source-article-1',
    sourceArticleTitle: 'Source title',
    sourceComparisonProjectId: 'source-comparison-project-1',
    sourceComparisonProjectName: 'Source comparison project',
    sourceExternalArticleId: 'source-ext-1',
    sourceResolutionId: 'source-resolution-1',
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
  importMode?: ComparisonProjectConflictResolutionImportMode
  sourceRows: ComparisonProjectConflictResolutionImportSourceRow[]
  targetArticles: ComparisonProjectConflictResolutionImportTargetArticle[]
  targetSummaryOptionValues?: string[]
}) => {
  return getComparisonProjectConflictResolutionImportPlan({
    importMode: params.importMode,
    sourceRows: params.sourceRows,
    targetArticles: params.targetArticles,
    targetSummaryOptionValues: params.targetSummaryOptionValues ?? ['yes', 'no', 'maybe'],
  })
}

const getWarningCodes = (params: ReturnType<typeof getPlan>) => {
  return params.warnings.map((warning) => {
    return warning.code
  })
}

const getSkipCounts = (overrides: Partial<ReturnType<typeof getPlan>['skipCounts']> = {}) => {
  return {
    ambiguousTarget: 0,
    conflictingIdentifiers: 0,
    conflicting: 0,
    existingTargetResolution: 0,
    invalidValue: 0,
    noTargetMatch: 0,
    noUsableKey: 0,
    notConflicting: 0,
    unsupportedMode: 0,
    ...overrides,
  }
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
  expect(sql).toContain("AND cp.human_judgment_mode = 'summary'")
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

test('import source row query starts from selected conflict-resolution rows', () => {
  const sql = getComparisonProjectConflictResolutionImportSourceRowsSql({
    articleIdentifierTable: 'app.article_identifier',
    articleTable: 'app.article',
    comparisonProjectTable: 'app.comparison_project',
    comparisonProjectConflictResolutionTable: 'app.comparison_project_conflict_resolution',
    sourceComparisonProjectIds: ['comparison-source-1', 'comparison-source-2'],
  })

  expect(sql).toContain('WITH source_resolution AS')
  expect(sql).toContain('FROM app.comparison_project_conflict_resolution cr')
  expect(sql).toContain('cr.comparison_project_id AS sourceComparisonProjectId')
  expect(sql).toContain('cr.id AS sourceResolutionId')
  expect(sql).toContain("WHERE cr.comparison_project_id IN ('comparison-source-1', 'comparison-source-2')")
  expect(sql).toContain('INNER JOIN app.comparison_project source_comparison_project')
  expect(sql).toContain('source_comparison_project.name AS sourceComparisonProjectName')
  expect(sql).toContain(
    'INNER JOIN app.article source_article ON source_article.id = source_resolution.sourceArticleId',
  )
  expect(sql).toContain('source_article.article_id AS sourceExternalArticleId')
  expect(sql).toContain('source_article.article_title AS sourceArticleTitle')
  expect(sql).toContain('LIST(DISTINCT normalized_value ORDER BY normalized_value) AS doiKeys')
  expect(sql).toContain('doi_identifier.doiKeys AS doiKeys')
  expect(sql).toContain("WHERE kind = 'doi'")
  expect(sql).toContain("WHERE kind IN ('doi', 'pmid', 'arxiv')")
  expect(sql).toContain('strong_identifier.identifierKeys AS identifierKeys')
  expect(sql).toContain('source_article.pubmed_id AS pubmedId')
  expect(sql).toContain('source_article.arxiv_id AS arxivId')
})

test('target article queries are constrained by selected normalized matching keys and scope', () => {
  const idTitleKey = getComparisonProjectConflictResolutionImportIdTitleKey({
    externalArticleId: ' External-1 ',
    title: ' A   Multi\nLine   Title ',
  })
  const identifierSql = getComparisonProjectConflictResolutionImportIdentifierTargetArticlesSql({
    articleIdentifierTable: 'app.article_identifier',
    articleScopeConditions: ['EXISTS (SELECT 1 FROM app.project_article pa WHERE pa.article_id = a.id)'],
    articleTable: 'app.article',
    identifierKeys: ['pmid\u001F12345'],
  })
  const articleIdSql = getComparisonProjectConflictResolutionImportArticleIdTargetArticlesSql({
    articleIds: ['article-1'],
    articleIdentifierTable: 'app.article_identifier',
    articleScopeConditions: ['EXISTS (SELECT 1 FROM app.project_article pa WHERE pa.article_id = a.id)'],
    articleTable: 'app.article',
  })
  const doiSql = getComparisonProjectConflictResolutionImportDoiTargetArticlesSql({
    articleIdentifierTable: 'app.article_identifier',
    articleScopeConditions: ['EXISTS (SELECT 1 FROM app.project_article pa WHERE pa.article_id = a.id)'],
    articleTable: 'app.article',
    doiKeys: ['10.1000/example'],
  })
  const idTitleSql = getComparisonProjectConflictResolutionImportIdTitleTargetArticlesSql({
    articleIdentifierTable: 'app.article_identifier',
    articleScopeConditions: ['EXISTS (SELECT 1 FROM app.project_article pa WHERE pa.article_id = a.id)'],
    articleTable: 'app.article',
    idTitleKeys: [idTitleKey ?? ''],
  })
  const titleKey = getComparisonProjectConflictResolutionImportTitleKey({title: ' A   Multi\nLine   Title '})
  const titleSql = getComparisonProjectConflictResolutionImportTitleTargetArticlesSql({
    articleIdentifierTable: 'app.article_identifier',
    articleScopeConditions: ['EXISTS (SELECT 1 FROM app.project_article pa WHERE pa.article_id = a.id)'],
    articleTable: 'app.article',
    titleKeys: [titleKey ?? ''],
  })

  expect(idTitleKey).toBe('external-1\u001Fa multi line title')
  expect(titleKey).toBe('a multi line title')
  expect(doiSql).toContain('doi_identifier.normalized_value IN (')
  expect(doiSql).toContain('10.1000/example')
  expect(doiSql).toContain('EXISTS (SELECT 1 FROM app.project_article pa WHERE pa.article_id = a.id)')
  expect(doiSql).toContain('a.article_id AS externalArticleId')
  expect(doiSql).toContain('a.article_title AS title')
  expect(doiSql).toContain(
    'LIST(DISTINCT doi_identifier.normalized_value ORDER BY doi_identifier.normalized_value) AS doiKeys',
  )
  expect(identifierSql).toContain("target_identifier.kind IN ('doi', 'pmid', 'arxiv')")
  expect(identifierSql).toContain('pmid\u001F12345')
  expect(identifierSql).toContain('strong_identifier.kind')
  expect(identifierSql).toContain('strong_identifier.normalizedValue')
  expect(identifierSql).toContain('legacy_article.pubmed_id')
  expect(identifierSql).toContain('legacy_article.arxiv_id')
  expect(identifierSql).toContain('EXISTS (SELECT 1 FROM app.project_article pa WHERE pa.article_id = a.id)')
  expect(articleIdSql).toContain('a.id AS articleId')
  expect(articleIdSql).toContain("a.id IN ('article-1')")
  expect(articleIdSql).toContain('LEFT JOIN app.article_identifier strong_identifier')
  expect(articleIdSql).toContain('EXISTS (SELECT 1 FROM app.project_article pa WHERE pa.article_id = a.id)')
  expect(doiSql).not.toContain('NULL AS externalArticleId')
  expect(doiSql).not.toContain('NULL AS title')
  expect(idTitleSql).toContain('regexp_replace(LOWER(TRIM(COALESCE(a.article_title')
  expect(idTitleSql).toContain('doi_identifier.doi AS doi')
  expect(idTitleSql).toContain('LEFT JOIN doi_identifier ON doi_identifier.articleId = a.id')
  expect(idTitleSql).toContain('strong_identifier.normalizedValue')
  expect(idTitleSql).toContain(idTitleKey ?? '')
  expect(idTitleSql).toContain('EXISTS (SELECT 1 FROM app.project_article pa WHERE pa.article_id = a.id)')
  expect(titleSql).toContain('regexp_replace(LOWER(TRIM(COALESCE(a.article_title')
  expect(titleSql).toContain('doi_identifier.doi AS doi')
  expect(titleSql).toContain('strong_identifier.normalizedValue')
  expect(titleSql).toContain(titleKey ?? '')
  expect(titleSql).toContain('EXISTS (SELECT 1 FROM app.project_article pa WHERE pa.article_id = a.id)')
})

test('serving target article queries use active comparison serving identity tables', () => {
  const articleIdSql = getComparisonProjectConflictResolutionImportServingArticleIdTargetArticlesSql({
    articleIds: ['article-1'],
    comparisonProjectId: 'comparison-project-1',
    generation: 4,
  })
  const identifierSql = getComparisonProjectConflictResolutionImportServingIdentifierTargetArticlesSql({
    comparisonProjectId: 'comparison-project-1',
    generation: 4,
    identifierKeys: ['pmid\u001F12345'],
  })
  const idTitleKey = getComparisonProjectConflictResolutionImportIdTitleKey({
    externalArticleId: ' External-1 ',
    title: ' A   Multi\nLine   Title ',
  })
  const idTitleSql = getComparisonProjectConflictResolutionImportServingIdTitleTargetArticlesSql({
    comparisonProjectId: 'comparison-project-1',
    generation: 4,
    idTitleKeys: [idTitleKey ?? ''],
  })
  const titleKey = getComparisonProjectConflictResolutionImportTitleKey({title: ' A   Multi\nLine   Title '})
  const titleSql = getComparisonProjectConflictResolutionImportServingTitleTargetArticlesSql({
    comparisonProjectId: 'comparison-project-1',
    generation: 4,
    titleKeys: [titleKey ?? ''],
  })
  const combinedSql = [articleIdSql, identifierSql, idTitleSql, titleSql].join('\n')

  expect(combinedSql).toContain('FROM mart.comparison_article_serving a')
  expect(combinedSql).toContain('LEFT JOIN mart.comparison_article_identifier_serving strong_identifier')
  expect(combinedSql).toContain("a.comparison_project_id = 'comparison-project-1'")
  expect(combinedSql).toContain('a.generation = 4')
  expect(combinedSql).toContain('a.article_external_id AS externalArticleId')
  expect(combinedSql).toContain('a.article_title AS title')
  expect(articleIdSql).toContain("a.article_id IN ('article-1')")
  expect(identifierSql).toContain('FROM mart.comparison_article_identifier_serving matched_identifier')
  expect(identifierSql).toContain('pmid\u001F12345')
  expect(idTitleSql).toContain('regexp_replace(LOWER(TRIM(COALESCE(a.article_title')
  expect(idTitleSql).toContain(idTitleKey ?? '')
  expect(titleSql).toContain(titleKey ?? '')
  expect(combinedSql).not.toContain('app.article')
  expect(combinedSql).not.toContain('app.article_identifier')
  expect(combinedSql).not.toContain('app.project_article')
})

test('target article query rows merge DOI and id-title metadata by article id', () => {
  const rows = mergeComparisonProjectConflictResolutionImportTargetArticleRows([
    {articleId: 'target-article-1', doi: '10.1000/primary', externalArticleId: null, title: null},
    {articleId: 'target-article-1', doi: '10.1000/secondary', externalArticleId: null, title: null},
    {articleId: 'target-article-1', doi: null, externalArticleId: 'target-ext-1', title: 'Target title'},
    {articleId: 'target-article-2', doi: null, externalArticleId: 'target-ext-2', title: 'Second target title'},
  ])

  expect(rows).toEqual([
    {
      articleId: 'target-article-1',
      arxivId: null,
      doi: '10.1000/primary',
      doiKeys: ['10.1000/primary', '10.1000/secondary'],
      externalArticleId: 'target-ext-1',
      identifierKeys: ['doi\u001F10.1000/primary', 'doi\u001F10.1000/secondary'],
      legacyDoi: null,
      pubmedId: null,
      title: 'Target title',
    },
    {articleId: 'target-article-2', doi: null, externalArticleId: 'target-ext-2', title: 'Second target title'},
  ])
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
  expect(plan.skipCounts).toEqual(getSkipCounts())
  expect(plan.candidates).toEqual([
    {
      resolutionValue: 'yes',
      sourceRows: [{matchKey: '10.1000/example', matchKind: 'doi', sourceRowId: 'source-row-1'}],
      targetArticleId: 'target-article-1',
    },
  ])
})

test('import plan matches same database articles by source article row id', () => {
  const plan = getPlan({
    sourceRows: [
      getSourceRow({
        doi: null,
        externalArticleId: null,
        sourceArticleId: 'shared-article-1',
        sourceExternalArticleId: null,
      }),
    ],
    targetArticles: [
      getTargetArticle({
        articleId: 'shared-article-1',
        doi: null,
        externalArticleId: null,
        title: 'Different target title',
      }),
    ],
  })

  expect(plan.errors).toEqual([])
  expect(plan.skipCounts).toEqual(getSkipCounts())
  expect(plan.candidates).toEqual([
    {
      resolutionValue: 'yes',
      sourceRows: [{matchKey: 'shared-article-1', matchKind: 'article-id', sourceRowId: 'source-row-1'}],
      targetArticleId: 'shared-article-1',
    },
  ])
})

test('import plan prefers source article row id over portable identifiers', () => {
  const plan = getPlan({
    sourceRows: [getSourceRow({doi: '10.1000/portable-match', sourceArticleId: 'shared-article-1'})],
    targetArticles: [
      getTargetArticle({articleId: 'shared-article-1', doi: null}),
      getTargetArticle({articleId: 'portable-target', doi: '10.1000/portable-match'}),
    ],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toEqual([
    {
      resolutionValue: 'yes',
      sourceRows: [{matchKey: 'shared-article-1', matchKind: 'article-id', sourceRowId: 'source-row-1'}],
      targetArticleId: 'shared-article-1',
    },
  ])
})

test('import plan matches articles by any normalized source DOI key', () => {
  const plan = getPlan({
    sourceRows: [
      getSourceRow({
        doi: null,
        doiKeys: ['10.1000/non-match', ' DOI:10.1000/Match '],
        externalArticleId: 'source-ext-does-not-match',
      }),
    ],
    targetArticles: [getTargetArticle({doi: '10.1000/match', externalArticleId: 'target-ext-does-not-match'})],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toEqual([
    {
      resolutionValue: 'yes',
      sourceRows: [{matchKey: '10.1000/match', matchKind: 'doi', sourceRowId: 'source-row-1'}],
      targetArticleId: 'target-article-1',
    },
  ])
})

test('adapts exported transfer rows into import planner source rows', () => {
  const rows = getComparisonProjectConflictResolutionImportSourceRowsFromTransferArtifact({
    format: comparisonProjectConflictResolutionTransferFormat,
    version: comparisonProjectConflictResolutionTransferVersion,
    exportedAt: '2026-06-10T10:00:00.000Z',
    source: {
      comparisonProjectId: 'source-comparison-project-file',
      comparisonProjectName: 'File source project',
      comparisonProjectDescription: null,
    },
    rows: [
      {
        sourceResolutionId: 'source-resolution-file',
        sourceArticleRowId: 'source-article-file',
        externalArticleId: 'external-file',
        title: 'File title',
        doi: '10.1000/file',
        pubmedId: '00012345',
        arxivId: 'https://arxiv.org/abs/2401.12345v2',
        identifiers: [
          {
            sourceIdentifierId: 'source-identifier-pmid',
            kind: 'pmid',
            normalizedValue: '12345',
            source: 'pubmed_id',
            isPrimary: true,
          },
        ],
        resolution: {mode: 'summary', value: 'yes', label: 'Yes'},
      },
    ],
  })

  expect(rows).toEqual([
    {
      arxivId: 'https://arxiv.org/abs/2401.12345v2',
      doi: '10.1000/file',
      externalArticleId: 'external-file',
      identifiers: [{kind: 'pmid', normalizedValue: '12345'}],
      pubmedId: '00012345',
      resolutionMode: 'summary',
      resolutionValue: 'yes',
      sourceArticleId: 'source-article-file',
      sourceArticleTitle: 'File title',
      sourceComparisonProjectId: 'source-comparison-project-file',
      sourceComparisonProjectName: 'File source project',
      sourceExternalArticleId: 'external-file',
      sourceResolutionId: 'source-resolution-file',
      sourceRowId: 'source-resolution-file',
      title: 'File title',
    },
  ])
})

test('adapts transfer rows with null source ids into generated import source ids', () => {
  const rows = getComparisonProjectConflictResolutionImportSourceRowsFromTransferArtifact({
    format: comparisonProjectConflictResolutionTransferFormat,
    version: comparisonProjectConflictResolutionTransferVersion,
    exportedAt: '2026-06-10T10:00:00.000Z',
    source: {
      comparisonProjectId: 'source-comparison-project-file',
      comparisonProjectName: 'File source project',
      comparisonProjectDescription: null,
    },
    rows: [
      {
        sourceResolutionId: null,
        sourceArticleRowId: null,
        externalArticleId: null,
        title: 'Title only source',
        identifiers: [],
        resolution: {mode: 'summary', value: 'yes', label: 'Yes'},
      },
    ],
  })

  expect(rows).toMatchObject([
    {
      externalArticleId: null,
      sourceArticleId: 'source-comparison-project-file:transfer-row-000001:article',
      sourceArticleTitle: 'Title only source',
      sourceExternalArticleId: null,
      sourceResolutionId: 'source-comparison-project-file:transfer-row-000001:resolution',
      sourceRowId: 'source-comparison-project-file:transfer-row-000001:resolution',
      title: 'Title only source',
    },
  ])
})

test('analyzes transfer artifact rows with stable importable and skipped details', () => {
  const artifact = {
    format: comparisonProjectConflictResolutionTransferFormat,
    version: comparisonProjectConflictResolutionTransferVersion,
    exportedAt: '2026-06-10T10:00:00.000Z',
    source: {
      comparisonProjectId: 'source-comparison-project-file',
      comparisonProjectName: 'File source project',
      comparisonProjectDescription: null,
    },
    rows: [
      {
        sourceResolutionId: 'source-resolution-importable',
        sourceArticleRowId: 'source-article-importable',
        externalArticleId: 'external-importable',
        title: 'Importable source',
        doi: '10.1000/importable',
        identifiers: [],
        resolution: {mode: 'summary' as const, value: 'yes', label: 'Yes'},
      },
      {
        sourceResolutionId: 'source-resolution-existing',
        sourceArticleRowId: 'source-article-existing',
        externalArticleId: 'external-existing',
        title: 'Existing source',
        doi: '10.1000/existing',
        identifiers: [],
        resolution: {mode: 'summary' as const, value: 'no', label: 'No'},
      },
      {
        sourceResolutionId: 'source-resolution-prompt',
        sourceArticleRowId: 'source-article-prompt',
        externalArticleId: 'external-prompt',
        title: 'Prompt source',
        doi: '10.1000/prompt',
        identifiers: [],
        resolution: {mode: 'prompt' as const, value: 'prompt-1', label: 'Prompt 1'},
      },
      {
        sourceResolutionId: 'source-resolution-no-key',
        sourceArticleRowId: 'source-article-no-key',
        externalArticleId: null,
        title: 'No key source',
        identifiers: [],
        resolution: {mode: 'summary' as const, value: 'yes', label: 'Yes'},
      },
      {
        sourceResolutionId: 'source-resolution-invalid',
        sourceArticleRowId: 'source-article-invalid',
        externalArticleId: 'external-invalid',
        title: 'Invalid source',
        doi: '10.1000/invalid',
        identifiers: [],
        resolution: {mode: 'summary' as const, value: 'unclear', label: 'Unclear'},
      },
    ],
  } satisfies ComparisonProjectConflictResolutionTransferArtifactV1
  const sourceRows = getComparisonProjectConflictResolutionImportSourceRowsFromTransferArtifact(artifact)
  const result = getComparisonProjectConflictResolutionImportAnalyzeResult({
    artifact,
    sourceRows,
    targetArticles: [
      getTargetArticle({
        articleId: 'target-importable',
        doi: '10.1000/importable',
        externalArticleId: 'target-external-importable',
        title: 'Target importable',
      }),
      getTargetArticle({
        articleId: 'target-existing',
        doi: '10.1000/existing',
        externalArticleId: 'target-external-existing',
        hasExistingResolution: true,
        title: 'Target existing',
      }),
      getTargetArticle({
        articleId: 'target-invalid',
        doi: '10.1000/invalid',
        externalArticleId: 'target-external-invalid',
        title: 'Target invalid',
      }),
    ],
    targetSummaryOptionValues: ['yes', 'no'],
  })

  expect(result.source).toEqual({
    comparisonProjectDescription: null,
    comparisonProjectId: 'source-comparison-project-file',
    comparisonProjectName: 'File source project',
    exportedAt: '2026-06-10T10:00:00.000Z',
    format: comparisonProjectConflictResolutionTransferFormat,
    rowCount: 5,
    version: 1,
  })
  expect(result.summary).toEqual({
    deduped: 0,
    importable: 1,
    matched: 1,
    scanned: 5,
    skipped: 4,
    skippedAmbiguousTarget: 0,
    skippedConflicting: 0,
    skippedExisting: 1,
    skippedInvalidValue: 1,
    skippedNoTargetMatch: 1,
    skippedNoUsableKey: 0,
    skippedNotConflicting: 0,
    skippedUnsupportedMode: 1,
  })
  expect(result.importableRows).toEqual([
    {
      matchKey: '10.1000/importable',
      matchKind: 'doi',
      reason: 'importable',
      selectedResolution: 'yes',
      sourceArticleRowId: 'source-article-importable',
      sourceComparisonProjectId: 'source-comparison-project-file',
      sourceComparisonProjectName: 'File source project',
      sourceExternalArticleId: 'external-importable',
      sourceResolutionId: 'source-resolution-importable',
      sourceTitle: 'Importable source',
      targetArticleId: 'target-importable',
      targetArticleIds: ['target-importable'],
      targetExternalArticleId: 'target-external-importable',
      targetExternalArticleIds: ['target-external-importable'],
      targetTitle: 'Target importable',
    },
  ])
  expect(result.skippedRows).toMatchObject([
    {
      matchKey: '10.1000/existing',
      matchKind: 'doi',
      reason: 'existing-target-resolution',
      sourceResolutionId: 'source-resolution-existing',
      targetArticleId: 'target-existing',
      targetArticleIds: ['target-existing'],
    },
    {
      matchKey: '10.1000/prompt',
      matchKind: 'doi',
      reason: 'unsupported-mode',
      selectedResolution: 'prompt-1',
      sourceResolutionId: 'source-resolution-prompt',
      targetArticleId: null,
      targetArticleIds: [],
    },
    {
      matchKey: 'no key source',
      matchKind: 'title',
      reason: 'no-target-match',
      sourceResolutionId: 'source-resolution-no-key',
      targetArticleId: null,
      targetArticleIds: [],
    },
    {
      matchKey: '10.1000/invalid',
      matchKind: 'doi',
      reason: 'invalid-target-resolution-value',
      selectedResolution: 'unclear',
      sourceResolutionId: 'source-resolution-invalid',
      targetArticleId: 'target-invalid',
      targetArticleIds: ['target-invalid'],
    },
  ])
  expect(result.warnings).toMatchObject([{code: 'invalid-target-resolution-value'}])
})

test('commit result keeps analyze shape and adds inserted count', () => {
  const artifact = {
    format: comparisonProjectConflictResolutionTransferFormat,
    version: comparisonProjectConflictResolutionTransferVersion,
    exportedAt: '2026-06-10T10:00:00.000Z',
    source: {
      comparisonProjectId: 'source-comparison-project-file',
      comparisonProjectName: 'File source project',
      comparisonProjectDescription: null,
    },
    rows: [
      {
        sourceResolutionId: 'source-resolution-importable',
        sourceArticleRowId: 'source-article-importable',
        externalArticleId: 'external-importable',
        title: 'Importable source',
        doi: '10.1000/importable',
        identifiers: [],
        resolution: {mode: 'summary' as const, value: 'yes', label: 'Yes'},
      },
    ],
  } satisfies ComparisonProjectConflictResolutionTransferArtifactV1
  const sourceRows = getComparisonProjectConflictResolutionImportSourceRowsFromTransferArtifact(artifact)
  const analyzeResult = getComparisonProjectConflictResolutionImportAnalyzeResult({
    artifact,
    sourceRows,
    targetArticles: [getTargetArticle({articleId: 'target-importable', doi: '10.1000/importable'})],
    targetSummaryOptionValues: ['yes', 'no'],
  })
  const commitResult = getComparisonProjectConflictResolutionImportCommitResult({analyzeResult, inserted: 1})

  expect(commitResult).toEqual({...analyzeResult, summary: {...analyzeResult.summary, inserted: 1}})
})

test('import plan matches file-backed articles by canonical PMID', () => {
  const sourceRows = getComparisonProjectConflictResolutionImportSourceRowsFromTransferArtifact({
    format: comparisonProjectConflictResolutionTransferFormat,
    version: comparisonProjectConflictResolutionTransferVersion,
    exportedAt: '2026-06-10T10:00:00.000Z',
    source: {
      comparisonProjectId: 'source-comparison-project-file',
      comparisonProjectName: 'File source project',
      comparisonProjectDescription: null,
    },
    rows: [
      {
        sourceResolutionId: 'source-resolution-pmid',
        sourceArticleRowId: 'source-article-pmid',
        externalArticleId: 'source-ext-does-not-match',
        title: 'Source PMID title',
        identifiers: [
          {
            sourceIdentifierId: 'source-identifier-pmid',
            kind: 'pmid',
            normalizedValue: '00012345',
            source: 'pubmed_id',
            isPrimary: true,
          },
        ],
        resolution: {mode: 'summary', value: 'yes', label: 'Yes'},
      },
    ],
  })
  const plan = getPlan({
    sourceRows,
    targetArticles: [
      getTargetArticle({
        externalArticleId: 'target-ext-does-not-match',
        identifiers: [{kind: 'pmid', normalizedValue: '12345'}],
      }),
    ],
  })

  expect(plan.errors).toEqual([])
  expect(plan.skipCounts).toEqual(getSkipCounts())
  expect(plan.candidates).toEqual([
    {
      resolutionValue: 'yes',
      sourceRows: [{matchKey: 'pmid:12345', matchKind: 'pmid', sourceRowId: 'source-resolution-pmid'}],
      targetArticleId: 'target-article-1',
    },
  ])
})

test('import plan matches file-backed articles by canonical arXiv id', () => {
  const sourceRows = getComparisonProjectConflictResolutionImportSourceRowsFromTransferArtifact({
    format: comparisonProjectConflictResolutionTransferFormat,
    version: comparisonProjectConflictResolutionTransferVersion,
    exportedAt: '2026-06-10T10:00:00.000Z',
    source: {
      comparisonProjectId: 'source-comparison-project-file',
      comparisonProjectName: 'File source project',
      comparisonProjectDescription: null,
    },
    rows: [
      {
        sourceResolutionId: 'source-resolution-arxiv',
        sourceArticleRowId: 'source-article-arxiv',
        externalArticleId: 'source-ext-does-not-match',
        title: 'Source arXiv title',
        identifiers: [
          {
            sourceIdentifierId: 'source-identifier-arxiv',
            kind: 'arxiv',
            normalizedValue: 'https://arxiv.org/abs/2401.12345v2',
            source: 'arxiv_id',
            isPrimary: true,
          },
        ],
        resolution: {mode: 'summary', value: 'maybe', label: 'Maybe'},
      },
    ],
  })
  const plan = getPlan({
    sourceRows,
    targetArticles: [
      getTargetArticle({
        externalArticleId: 'target-ext-does-not-match',
        identifiers: [{kind: 'arxiv', normalizedValue: '2401.12345'}],
      }),
    ],
  })

  expect(plan.errors).toEqual([])
  expect(plan.skipCounts).toEqual(getSkipCounts())
  expect(plan.candidates).toEqual([
    {
      resolutionValue: 'maybe',
      sourceRows: [{matchKey: 'arxiv:2401.12345', matchKind: 'arxiv', sourceRowId: 'source-resolution-arxiv'}],
      targetArticleId: 'target-article-1',
    },
  ])
})

test('import plan matches articles by legacy stable IDs after canonical identifiers', () => {
  const plan = getPlan({
    sourceRows: [getSourceRow({doi: null, externalArticleId: 'source-ext-does-not-match', pubmedId: '00012345'})],
    targetArticles: [getTargetArticle({externalArticleId: 'target-ext-does-not-match', pubmedId: '12345'})],
  })

  expect(plan.errors).toEqual([])
  expect(plan.skipCounts).toEqual(getSkipCounts())
  expect(plan.candidates).toEqual([
    {
      resolutionValue: 'yes',
      sourceRows: [{matchKey: 'pmid:12345', matchKind: 'pmid', sourceRowId: 'source-row-1'}],
      targetArticleId: 'target-article-1',
    },
  ])
})

test('import plan uses ID/title to resolve ambiguous DOI target matches', () => {
  const plan = getPlan({
    sourceRows: [getSourceRow({doi: '10.1000/shared', externalArticleId: 'source-ext-b', title: 'Source title B'})],
    targetArticles: [
      getTargetArticle({
        articleId: 'target-a',
        doi: '10.1000/shared',
        externalArticleId: 'source-ext-a',
        title: 'Source title A',
      }),
      getTargetArticle({
        articleId: 'target-b',
        doi: 'doi:10.1000/shared',
        externalArticleId: 'source-ext-b',
        title: 'Source title B',
      }),
    ],
  })

  expect(plan.errors).toEqual([])
  expect(plan.warnings).toEqual([])
  expect(plan.candidates).toMatchObject([
    {
      sourceRows: [{matchKey: '10.1000/shared', matchKind: 'doi', sourceRowId: 'source-row-1'}],
      targetArticleId: 'target-b',
    },
  ])
})

test('import plan skips ambiguous DOI target matches without an ID/title tie-breaker', () => {
  const plan = getPlan({
    sourceRows: [getSourceRow({doi: '10.1000/shared', externalArticleId: 'source-ext-does-not-match'})],
    targetArticles: [
      getTargetArticle({articleId: 'target-a', doi: '10.1000/shared', externalArticleId: 'target-a-ext'}),
      getTargetArticle({articleId: 'target-b', doi: 'doi:10.1000/shared', externalArticleId: 'target-b-ext'}),
    ],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toEqual([])
  expect(plan.skipCounts).toEqual(getSkipCounts({ambiguousTarget: 1}))
  expect(plan.skippedRows).toEqual([{reason: 'ambiguous-target-match', sourceRowId: 'source-row-1'}])
  expect(getWarningCodes(plan)).toEqual(['ambiguous-target-match'])
  expect(plan.warnings).toMatchObject([
    {
      code: 'ambiguous-target-match',
      matchKey: '10.1000/shared',
      matchKind: 'doi',
      sourceRows: [
        {
          articleId: 'source-article-1',
          articleTitle: 'Source title',
          compareProjectId: 'source-comparison-project-1',
          compareProjectName: 'Source comparison project',
          externalArticleId: 'source-ext-1',
          resolutionAnswer: 'yes',
          sourceResolutionId: 'source-resolution-1',
          sourceRowId: 'source-row-1',
        },
      ],
      targetArticles: [
        {articleId: 'target-a', articleTitle: 'Source title'},
        {articleId: 'target-b', articleTitle: 'Source title'},
      ],
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

test('import plan matches title-only source rows by exact normalized title', () => {
  const plan = getPlan({
    sourceRows: [
      getSourceRow({doi: null, externalArticleId: null, sourceExternalArticleId: null, title: ' A Shared Title '}),
    ],
    targetArticles: [getTargetArticle({doi: null, externalArticleId: 'target-ext-1', title: 'a  shared\ntitle'})],
  })

  expect(plan.errors).toEqual([])
  expect(plan.skipCounts).toEqual(getSkipCounts())
  expect(plan.candidates).toEqual([
    {
      resolutionValue: 'yes',
      sourceRows: [{matchKey: 'a shared title', matchKind: 'title', sourceRowId: 'source-row-1'}],
      targetArticleId: 'target-article-1',
    },
  ])
})

test('import plan skips ambiguous title-only target matches', () => {
  const plan = getPlan({
    sourceRows: [getSourceRow({doi: null, externalArticleId: null, sourceExternalArticleId: null, title: 'Shared'})],
    targetArticles: [
      getTargetArticle({articleId: 'target-a', doi: null, externalArticleId: 'target-a-ext', title: 'Shared'}),
      getTargetArticle({articleId: 'target-b', doi: null, externalArticleId: 'target-b-ext', title: ' Shared '}),
    ],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toEqual([])
  expect(plan.skipCounts).toEqual(getSkipCounts({ambiguousTarget: 1}))
  expect(plan.skippedRows).toEqual([{reason: 'ambiguous-target-match', sourceRowId: 'source-row-1'}])
  expect(plan.warnings).toMatchObject([
    {
      code: 'ambiguous-target-match',
      matchKey: 'shared',
      matchKind: 'title',
      targetArticles: [{articleId: 'target-a'}, {articleId: 'target-b'}],
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

test('import plan skips rows when exact canonical identifiers point to different targets', () => {
  const plan = getPlan({
    sourceRows: [
      getSourceRow({
        doi: null,
        externalArticleId: 'source-ext-does-not-match',
        identifiers: [
          {kind: 'pmid', normalizedValue: '12345'},
          {kind: 'arxiv', normalizedValue: '2401.12345'},
        ],
      }),
    ],
    targetArticles: [
      getTargetArticle({
        articleId: 'target-pmid',
        externalArticleId: 'target-pmid-ext',
        identifiers: [{kind: 'pmid', normalizedValue: '12345'}],
      }),
      getTargetArticle({
        articleId: 'target-arxiv',
        externalArticleId: 'target-arxiv-ext',
        identifiers: [{kind: 'arxiv', normalizedValue: '2401.12345'}],
      }),
    ],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toEqual([])
  expect(plan.skipCounts).toEqual(getSkipCounts({conflictingIdentifiers: 1}))
  expect(plan.skippedRows).toEqual([{reason: 'conflicting-identifiers', sourceRowId: 'source-row-1'}])
  expect(plan.warnings).toMatchObject([
    {
      code: 'conflicting-identifiers',
      matchKeys: ['pmid:12345', 'arxiv:2401.12345'],
      targetArticles: [{articleId: 'target-pmid'}, {articleId: 'target-arxiv'}],
    },
  ])
})

test('import plan skips rows with an existing target resolution', () => {
  const plan = getPlan({
    sourceRows: [getSourceRow({doi: '10.1000/existing'})],
    targetArticles: [getTargetArticle({doi: '10.1000/existing', hasExistingResolution: true})],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toEqual([])
  expect(plan.skipCounts).toEqual(getSkipCounts({existingTargetResolution: 1}))
  expect(plan.skippedRows).toEqual([{reason: 'existing-target-resolution', sourceRowId: 'source-row-1'}])
  expect(plan.warnings).toEqual([])
})

test('import plan skips unsupported source resolution modes', () => {
  const plan = getPlan({
    sourceRows: [getSourceRow({doi: '10.1000/prompt-mode', resolutionMode: 'prompt'})],
    targetArticles: [getTargetArticle({doi: '10.1000/prompt-mode'})],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toEqual([])
  expect(plan.skipCounts).toEqual(getSkipCounts({unsupportedMode: 1}))
  expect(plan.skippedRows).toEqual([{reason: 'unsupported-mode', sourceRowId: 'source-row-1'}])
  expect(plan.warnings).toEqual([])
})

test('import plan dedupes duplicate source DOI keys with the same normalized value', () => {
  const plan = getPlan({
    sourceRows: [
      getSourceRow({doi: '10.1000/source-duplicate', externalArticleId: 'source-a', sourceRowId: 'source-doi-a'}),
      getSourceRow({doi: 'DOI:10.1000/source-duplicate', externalArticleId: 'source-b', sourceRowId: 'source-doi-b'}),
    ],
    targetArticles: [getTargetArticle({articleId: 'target-source-doi', doi: '10.1000/source-duplicate'})],
  })

  expect(plan.errors).toEqual([])
  expect(plan.warnings).toEqual([])
  expect(plan.dedupedCount).toBe(1)
  expect(plan.skipCounts).toEqual(getSkipCounts())
  expect(plan.candidates).toEqual([
    {
      resolutionValue: 'yes',
      sourceRows: [
        {matchKey: '10.1000/source-duplicate', matchKind: 'doi', sourceRowId: 'source-doi-a'},
        {matchKey: '10.1000/source-duplicate', matchKind: 'doi', sourceRowId: 'source-doi-b'},
      ],
      targetArticleId: 'target-source-doi',
    },
  ])
})

test('import plan dedupes duplicate source ID/title keys with the same normalized value', () => {
  const plan = getPlan({
    sourceRows: [
      getSourceRow({doi: null, externalArticleId: 'source-shared', sourceRowId: 'source-id-title-a', title: 'Shared'}),
      getSourceRow({
        doi: null,
        externalArticleId: 'SOURCE-SHARED',
        sourceRowId: 'source-id-title-b',
        title: ' Shared ',
      }),
    ],
    targetArticles: [
      getTargetArticle({
        articleId: 'target-source-id-title',
        doi: null,
        externalArticleId: 'source-shared',
        title: 'Shared',
      }),
    ],
  })

  expect(plan.errors).toEqual([])
  expect(plan.warnings).toEqual([])
  expect(plan.dedupedCount).toBe(1)
  expect(plan.skipCounts).toEqual(getSkipCounts())
  expect(plan.candidates).toEqual([
    {
      resolutionValue: 'yes',
      sourceRows: [
        {matchKey: 'source-shared\u001Fshared', matchKind: 'id-title', sourceRowId: 'source-id-title-a'},
        {matchKey: 'source-shared\u001Fshared', matchKind: 'id-title', sourceRowId: 'source-id-title-b'},
      ],
      targetArticleId: 'target-source-id-title',
    },
  ])
})

test('import plan warns and skips duplicate source keys with conflicting normalized values', () => {
  const plan = getPlan({
    sourceRows: [
      getSourceRow({doi: '10.1000/source-conflict', resolutionValue: 'yes', sourceRowId: 'source-doi-a'}),
      getSourceRow({doi: 'DOI:10.1000/source-conflict', resolutionValue: 'no', sourceRowId: 'source-doi-b'}),
    ],
    targetArticles: [getTargetArticle({articleId: 'target-source-doi', doi: '10.1000/source-conflict'})],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toEqual([])
  expect(plan.dedupedCount).toBe(0)
  expect(plan.skipCounts).toEqual(getSkipCounts({conflicting: 2}))
  expect(plan.skippedRows).toEqual([
    {reason: 'conflicting-resolution-values', sourceRowId: 'source-doi-a'},
    {reason: 'conflicting-resolution-values', sourceRowId: 'source-doi-b'},
  ])
  expect(plan.warnings).toMatchObject([
    {
      code: 'conflicting-resolution-values',
      matchKeys: ['10.1000/source-conflict'],
      targetArticles: [{articleId: 'target-source-doi'}],
      values: ['yes', 'no'],
    },
  ])
})

test('import plan ignores duplicate source keys on skipped source rows', () => {
  const plan = getPlan({
    sourceRows: [
      getSourceRow({doi: '10.1000/skipped', sourceRowId: 'source-skipped-a'}),
      getSourceRow({doi: 'DOI:10.1000/skipped', sourceRowId: 'source-skipped-b'}),
    ],
    targetArticles: [],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toEqual([])
  expect(plan.skipCounts).toEqual(getSkipCounts({noTargetMatch: 2}))
})

test('import plan ignores duplicate source ID and title keys when source DOI is usable', () => {
  const plan = getPlan({
    sourceRows: [
      getSourceRow({
        doi: '10.1000/source-a',
        externalArticleId: 'shared-ext',
        sourceRowId: 'source-a',
        title: 'Shared',
      }),
      getSourceRow({
        doi: '10.1000/source-b',
        externalArticleId: 'SHARED-EXT',
        sourceRowId: 'source-b',
        title: ' Shared ',
      }),
    ],
    targetArticles: [
      getTargetArticle({
        articleId: 'target-a',
        doi: '10.1000/source-a',
        externalArticleId: 'target-a-ext',
        title: 'Target A',
      }),
      getTargetArticle({
        articleId: 'target-b',
        doi: '10.1000/source-b',
        externalArticleId: 'target-b-ext',
        title: 'Target B',
      }),
    ],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toMatchObject([
    {sourceRows: [{matchKind: 'doi', sourceRowId: 'source-a'}], targetArticleId: 'target-a'},
    {sourceRows: [{matchKind: 'doi', sourceRowId: 'source-b'}], targetArticleId: 'target-b'},
  ])
})

test('import plan ignores duplicate target ID and title keys when source rows import by DOI', () => {
  const plan = getPlan({
    sourceRows: [
      getSourceRow({
        doi: '10.1000/source-a',
        externalArticleId: 'shared-ext',
        sourceRowId: 'source-a',
        title: 'Shared',
      }),
      getSourceRow({
        doi: '10.1000/source-b',
        externalArticleId: 'SHARED-EXT',
        sourceRowId: 'source-b',
        title: ' Shared ',
      }),
    ],
    targetArticles: [
      getTargetArticle({
        articleId: 'target-a',
        doi: '10.1000/source-a',
        externalArticleId: 'shared-ext',
        title: 'Shared',
      }),
      getTargetArticle({
        articleId: 'target-b',
        doi: '10.1000/source-b',
        externalArticleId: 'SHARED-EXT',
        title: ' Shared ',
      }),
    ],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toMatchObject([
    {sourceRows: [{matchKind: 'doi', sourceRowId: 'source-a'}], targetArticleId: 'target-a'},
    {sourceRows: [{matchKind: 'doi', sourceRowId: 'source-b'}], targetArticleId: 'target-b'},
  ])
})

test('import plan ignores duplicate target DOI keys when no target can import', () => {
  const plan = getPlan({
    sourceRows: [getSourceRow({doi: '10.1000/duplicate', externalArticleId: 'source-ext-does-not-match'})],
    targetArticles: [
      getTargetArticle({
        articleId: 'target-a',
        doi: '10.1000/duplicate',
        externalArticleId: 'target-a-ext',
        isConflictResolutionEligible: false,
      }),
      getTargetArticle({
        articleId: 'target-b',
        doi: 'doi:10.1000/duplicate',
        externalArticleId: 'target-b-ext',
        isConflictResolutionEligible: false,
      }),
    ],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toEqual([])
  expect(plan.skipCounts).toEqual(getSkipCounts({notConflicting: 1}))
})

test('import plan ignores target DOI duplicates unused by fallback imports', () => {
  const plan = getPlan({
    sourceRows: [
      getSourceRow({doi: null, externalArticleId: 'source-a', sourceRowId: 'source-a', title: 'Title A'}),
      getSourceRow({doi: null, externalArticleId: 'source-b', sourceRowId: 'source-b', title: 'Title B'}),
    ],
    targetArticles: [
      getTargetArticle({articleId: 'target-a', doi: '10.1000/shared', externalArticleId: 'source-a', title: 'Title A'}),
      getTargetArticle({
        articleId: 'target-b',
        doi: 'doi:10.1000/shared',
        externalArticleId: 'source-b',
        title: 'Title B',
      }),
    ],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toMatchObject([
    {sourceRows: [{matchKind: 'id-title', sourceRowId: 'source-a'}], targetArticleId: 'target-a'},
    {sourceRows: [{matchKind: 'id-title', sourceRowId: 'source-b'}], targetArticleId: 'target-b'},
  ])
})

test('import plan skips duplicate eligible target ID/title keys with warnings', () => {
  const plan = getPlan({
    sourceRows: [getSourceRow({doi: null, externalArticleId: 'shared-ext', title: 'Shared'})],
    targetArticles: [
      getTargetArticle({
        articleId: 'target-a',
        doi: '10.1000/target-a',
        externalArticleId: 'shared-ext',
        title: 'Shared',
      }),
      getTargetArticle({
        articleId: 'target-b',
        doi: '10.1000/target-b',
        externalArticleId: 'SHARED-EXT',
        title: ' Shared ',
      }),
    ],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toEqual([])
  expect(plan.skipCounts).toEqual(getSkipCounts({ambiguousTarget: 1}))
  expect(plan.skippedRows).toEqual([{reason: 'ambiguous-target-match', sourceRowId: 'source-row-1'}])
  expect(getWarningCodes(plan)).toEqual(['ambiguous-target-match'])
  expect(plan.warnings).toMatchObject([
    {
      code: 'ambiguous-target-match',
      matchKey: 'shared-ext\u001Fshared',
      matchKind: 'id-title',
      targetArticles: [{articleId: 'target-a'}, {articleId: 'target-b'}],
    },
  ])
})

test('import plan ignores ineligible ID/title duplicates when one eligible target can import', () => {
  const plan = getPlan({
    sourceRows: [getSourceRow({doi: null, externalArticleId: 'shared-ext', title: 'Shared'})],
    targetArticles: [
      getTargetArticle({
        articleId: 'target-non-conflicting',
        doi: null,
        externalArticleId: 'shared-ext',
        isConflictResolutionEligible: false,
        title: 'Shared',
      }),
      getTargetArticle({
        articleId: 'target-conflicting',
        doi: null,
        externalArticleId: 'SHARED-EXT',
        isConflictResolutionEligible: true,
        title: ' Shared ',
      }),
    ],
  })

  expect(plan.errors).toEqual([])
  expect(plan.warnings).toEqual([])
  expect(plan.candidates).toMatchObject([{targetArticleId: 'target-conflicting'}])
})

test('import plan searches all fallback targets before skipping', () => {
  const plan = getPlan({
    sourceRows: [getSourceRow({doi: '10.1000/source-only', externalArticleId: 'shared-ext', title: 'Shared'})],
    targetArticles: [
      getTargetArticle({
        articleId: 'target-with-doi',
        doi: '10.1000/other-target',
        externalArticleId: 'shared-ext',
        title: 'Shared',
      }),
      getTargetArticle({
        articleId: 'target-without-doi',
        doi: null,
        externalArticleId: 'SHARED-EXT',
        title: ' Shared ',
      }),
    ],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toMatchObject([
    {sourceRows: [{matchKind: 'id-title', sourceRowId: 'source-row-1'}], targetArticleId: 'target-without-doi'},
  ])
})

test('import plan allows the same target article from DOI and ID/title lookups', () => {
  const plan = getPlan({
    sourceRows: [getSourceRow({doi: '10.1000/source', externalArticleId: 'shared-ext', title: 'Shared title'})],
    targetArticles: [
      getTargetArticle({articleId: 'target-article-1', doi: '10.1000/source', externalArticleId: null, title: null}),
      getTargetArticle({
        articleId: 'target-article-1',
        doi: '10.1000/source',
        externalArticleId: 'shared-ext',
        title: 'Shared title',
      }),
    ],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toMatchObject([{sourceRows: [{matchKind: 'doi'}], targetArticleId: 'target-article-1'}])
})

test('import plan dedupes same-target source rows with the same canonical value', () => {
  const plan = getPlan({
    sourceRows: [
      getSourceRow({
        doi: '10.1000/shared-target',
        resolutionValue: ' yes ',
        sourceComparisonProjectId: 'source-comparison-project-a',
        sourceRowId: 'source-doi',
      }),
      getSourceRow({
        doi: null,
        externalArticleId: 'shared-ext',
        resolutionValue: 'yes',
        sourceComparisonProjectId: 'source-comparison-project-b',
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

  expect(plan.errors).toEqual([])
  expect(plan.warnings).toEqual([])
  expect(plan.dedupedCount).toBe(1)
  expect(plan.skipCounts).toEqual(getSkipCounts())
  expect(plan.candidates).toEqual([
    {
      resolutionValue: 'yes',
      sourceRows: [
        {matchKey: '10.1000/shared-target', matchKind: 'doi', sourceRowId: 'source-doi'},
        {matchKey: 'shared-ext\u001Fshared title', matchKind: 'id-title', sourceRowId: 'source-id-title'},
      ],
      targetArticleId: 'target-shared',
    },
  ])
})

test('import plan warns and skips same-target source rows with conflicting canonical values', () => {
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

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toEqual([])
  expect(plan.dedupedCount).toBe(0)
  expect(plan.skipCounts).toEqual(getSkipCounts({conflicting: 2}))
  expect(plan.skippedRows).toEqual([
    {reason: 'conflicting-resolution-values', sourceRowId: 'source-doi'},
    {reason: 'conflicting-resolution-values', sourceRowId: 'source-id-title'},
  ])
  expect(plan.warnings).toMatchObject([
    {
      code: 'conflicting-resolution-values',
      matchKeys: ['10.1000/shared-target', 'shared-ext\u001Fshared title'],
      targetArticles: [{articleId: 'target-shared'}],
      values: ['yes', 'no'],
    },
  ])
})

test('import plan warns and skips source values missing from target summary options', () => {
  const plan = getPlan({
    sourceRows: [getSourceRow({resolutionValue: 'unclear'})],
    targetArticles: [getTargetArticle()],
    targetSummaryOptionValues: ['yes', 'no'],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toEqual([])
  expect(plan.dedupedCount).toBe(0)
  expect(plan.skipCounts).toEqual(getSkipCounts({invalidValue: 1}))
  expect(plan.skippedRows).toEqual([{reason: 'invalid-target-resolution-value', sourceRowId: 'source-row-1'}])
  expect(plan.warnings).toMatchObject([
    {
      code: 'invalid-target-resolution-value',
      sourceRows: [{sourceRowId: 'source-row-1'}],
      targetArticles: [{articleId: 'target-article-1'}],
      value: 'unclear',
    },
  ])
})

test('import plan ignores invalid resolution values on skipped source rows', () => {
  const plan = getPlan({
    sourceRows: [getSourceRow({doi: '10.1000/source-only', resolutionValue: 'unclear'})],
    targetArticles: [],
    targetSummaryOptionValues: ['yes', 'no'],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toEqual([])
  expect(plan.skipCounts).toEqual(getSkipCounts({noTargetMatch: 1}))
  expect(plan.skippedRows).toEqual([{reason: 'no-target-match', sourceRowId: 'source-row-1'}])
  expect(plan.warnings).toEqual([])
})

test('import plan skips source rows without a usable matching key', () => {
  const plan = getPlan({
    sourceRows: [getSourceRow({doi: null, externalArticleId: ' ', sourceExternalArticleId: null, title: ' '})],
    targetArticles: [getTargetArticle()],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toEqual([])
  expect(plan.skipCounts).toEqual(getSkipCounts({noUsableKey: 1}))
  expect(plan.skippedRows).toEqual([{reason: 'no-usable-key', sourceRowId: 'source-row-1'}])
  expect(plan.warnings).toEqual([])
})

test('import plan skips source rows without a target match', () => {
  const plan = getPlan({
    sourceRows: [getSourceRow({doi: '10.1000/source', externalArticleId: 'shared-ext', title: 'Shared title'})],
    targetArticles: [getTargetArticle({doi: '10.1000/target', externalArticleId: 'shared-ext', title: 'Shared title'})],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toEqual([])
  expect(plan.skipCounts).toEqual(getSkipCounts({noTargetMatch: 1}))
  expect(plan.skippedRows).toEqual([{reason: 'no-target-match', sourceRowId: 'source-row-1'}])
  expect(plan.warnings).toEqual([])
})

test('import plan skips target articles that are not conflict-resolution eligible', () => {
  const plan = getPlan({
    sourceRows: [getSourceRow()],
    targetArticles: [getTargetArticle({isConflictResolutionEligible: false})],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toEqual([])
  expect(plan.skipCounts).toEqual(getSkipCounts({notConflicting: 1}))
  expect(plan.skippedRows).toEqual([{reason: 'not-conflicting', sourceRowId: 'source-row-1'}])
  expect(plan.warnings).toEqual([])
})

test('import plan can include target articles that are not conflict-resolution eligible', () => {
  const plan = getPlan({
    importMode: 'all-matched',
    sourceRows: [getSourceRow()],
    targetArticles: [getTargetArticle({isConflictResolutionEligible: false})],
  })

  expect(plan.errors).toEqual([])
  expect(plan.candidates).toEqual([
    {
      resolutionValue: 'yes',
      sourceRows: [{matchKey: 'source-ext-1\u001Fsource title', matchKind: 'id-title', sourceRowId: 'source-row-1'}],
      targetArticleId: 'target-article-1',
    },
  ])
  expect(plan.skipCounts).toEqual(getSkipCounts())
  expect(plan.skippedRows).toEqual([])
  expect(plan.warnings).toEqual([])
})
