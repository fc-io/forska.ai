import {expect, test} from 'bun:test'

import {
  normalizeArxivIdentifier,
  normalizeBiorxivIdentifier,
  normalizeDoiIdentifier,
  normalizeMedrxivIdentifier,
  normalizePmcidIdentifier,
  normalizePmidIdentifier,
  normalizeSourceRowIdentifiers,
  normalizeTrustedUrlIdentifier,
} from './articleIdentifierNormalization.ts'

test('normalizes DOI prefixes, casing, DOI URLs, and surrounding punctuation', () => {
  expect(normalizeDoiIdentifier(' (DOI:10.1000/ABC-123). ')).toMatchObject({
    identifier: {kind: 'doi', normalizedValue: '10.1000/abc-123'},
    status: 'accepted',
  })
  expect(normalizeDoiIdentifier('https://dx.doi.org/10.5555/MixedCase?source=fixture')).toMatchObject({
    identifier: {kind: 'doi', normalizedValue: '10.5555/mixedcase'},
    status: 'accepted',
  })
})

test('rejects malformed DOI inputs with quarantine detail', () => {
  expect(normalizeDoiIdentifier('10.1000')).toEqual({
    detail: 'DOI must start with 10. and contain a slash after trusted prefix stripping.',
    inputKind: 'doi',
    rawValue: '10.1000',
    reason: 'malformed',
    source: 'doi',
    status: 'rejected',
  })
})

test('normalizes PMID prefixes, PubMed URLs, and leading zero padding', () => {
  expect(normalizePmidIdentifier(' pubmed:00012345 ')).toMatchObject({
    identifier: {kind: 'pmid', normalizedValue: '12345'},
    status: 'accepted',
  })
  expect(normalizePmidIdentifier('https://pubmed.ncbi.nlm.nih.gov/00067890/')).toMatchObject({
    identifier: {kind: 'pmid', normalizedValue: '67890'},
    status: 'accepted',
  })
})

test('rejects zero-only and mixed alphanumeric PMID inputs', () => {
  expect(normalizePmidIdentifier('0000')).toMatchObject({
    detail: 'PMID must not be zero-only after removing leading zero padding.',
    reason: 'malformed',
    status: 'rejected',
  })
  expect(normalizePmidIdentifier('123ABC')).toMatchObject({
    detail: 'PMID must contain ASCII digits only after trusted prefix stripping.',
    reason: 'malformed',
    status: 'rejected',
  })
})

test('normalizes arXiv URL forms and strips version suffixes from strong identifiers', () => {
  expect(normalizeArxivIdentifier('https://arxiv.org/abs/2401.12345v2')).toMatchObject({
    evidence: {sourceVersion: 'v2'},
    identifier: {kind: 'arxiv', normalizedValue: '2401.12345'},
    status: 'accepted',
  })
  expect(normalizeArxivIdentifier('https://arxiv.org/pdf/hep-th/9901001v3.pdf?download=1')).toMatchObject({
    evidence: {sourceVersion: 'v3'},
    identifier: {kind: 'arxiv', normalizedValue: 'hep-th/9901001'},
    status: 'accepted',
  })
})

test('rejects malformed arXiv identifiers', () => {
  expect(normalizeArxivIdentifier('2401')).toMatchObject({
    detail: 'arXiv id must be a modern numeric id or legacy category id after trusted prefix stripping.',
    reason: 'malformed',
    status: 'rejected',
  })
})

test('normalizes bioRxiv and medRxiv URLs as DOI identifiers', () => {
  expect(
    normalizeBiorxivIdentifier('https://www.biorxiv.org/content/10.1101/2024.01.01.123456v2.full.pdf?download=1'),
  ).toMatchObject({
    evidence: {sourceKind: 'biorxiv', sourceVersion: 'v2'},
    identifier: {kind: 'doi', normalizedValue: '10.1101/2024.01.01.123456'},
    status: 'accepted',
  })
  expect(normalizeMedrxivIdentifier('https://www.medrxiv.org/content/10.1101/2024.02.02.654321v3.full')).toMatchObject({
    evidence: {sourceKind: 'medrxiv', sourceVersion: 'v3'},
    identifier: {kind: 'doi', normalizedValue: '10.1101/2024.02.02.654321'},
    status: 'accepted',
  })
})

test('normalizes DOI-shaped preprint values as DOI strong identifiers', () => {
  expect(normalizeBiorxivIdentifier('10.1101/2024.01.01.123456')).toMatchObject({
    identifier: {kind: 'doi', normalizedValue: '10.1101/2024.01.01.123456'},
    status: 'accepted',
  })
  expect(normalizeMedrxivIdentifier('doi:10.1101/2024.02.02.654321')).toMatchObject({
    identifier: {kind: 'doi', normalizedValue: '10.1101/2024.02.02.654321'},
    status: 'accepted',
  })
})

test('normalizes PMCID as metadata only', () => {
  expect(normalizePmcidIdentifier('https://www.ncbi.nlm.nih.gov/pmc/articles/pmc1234567/')).toMatchObject({
    identifier: {kind: 'pmcid', normalizedValue: 'PMC1234567'},
    status: 'metadata',
  })

  const result = normalizeSourceRowIdentifiers([{inputKind: 'pmcid', source: 'pmcid', value: 'pmcid:PMC1234567'}])

  expect(result.strongIdentifiers).toEqual([])
  expect(result.metadataIdentifiers).toEqual([
    {
      evidence: [{inputKind: 'pmcid', normalizedValue: 'PMC1234567', rawValue: 'pmcid:PMC1234567', source: 'pmcid'}],
      kind: 'pmcid',
      normalizedValue: 'PMC1234567',
    },
  ])
})

test('extracts identifiers only from trusted URL patterns', () => {
  expect(normalizeTrustedUrlIdentifier('https://doi.org/10.1000/Trusted')).toMatchObject({
    identifier: {kind: 'doi', normalizedValue: '10.1000/trusted'},
    status: 'accepted',
  })
  expect(normalizeTrustedUrlIdentifier('https://example.org/10.1000/not-trusted')).toMatchObject({
    reason: 'unsupported-url',
    status: 'rejected',
  })
})

test('collapses duplicate normalized identifiers within one source row', () => {
  const result = normalizeSourceRowIdentifiers([
    {inputKind: 'doi', source: 'doi', value: 'https://doi.org/10.1000/Alpha'},
    {inputKind: 'url', source: 'landingUrl', value: 'https://dx.doi.org/10.1000/alpha'},
    {inputKind: 'pmid', source: 'pmid', value: '000123'},
  ])

  expect(result.conflicts).toEqual([])
  expect(result.rejected).toEqual([])
  expect(result.strongIdentifiers).toEqual([
    {
      evidence: [
        {inputKind: 'doi', normalizedValue: '10.1000/alpha', rawValue: 'https://doi.org/10.1000/Alpha', source: 'doi'},
        {
          inputKind: 'url',
          normalizedValue: '10.1000/alpha',
          rawValue: 'https://dx.doi.org/10.1000/alpha',
          source: 'landingUrl',
        },
      ],
      kind: 'doi',
      normalizedValue: '10.1000/alpha',
    },
    {
      evidence: [{inputKind: 'pmid', normalizedValue: '123', rawValue: '000123', source: 'pmid'}],
      kind: 'pmid',
      normalizedValue: '123',
    },
  ])
})

test('represents malformed and disagreeing row identifiers as rejected or conflicted outcomes', () => {
  const result = normalizeSourceRowIdentifiers([
    {inputKind: 'doi', source: 'doi', value: '10.1000/alpha'},
    {inputKind: 'biorxiv', source: 'preprintUrl', value: 'https://www.biorxiv.org/content/10.1101/2024.01.01.123456v1'},
    {inputKind: 'pmid', source: 'pmid', value: '12A'},
  ])

  expect(result.strongIdentifiers).toEqual([])
  expect(result.rejected).toMatchObject([
    {
      detail: 'PMID must contain ASCII digits only after trusted prefix stripping.',
      inputKind: 'pmid',
      rawValue: '12A',
      reason: 'malformed',
      source: 'pmid',
      status: 'rejected',
    },
  ])
  expect(result.conflicts).toEqual([
    {
      candidates: [
        {inputKind: 'doi', normalizedValue: '10.1000/alpha', rawValue: '10.1000/alpha', source: 'doi'},
        {
          inputKind: 'biorxiv',
          normalizedValue: '10.1101/2024.01.01.123456',
          rawValue: 'https://www.biorxiv.org/content/10.1101/2024.01.01.123456v1',
          source: 'preprintUrl',
          sourceKind: 'biorxiv',
          sourceVersion: 'v1',
        },
      ],
      detail: 'doi identifiers disagree within one source row: 10.1000/alpha, 10.1101/2024.01.01.123456',
      kind: 'doi',
      normalizedValues: ['10.1000/alpha', '10.1101/2024.01.01.123456'],
      reason: 'source-row-identifier-disagreement',
      status: 'conflicted',
    },
  ])
})
