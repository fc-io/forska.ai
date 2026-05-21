import {expect, test} from 'bun:test'

import {
  getProjectTransferIdentifierComparisonKeysForScope,
  getProjectTransferIdentifierOverlapKeys,
  getProjectTransferNormalizedArticleIdentifiers,
  getProjectTransferStrongIdentifierComparisonKeys,
  type ProjectTransferIdentifierComparisonScope,
  projectTransferIdentifierComparisonScopes,
} from './projectTransferIdentifierNormalization.ts'

const articleWithAllStrongIdentifierSources = {
  arxivId: 'https://arxiv.org/abs/2401.12345v2',
  biorxivId: 'https://www.biorxiv.org/content/10.1101/2024.01.01.123456v1.full.pdf',
  doi: 'https://doi.org/10.1101/2024.01.01.123456',
  identifierInputs: [{inputKind: 'medrxiv' as const, source: 'article_identifier', value: '10.1101/2024.01.01.123456'}],
  pubmedId: 'pubmed:00012345',
}

test('uses shared article identifier normalization for every transfer comparison scope', () => {
  const expectedKeys = ['arxiv:2401.12345', 'doi:10.1101/2024.01.01.123456', 'pmid:12345']
  const scopedKeys = projectTransferIdentifierComparisonScopes.map(
    (scope: ProjectTransferIdentifierComparisonScope) => {
      return getProjectTransferIdentifierComparisonKeysForScope({article: articleWithAllStrongIdentifierSources, scope})
    },
  )

  expect(getProjectTransferStrongIdentifierComparisonKeys(articleWithAllStrongIdentifierSources)).toEqual(expectedKeys)
  expect(scopedKeys).toEqual(
    projectTransferIdentifierComparisonScopes.map(() => {
      return expectedKeys
    }),
  )
})

test('keeps bioRxiv and medRxiv accepted as DOI strong identifiers for overlap matching', () => {
  const normalized = getProjectTransferNormalizedArticleIdentifiers(articleWithAllStrongIdentifierSources)
  const left = {biorxivId: 'https://www.biorxiv.org/content/10.1101/2024.01.01.123456v7'}
  const right = {medrxivId: 'doi:10.1101/2024.01.01.123456v2'}

  expect(normalized.conflicts).toEqual([])
  expect(normalized.rejected).toEqual([])
  expect(normalized.strongIdentifiers).toMatchObject([
    {kind: 'doi', normalizedValue: '10.1101/2024.01.01.123456'},
    {kind: 'pmid', normalizedValue: '12345'},
    {kind: 'arxiv', normalizedValue: '2401.12345'},
  ])
  expect(getProjectTransferIdentifierOverlapKeys({left, right, scope: 'overlapSummary'})).toEqual([
    'doi:10.1101/2024.01.01.123456',
  ])
})
