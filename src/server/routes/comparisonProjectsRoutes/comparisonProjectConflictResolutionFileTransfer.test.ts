import {expect, test} from 'bun:test'

import {
  type ComparisonProjectConflictResolutionTransferArtifactV1,
  comparisonProjectConflictResolutionTransferFormat,
  type ComparisonProjectConflictResolutionTransferRowV1,
  comparisonProjectConflictResolutionTransferVersion,
  createComparisonProjectConflictResolutionTransferArtifact,
  getComparisonProjectConflictResolutionTransferFilename,
  getComparisonProjectConflictResolutionTransferMatchKeys,
  getComparisonProjectConflictResolutionTransferRows,
  normalizeComparisonProjectConflictResolutionTransferDoi,
  validateComparisonProjectConflictResolutionTransferArtifact,
} from './comparisonProjectConflictResolutionFileTransfer.ts'

const getTransferRow = (
  overrides: Partial<ComparisonProjectConflictResolutionTransferRowV1> = {},
): ComparisonProjectConflictResolutionTransferRowV1 => {
  return {
    sourceResolutionId: 'source-resolution-1',
    sourceArticleRowId: 'source-article-row-1',
    externalArticleId: 'external-1',
    title: 'Article title',
    identifiers: [
      {
        sourceIdentifierId: 'source-identifier-doi',
        kind: 'doi',
        normalizedValue: '10.1000/example',
        source: 'doi',
        isPrimary: true,
      },
    ],
    resolution: {mode: 'summary', value: 'yes', label: 'Yes'},
    ...overrides,
  }
}

const getArtifact = (
  overrides: Partial<ComparisonProjectConflictResolutionTransferArtifactV1> = {},
): ComparisonProjectConflictResolutionTransferArtifactV1 => {
  return {
    format: comparisonProjectConflictResolutionTransferFormat,
    version: comparisonProjectConflictResolutionTransferVersion,
    exportedAt: '2026-06-10T10:00:00.000Z',
    source: {
      comparisonProjectId: 'comparison-project-1',
      comparisonProjectName: 'Source comparison',
      comparisonProjectDescription: null,
    },
    rows: [getTransferRow()],
    ...overrides,
  }
}

test('validates V1 conflict resolution transfer artifacts without project transfer metadata', () => {
  const artifact = createComparisonProjectConflictResolutionTransferArtifact({
    exportedAt: new Date('2026-06-10T10:00:00.000Z'),
    source: {
      comparisonProjectId: 'comparison-project-1',
      comparisonProjectName: 'Source comparison',
      comparisonProjectDescription: null,
    },
    rows: [getTransferRow()],
  })
  const validated = validateComparisonProjectConflictResolutionTransferArtifact(artifact)

  expect(Object.keys(validated).sort()).toEqual(['exportedAt', 'format', 'rows', 'source', 'version'])
  expect(validated).toEqual(getArtifact())
  expect(getComparisonProjectConflictResolutionTransferFilename('comparison-project-1')).toBe(
    'conflict-resolutions-comparison-project-1.json',
  )
})

test('rejects invalid conflict resolution transfer artifacts', () => {
  expect(() => {
    validateComparisonProjectConflictResolutionTransferArtifact({
      ...getArtifact(),
      projectTransferSessionId: 'session-1',
    })
  }).toThrow('Unexpected conflict resolution transfer artifact root fields: projectTransferSessionId')
  expect(() => {
    validateComparisonProjectConflictResolutionTransferArtifact({...getArtifact(), version: 2})
  }).toThrow('version must be 1')
})

test('shapes joined source rows with all article identifiers', () => {
  const rows = getComparisonProjectConflictResolutionTransferRows([
    {
      sourceResolutionId: 'source-resolution-1',
      sourceArticleRowId: 'source-article-row-1',
      externalArticleId: 'external-1',
      title: ' Article title ',
      doi: ' 10.1000/Example ',
      pubmedId: ' 12345 ',
      arxivId: ' 2401.12345 ',
      biorxivId: ' 10.1101/2024.01.01.123456 ',
      medrxivId: ' 10.1101/2024.02.02.654321 ',
      url: ' https://example.test/article ',
      sourceIdentifierId: 'source-identifier-pmid',
      identifierKind: 'pmid',
      identifierNormalizedValue: ' 12345 ',
      identifierSource: 'pubmed_id',
      identifierIsPrimary: false,
      resolutionMode: 'summary',
      resolutionValue: ' yes ',
      resolutionLabel: ' Yes ',
    },
    {
      sourceResolutionId: 'source-resolution-1',
      sourceArticleRowId: 'source-article-row-1',
      externalArticleId: 'external-1',
      title: ' Article title ',
      sourceIdentifierId: 'source-identifier-doi',
      identifierKind: 'doi',
      identifierNormalizedValue: ' DOI:10.1000/Example ',
      identifierSource: 'doi',
      identifierIsPrimary: true,
      resolutionMode: 'summary',
      resolutionValue: ' yes ',
      resolutionLabel: ' Yes ',
    },
  ])

  expect(rows).toEqual([
    {
      sourceResolutionId: 'source-resolution-1',
      sourceArticleRowId: 'source-article-row-1',
      externalArticleId: 'external-1',
      title: 'Article title',
      doi: '10.1000/Example',
      pubmedId: '12345',
      arxivId: '2401.12345',
      biorxivId: '10.1101/2024.01.01.123456',
      medrxivId: '10.1101/2024.02.02.654321',
      url: 'https://example.test/article',
      identifiers: [
        {
          sourceIdentifierId: 'source-identifier-doi',
          kind: 'doi',
          normalizedValue: '10.1000/example',
          source: 'doi',
          isPrimary: true,
        },
        {
          sourceIdentifierId: 'source-identifier-pmid',
          kind: 'pmid',
          normalizedValue: '12345',
          source: 'pubmed_id',
          isPrimary: false,
        },
      ],
      resolution: {mode: 'summary', value: 'yes', label: 'Yes'},
    },
  ])
})

test('normalizes DOI identifiers for portable matching', () => {
  expect(normalizeComparisonProjectConflictResolutionTransferDoi(' DOI:10.1000/Example ')).toBe('10.1000/example')
  expect(normalizeComparisonProjectConflictResolutionTransferDoi('https://dx.doi.org/10.1000/Example')).toBe(
    '10.1000/example',
  )
  expect(getComparisonProjectConflictResolutionTransferMatchKeys(getTransferRow())).toEqual([
    {kind: 'doi', value: '10.1000/example'},
    {kind: 'id-title', value: 'external-1\u001Farticle title'},
  ])
})

test('treats title-only rows as portable match keys without using source article row ids', () => {
  const row = getTransferRow({
    sourceArticleRowId: 'external-1',
    externalArticleId: null,
    title: 'Article title',
    identifiers: [],
  })

  expect(getComparisonProjectConflictResolutionTransferMatchKeys(row)).toEqual([
    {kind: 'title', value: 'article title'},
  ])
})
