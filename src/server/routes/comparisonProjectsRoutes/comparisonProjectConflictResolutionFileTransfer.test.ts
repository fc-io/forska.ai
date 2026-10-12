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
    validateComparisonProjectConflictResolutionTransferArtifact({...getArtifact(), version: 4})
  }).toThrow('version must be 1, 2 or 3')
  expect(() => {
    validateComparisonProjectConflictResolutionTransferArtifact({
      ...getArtifact(),
      rows: [{...getTransferRow(), provenance: {reviewerDisplayName: 'Dr Source'}}],
    })
  }).toThrow('provenance')
})

test('keeps version 1 artifacts importable next to version 3', () => {
  const versionOneArtifact = {...getArtifact(), version: 1 as const}

  expect(comparisonProjectConflictResolutionTransferVersion).toBe(3)
  expect(validateComparisonProjectConflictResolutionTransferArtifact(versionOneArtifact)).toEqual(versionOneArtifact)
})

test('version 3 artifacts carry per-row provenance and the judgment contexts once at the root', () => {
  const contextId = '2168ca3cc7e7cb3c3fa173f7aeeff04314ed31e83a9b2b201695446a6461922a'
  const rows = getComparisonProjectConflictResolutionTransferRows([
    {
      sourceResolutionId: 'source-resolution-1',
      sourceArticleRowId: 'source-article-row-1',
      externalArticleId: 'external-1',
      title: 'Article title',
      resolutionMode: 'summary',
      resolutionValue: 'yes',
      resolutionLabel: 'Yes',
      provenanceContextId: contextId,
      provenanceOrigin: 'ui',
      provenanceReviewerDisplayName: ' Dr Source ',
      provenanceSetAt: new Date('2026-10-09T08:00:00.000Z'),
    },
    {
      sourceResolutionId: 'source-resolution-2',
      sourceArticleRowId: 'source-article-row-2',
      externalArticleId: 'external-2',
      title: 'Legacy row',
      resolutionMode: 'summary',
      resolutionValue: 'no',
      resolutionLabel: 'No',
      provenanceContextId: null,
      provenanceOrigin: null,
      provenanceReviewerDisplayName: null,
      provenanceSetAt: '2026-09-01T08:00:00.000Z',
    },
  ])
  const artifact = createComparisonProjectConflictResolutionTransferArtifact({
    exportedAt: new Date('2026-10-10T10:00:00.000Z'),
    judgmentContexts: [{context: {v: 1}, id: contextId}],
    rows,
    source: {
      comparisonProjectId: 'comparison-project-1',
      comparisonProjectName: 'Source comparison',
      comparisonProjectDescription: null,
    },
  })

  expect(artifact.version).toBe(3)
  expect(artifact.judgmentContexts).toEqual([{context: {v: 1}, id: contextId}])
  expect(
    artifact.rows.map((row) => {
      return row.provenance
    }),
  ).toEqual([
    {contextId, origin: 'ui', reviewerDisplayName: 'Dr Source', setAt: '2026-10-09T08:00:00.000Z'},
    {contextId: null, origin: null, reviewerDisplayName: null, setAt: '2026-09-01T08:00:00.000Z'},
  ])
  expect(validateComparisonProjectConflictResolutionTransferArtifact(JSON.parse(JSON.stringify(artifact)))).toEqual(
    artifact,
  )
})

test('rows carry the conflict comment when the source row selects it', () => {
  const sourceRow = {
    sourceResolutionId: 'source-resolution-1',
    sourceArticleRowId: 'source-article-row-1',
    externalArticleId: 'external-1',
    title: 'Article title',
    resolutionMode: 'summary' as const,
    resolutionValue: 'yes',
    resolutionLabel: 'Yes',
  }
  const rows = getComparisonProjectConflictResolutionTransferRows([
    {...sourceRow, comment: '  Checked the full text  '},
    {...sourceRow, comment: null, sourceResolutionId: 'source-resolution-2'},
    {...sourceRow, sourceResolutionId: 'source-resolution-3'},
  ])
  const artifact = createComparisonProjectConflictResolutionTransferArtifact({
    exportedAt: new Date('2026-10-10T10:00:00.000Z'),
    rows,
    source: {
      comparisonProjectId: 'comparison-project-1',
      comparisonProjectName: 'Source comparison',
      comparisonProjectDescription: null,
    },
  })

  expect(
    artifact.rows.map((row) => {
      return Object.prototype.hasOwnProperty.call(row, 'comment') ? row.comment : 'absent'
    }),
  ).toEqual(['Checked the full text', null, 'absent'])
  expect(validateComparisonProjectConflictResolutionTransferArtifact(JSON.parse(JSON.stringify(artifact)))).toEqual(
    artifact,
  )
  expect(() => {
    return validateComparisonProjectConflictResolutionTransferArtifact(
      getArtifact({rows: [{...getTransferRow(), comment: 42} as never]}),
    )
  }).toThrow('comment')
})

test('comment-only rows have a null resolution and no provenance, and only version 3 accepts them', () => {
  const rows = getComparisonProjectConflictResolutionTransferRows([
    {
      sourceResolutionId: null,
      sourceArticleRowId: 'source-article-row-1',
      externalArticleId: 'external-1',
      title: 'Article title',
      identifierKind: 'doi',
      identifierNormalizedValue: '10.1000/one',
      identifierSource: 'article_identifier',
      sourceIdentifierId: 'identifier-1',
      resolutionMode: 'summary',
      resolutionValue: null,
      resolutionLabel: null,
      provenanceContextId: null,
      provenanceOrigin: null,
      provenanceReviewerDisplayName: null,
      provenanceSetAt: null,
      comment: '  Waiting for the full text  ',
    },
    {
      sourceResolutionId: null,
      sourceArticleRowId: 'source-article-row-1',
      externalArticleId: 'external-1',
      title: 'Article title',
      identifierKind: 'pmid',
      identifierNormalizedValue: '123',
      identifierSource: 'article_identifier',
      sourceIdentifierId: 'identifier-2',
      resolutionMode: 'summary',
      resolutionValue: null,
      resolutionLabel: null,
      comment: '  Waiting for the full text  ',
    },
  ])
  const artifact = createComparisonProjectConflictResolutionTransferArtifact({
    exportedAt: new Date('2026-10-10T10:00:00.000Z'),
    rows,
    source: {
      comparisonProjectId: 'comparison-project-1',
      comparisonProjectName: 'Source comparison',
      comparisonProjectDescription: null,
    },
  })
  const [commentOnlyRow] = artifact.rows

  expect(artifact.rows).toHaveLength(1)
  expect(commentOnlyRow).toMatchObject({
    comment: 'Waiting for the full text',
    resolution: null,
    sourceArticleRowId: 'source-article-row-1',
    sourceResolutionId: null,
  })
  expect(commentOnlyRow?.identifiers).toHaveLength(2)
  expect(commentOnlyRow).not.toHaveProperty('provenance')
  expect(validateComparisonProjectConflictResolutionTransferArtifact(JSON.parse(JSON.stringify(artifact)))).toEqual(
    artifact,
  )
  expect(() => {
    return validateComparisonProjectConflictResolutionTransferArtifact({...artifact, version: 2})
  }).toThrow('has no resolution')
  expect(() => {
    return validateComparisonProjectConflictResolutionTransferArtifact({
      ...artifact,
      rows: [{...commentOnlyRow, comment: '   '}],
    })
  }).toThrow('has no resolution')
  expect(() => {
    return validateComparisonProjectConflictResolutionTransferArtifact({
      ...artifact,
      rows: [{...getTransferRow(), resolution: null}],
    })
  }).toThrow('row 1 has no resolution')
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
