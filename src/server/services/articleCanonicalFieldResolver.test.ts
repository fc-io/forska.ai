import {expect, test} from 'bun:test'

import {
  type CanonicalArticleFieldCandidate,
  type CurrentCanonicalArticleFields,
  resolveCanonicalArticleFields,
} from './articleCanonicalFieldResolver.ts'

const getResolverMetadata = (value: unknown) => {
  return value && typeof value === 'object' && 'canonicalResolver' in value
    ? (value as {canonicalResolver: unknown}).canonicalResolver
    : null
}

const getWarnings = (value: unknown) => {
  const metadata = getResolverMetadata(value)

  return metadata && typeof metadata === 'object' && 'warnings' in metadata
    ? (metadata as {warnings: unknown}).warnings
    : null
}

test('resolveCanonicalArticleFields applies source trust before input order', () => {
  const structuredCandidate = {
    articleSummary: 'Reference abstract',
    articleTitle: 'Structured reference title',
    importRoute: 'structured-file:references',
    sourceKind: 'structured_file',
    sourceRecordKey: 'structured-1',
  } satisfies CanonicalArticleFieldCandidate
  const pubmedCandidate = {
    articleSummary: 'Publisher abstract',
    articleTitle: 'PubMed publisher title',
    importRoute: '/api/datasources/import/pubmed',
    pubmedId: '12345',
    sourceKind: 'pubmed',
    sourceRecordKey: 'pubmed-1',
  } satisfies CanonicalArticleFieldCandidate
  const forward = resolveCanonicalArticleFields({candidates: [structuredCandidate, pubmedCandidate], current: null})
  const reversed = resolveCanonicalArticleFields({candidates: [pubmedCandidate, structuredCandidate], current: null})

  expect(forward.articleTitle).toBe('PubMed publisher title')
  expect(reversed.articleTitle).toBe('PubMed publisher title')
  expect(forward.articleSummary).toBe('Publisher abstract')
  expect(reversed.articleSummary).toBe('Publisher abstract')
})

test('resolveCanonicalArticleFields uses completeness as same-source tie-breaker', () => {
  const shortCandidate = {
    articleSummary: 'Short abstract.',
    articleTitle: 'Short title',
    importRoute: '/api/datasources/import/arxiv',
    sourceKind: 'arxiv',
    sourceRecordKey: 'arxiv-short',
  } satisfies CanonicalArticleFieldCandidate
  const completeCandidate = {
    articleSummary: 'Longer abstract with materially more detail.',
    articleTitle: 'A longer and more complete title',
    importRoute: '/api/datasources/import/arxiv',
    sourceKind: 'arxiv',
    sourceRecordKey: 'arxiv-long',
  } satisfies CanonicalArticleFieldCandidate
  const resolved = resolveCanonicalArticleFields({candidates: [shortCandidate, completeCandidate], current: null})

  expect(resolved.articleTitle).toBe('A longer and more complete title')
  expect(resolved.articleSummary).toBe('Longer abstract with materially more detail.')
})

test('resolveCanonicalArticleFields applies canonical URL precedence', () => {
  const resolved = resolveCanonicalArticleFields({
    candidates: [
      {
        articleTitle: 'Article title',
        importRoute: '/api/datasources/import/pubmed',
        pubmedId: '12345',
        sourceKind: 'pubmed',
        sourceRecordKey: 'pubmed',
        url: 'https://publisher.example/articles/12345',
      },
      {
        articleTitle: 'Article title',
        doi: '10.1000/example',
        importRoute: '/api/datasources/import/biorxiv',
        sourceKind: 'biorxiv',
        sourceRecordKey: 'preprint',
        url: 'https://preprint.example/articles/12345',
      },
    ],
    current: null,
  })

  expect(resolved.url).toBe('https://doi.org/10.1000/example')
})

test('resolveCanonicalArticleFields does not downgrade published status to preprint', () => {
  const current = {
    articleTitle: 'Published title',
    publicationStatus: 'published',
    sourceMetadata: {canonicalResolver: {manualFields: {}}},
  } satisfies CurrentCanonicalArticleFields
  const resolved = resolveCanonicalArticleFields({
    candidates: [
      {
        articleTitle: 'Preprint title',
        importRoute: '/api/datasources/import/biorxiv',
        publicationStatus: 'preprint',
        sourceKind: 'biorxiv',
        sourceMetadata: {isPreprint: true},
        sourceRecordKey: 'preprint',
      },
    ],
    current,
  })

  expect(resolved.publicationStatus).toBe('published')
})

test('resolveCanonicalArticleFields unions full-text link hints', () => {
  const resolved = resolveCanonicalArticleFields({
    candidates: [
      {
        articleTitle: 'Article title',
        sourceMetadata: {
          fullTextLinks: [
            {documentStyle: 'pdf', site: 'Publisher', url: 'https://example.org/fulltext.pdf'},
            {documentStyle: 'html', site: 'PMC', url: 'https://example.org/fulltext.html'},
          ],
        },
        sourceRecordKey: 'publisher',
      },
    ],
    current: {
      articleTitle: 'Article title',
      sourceMetadata: {
        fullTextLinks: [{availability: 'Open access', site: 'Publisher', url: 'https://example.org/fulltext.pdf'}],
      },
    },
  })

  expect(resolved.fullTextLinks).toEqual([
    {
      availability: 'Open access',
      availabilityCode: null,
      documentStyle: 'pdf',
      site: 'Publisher',
      url: 'https://example.org/fulltext.pdf',
    },
    {
      availability: null,
      availabilityCode: null,
      documentStyle: 'html',
      site: 'PMC',
      url: 'https://example.org/fulltext.html',
    },
  ])
})

test('resolveCanonicalArticleFields preserves manual values until cleared', () => {
  const current = {
    articleSummary: 'Manual abstract',
    articleTitle: 'Manual title',
    manualFields: {articleSummary: true, articleTitle: true, url: true},
    url: 'https://manual.example/article',
  } satisfies CurrentCanonicalArticleFields
  const imported = {
    articleSummary: 'Publisher abstract with more detail',
    articleTitle: 'Publisher title with more detail',
    doi: '10.1000/manual-clear',
    importRoute: '/api/datasources/import/pubmed',
    sourceKind: 'pubmed',
    sourceRecordKey: 'pubmed',
  } satisfies CanonicalArticleFieldCandidate
  const locked = resolveCanonicalArticleFields({candidates: [imported], current})
  const cleared = resolveCanonicalArticleFields({candidates: [imported], current: {...current, manualFields: {}}})

  expect(locked.articleTitle).toBe('Manual title')
  expect(locked.articleSummary).toBe('Manual abstract')
  expect(locked.url).toBe('https://manual.example/article')
  expect(cleared.articleTitle).toBe('Publisher title with more detail')
  expect(cleared.articleSummary).toBe('Publisher abstract with more detail')
  expect(cleared.url).toBe('https://doi.org/10.1000/manual-clear')
})

test('resolveCanonicalArticleFields reports same-rank material conflicts without last-writer wins', () => {
  const current = {
    articleSummary: 'Existing abstract',
    articleTitle: 'Existing title',
    importRoute: 'structured-file:references',
    sourceKind: 'structured_file',
    sourceRecordKey: 'existing',
  } satisfies CurrentCanonicalArticleFields
  const left = {
    articleTitle: 'Alpha trial',
    importRoute: '/api/datasources/import/arxiv',
    sourceKind: 'arxiv',
    sourceRecordKey: 'candidate-left',
  } satisfies CanonicalArticleFieldCandidate
  const right = {
    articleTitle: 'Omega trial',
    importRoute: '/api/datasources/import/arxiv',
    sourceKind: 'arxiv',
    sourceRecordKey: 'candidate-right',
  } satisfies CanonicalArticleFieldCandidate
  const forward = resolveCanonicalArticleFields({candidates: [left, right], current})
  const reversed = resolveCanonicalArticleFields({candidates: [right, left], current})

  expect(forward.articleTitle).toBe('Existing title')
  expect(reversed.articleTitle).toBe('Existing title')
  expect(forward.warnings).toHaveLength(1)
  expect(getWarnings(forward.sourceMetadata)).toEqual(forward.warnings)
})
