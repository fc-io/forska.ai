import {expect, test} from 'bun:test'

import type {ArticleRecord} from '../../../db/schemaTypes.ts'
import {
  getProjectTransferLegacyEvidenceSystemPromptDigest,
  projectTransferLegacyEvidenceSystemPromptDigests,
} from './projectTransferLegacyEvidenceSystemPromptDigest.ts'

type LegacyEvidenceArticle = Pick<ArticleRecord, 'articleId' | 'fullTextSource' | 'importRoute'>

const scientificArticle: LegacyEvidenceArticle = {
  articleId: 'pmid:1',
  fullTextSource: 'pdf',
  importRoute: 'covidence:1',
}

test('legacy evidence system prompt digests stay frozen at the values of the deleted evidence prompts', () => {
  expect(projectTransferLegacyEvidenceSystemPromptDigests).toEqual({
    anthropic: '3e95a2b9b34cbf5baa3e8351d541cdfcb045b2179a6947df49a267c5db62482c',
    default: '6cdd5f8c60627808e58b7045a8bd2d79361bcb5ce9bc9b29afdb26983d446a75',
    patient: 'ecb69ab9b2d0d57ed2c301ba8ec1c3f228460bf05acda4ebc7896d3921a1ca3a',
    structuredImport: 'ae5c8a82a7e5867f0cb17865c83840bb6dc0ec282b89eda96a3e4202080849da',
  })
})

test('legacy evidence system prompt digest follows the patient, structured import, anthropic, default branch order', () => {
  const cases: Array<{article: LegacyEvidenceArticle; expected: string; provider: string | null | undefined}> = [
    {
      article: {...scientificArticle, articleId: 'fhir:patient-1'},
      expected: 'ecb69ab9b2d0d57ed2c301ba8ec1c3f228460bf05acda4ebc7896d3921a1ca3a',
      provider: 'anthropic',
    },
    {
      article: {...scientificArticle, importRoute: 'fhir:bundle-1'},
      expected: 'ecb69ab9b2d0d57ed2c301ba8ec1c3f228460bf05acda4ebc7896d3921a1ca3a',
      provider: 'openai',
    },
    {
      article: {articleId: 'fhir:patient-2', fullTextSource: 'structured_file_import', importRoute: 'imported-file:a'},
      expected: 'ecb69ab9b2d0d57ed2c301ba8ec1c3f228460bf05acda4ebc7896d3921a1ca3a',
      provider: 'anthropic',
    },
    {
      article: {...scientificArticle, fullTextSource: 'structured_file_import'},
      expected: 'ae5c8a82a7e5867f0cb17865c83840bb6dc0ec282b89eda96a3e4202080849da',
      provider: 'anthropic',
    },
    {
      article: {...scientificArticle, importRoute: 'imported-file:trial.csv'},
      expected: 'ae5c8a82a7e5867f0cb17865c83840bb6dc0ec282b89eda96a3e4202080849da',
      provider: 'openai',
    },
    {
      article: {...scientificArticle, importRoute: 'structured-file:trial.json'},
      expected: 'ae5c8a82a7e5867f0cb17865c83840bb6dc0ec282b89eda96a3e4202080849da',
      provider: null,
    },
    {
      article: scientificArticle,
      expected: '3e95a2b9b34cbf5baa3e8351d541cdfcb045b2179a6947df49a267c5db62482c',
      provider: 'Anthropic',
    },
    {
      article: scientificArticle,
      expected: '6cdd5f8c60627808e58b7045a8bd2d79361bcb5ce9bc9b29afdb26983d446a75',
      provider: 'codex',
    },
    {
      article: {articleId: null, fullTextSource: null, importRoute: null},
      expected: '6cdd5f8c60627808e58b7045a8bd2d79361bcb5ce9bc9b29afdb26983d446a75',
      provider: undefined,
    },
  ]

  expect(
    cases.map((testCase) => {
      return getProjectTransferLegacyEvidenceSystemPromptDigest(testCase.article, testCase.provider)
    }),
  ).toEqual(
    cases.map((testCase) => {
      return testCase.expected
    }),
  )
})
