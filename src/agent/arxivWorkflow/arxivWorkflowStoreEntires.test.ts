import {describe, expect, test} from 'bun:test'

import {getArxivIdFromEntryId} from './arxivWorkflowStoreEntires'

describe('getArxivIdFromEntryId', () => {
  test('unwraps a new-style arxiv.org abs URL', () => {
    expect(getArxivIdFromEntryId('http://arxiv.org/abs/2301.00001v2')).toBe('2301.00001v2')
    expect(getArxivIdFromEntryId('https://export.arxiv.org/abs/2301.00001')).toBe('2301.00001')
  })

  test('keeps the last path segment of an old-style id, as before', () => {
    expect(getArxivIdFromEntryId('http://arxiv.org/abs/hep-th/9901001v1')).toBe('9901001v1')
  })

  test('returns a non-arxiv URL unchanged even when its path mentions arxiv.org', () => {
    expect(getArxivIdFromEntryId('https://example.com/arxiv.org/abs/2301.00001')).toBe(
      'https://example.com/arxiv.org/abs/2301.00001',
    )
    expect(getArxivIdFromEntryId('https://arxiv.org.evil.example/abs/2301.00001')).toBe(
      'https://arxiv.org.evil.example/abs/2301.00001',
    )
  })

  test('returns ids that are not URLs unchanged', () => {
    expect(getArxivIdFromEntryId('oai:arXiv.org:2301.00001')).toBe('oai:arXiv.org:2301.00001')
    expect(getArxivIdFromEntryId('2301.00001v1')).toBe('2301.00001v1')
  })

  test('falls back to the full id when the URL has no path segment', () => {
    expect(getArxivIdFromEntryId('http://arxiv.org/abs/')).toBe('http://arxiv.org/abs/')
  })
})
