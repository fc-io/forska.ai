import {describe, expect, test} from 'bun:test'

import type {ArticleRecord} from '../../db/schemaTypes.ts'
import {
  getSinglePromptEvidenceSystemPromptForArticle,
  getSinglePromptSystemPromptForArticle,
} from './judgePromptSelection.ts'
import {
  SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT,
  SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT_ANTHROPIC,
} from './judgeSinglePromptEvidenceSystemPrompt.ts'
import {SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT_PATIENT} from './judgeSinglePromptEvidenceSystemPromptPatient.ts'
import {SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT_STRUCTURED_IMPORT} from './judgeSinglePromptEvidenceSystemPromptStructuredImport.ts'
import {SINGLE_PROMPT_SYSTEM_PROMPT, SINGLE_PROMPT_SYSTEM_PROMPT_ANTHROPIC} from './judgeSinglePromptSystemPrompt.ts'
import {SINGLE_PROMPT_SYSTEM_PROMPT_PATIENT} from './judgeSinglePromptSystemPromptPatient.ts'
import {
  SINGLE_PROMPT_SYSTEM_PROMPT_SCREENING_V1,
  SINGLE_PROMPT_SYSTEM_PROMPT_SCREENING_V1_ANTHROPIC,
} from './judgeSinglePromptSystemPromptScreeningV1.ts'
import {SINGLE_PROMPT_SYSTEM_PROMPT_STRUCTURED_IMPORT} from './judgeSinglePromptSystemPromptStructuredImport.ts'
import {
  COVIDENCE_JUDGE_SYSTEM_PROMPT_KEY,
  DEFAULT_JUDGE_SYSTEM_PROMPT_KEY,
  isJudgeSystemPromptKey,
  JUDGE_SYSTEM_PROMPT_VARIANTS,
  resolveJudgeSystemPromptKey,
} from './judgeSystemPromptVariants.ts'

type PromptSelectionCase = {
  name: string
  article: ArticleRecord
  expectedSystemPrompt: string
  expectedEvidenceSystemPrompt: string
  provider?: string | null
}

const buildArticle = (overrides: Partial<ArticleRecord> = {}): ArticleRecord => {
  const now = new Date('2026-03-26T00:00:00.000Z')
  return {
    id: 'article-1',
    createdAt: now,
    updatedAt: now,
    articleTitle: 'Title',
    articleAuthors: null,
    articleCreatedAt: null,
    articleUpdatedAt: null,
    articleId: 'article:1',
    articleSummary: 'Summary',
    articleVersion: null,
    arxivId: null,
    biorxivId: null,
    medrxivId: null,
    doi: null,
    pubmedId: null,
    url: null,
    fullTextFetchedAt: null,
    fullText: null,
    fullTextHtml: null,
    fullTextSource: null,
    fullTextOriginalFormat: null,
    fullTextPDF: null,
    fullTextAssets: null,
    fullTextConversionStatus: null,
    fullTextConversionError: null,
    fullTextConversionAttempts: null,
    fullTextConversionModelId: null,
    fullTextConversionMetadata: null,
    fullTextCharCount: null,
    contentHash: null,
    importRoute: null,
    originalData: null,
    sourceMetadata: null,
    publicationStatus: null,
    ...overrides,
  }
}

const expectPromptSelection = ({
  article,
  expectedSystemPrompt,
  expectedEvidenceSystemPrompt,
  provider,
}: Omit<PromptSelectionCase, 'name'>) => {
  expect(getSinglePromptSystemPromptForArticle(article, provider)).toBe(expectedSystemPrompt)
  expect(getSinglePromptEvidenceSystemPromptForArticle(article, provider)).toBe(expectedEvidenceSystemPrompt)
}

const registerPromptSelectionCase = ({
  name,
  article,
  expectedSystemPrompt,
  expectedEvidenceSystemPrompt,
  provider,
}: PromptSelectionCase) => {
  test(name, () => {
    expectPromptSelection({article, expectedSystemPrompt, expectedEvidenceSystemPrompt, provider})
  })
}

describe('judge prompt selection', () => {
  ;[
    {
      name: 'uses article prompts for a scientific article',
      article: buildArticle(),
      expectedSystemPrompt: SINGLE_PROMPT_SYSTEM_PROMPT,
      expectedEvidenceSystemPrompt: SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT,
    },
    {
      name: 'uses Anthropic-specific article prompts for a scientific article on Anthropic',
      article: buildArticle(),
      expectedSystemPrompt: SINGLE_PROMPT_SYSTEM_PROMPT_ANTHROPIC,
      expectedEvidenceSystemPrompt: SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT_ANTHROPIC,
      provider: 'anthropic',
    },
    {
      name: 'uses patient prompts for a FHIR patient record',
      article: buildArticle({articleId: 'fhir:patient-1'}),
      expectedSystemPrompt: SINGLE_PROMPT_SYSTEM_PROMPT_PATIENT,
      expectedEvidenceSystemPrompt: SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT_PATIENT,
    },
    {
      name: 'uses structured import prompts for a structured XML record from metadata only',
      article: buildArticle({importRoute: 'structured-file:registry-entry.xml'}),
      expectedSystemPrompt: SINGLE_PROMPT_SYSTEM_PROMPT_STRUCTURED_IMPORT,
      expectedEvidenceSystemPrompt: SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT_STRUCTURED_IMPORT,
    },
  ].map(registerPromptSelectionCase)

  test('uses structured import prompts for a structured JSON import via fullTextSource metadata', () => {
    const article = buildArticle({fullTextSource: 'structured_file_import', fullTextOriginalFormat: 'json'})

    expectPromptSelection({
      article,
      expectedSystemPrompt: SINGLE_PROMPT_SYSTEM_PROMPT_STRUCTURED_IMPORT,
      expectedEvidenceSystemPrompt: SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT_STRUCTURED_IMPORT,
    })
  })

  test('uses structured import prompts for imported-file JSON routes without judging the record', () => {
    const article = buildArticle({
      articleTitle: 'Structured JSON import',
      importRoute: 'imported-file:upload.json',
      sourceMetadata: JSON.stringify({assetPath: 'assets/structured_file_imports/upload.json'}),
    })

    expectPromptSelection({
      article,
      expectedSystemPrompt: SINGLE_PROMPT_SYSTEM_PROMPT_STRUCTURED_IMPORT,
      expectedEvidenceSystemPrompt: SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT_STRUCTURED_IMPORT,
    })
  })

  test('prefers patient prompts over structured import fallback when route is FHIR', () => {
    const article = buildArticle({articleId: 'fhir:patient-1', fullTextSource: 'structured_file_import'})

    expectPromptSelection({
      article,
      expectedSystemPrompt: SINGLE_PROMPT_SYSTEM_PROMPT_PATIENT,
      expectedEvidenceSystemPrompt: SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT_PATIENT,
    })
  })
})

describe('judge system prompt variants', () => {
  test('registers legacy and screening_v1 with the legacy constants imported unchanged', () => {
    expect(Object.keys(JUDGE_SYSTEM_PROMPT_VARIANTS).sort()).toEqual(['legacy', 'screening_v1'])
    expect(DEFAULT_JUDGE_SYSTEM_PROMPT_KEY).toBe('legacy')
    expect(COVIDENCE_JUDGE_SYSTEM_PROMPT_KEY).toBe('screening_v1')
    expect(JUDGE_SYSTEM_PROMPT_VARIANTS.legacy.singlePrompt).toEqual({
      anthropic: SINGLE_PROMPT_SYSTEM_PROMPT_ANTHROPIC,
      default: SINGLE_PROMPT_SYSTEM_PROMPT,
    })
    expect(JUDGE_SYSTEM_PROMPT_VARIANTS.screening_v1.singlePrompt).toEqual({
      anthropic: SINGLE_PROMPT_SYSTEM_PROMPT_SCREENING_V1_ANTHROPIC,
      default: SINGLE_PROMPT_SYSTEM_PROMPT_SCREENING_V1,
    })
    Object.entries(JUDGE_SYSTEM_PROMPT_VARIANTS).map(([key, variant]) => {
      return expect(variant.key).toBe(key as keyof typeof JUDGE_SYSTEM_PROMPT_VARIANTS)
    })
  })

  test('accepts only registered keys', () => {
    expect(isJudgeSystemPromptKey('legacy')).toBe(true)
    expect(isJudgeSystemPromptKey('screening_v1')).toBe(true)
    expect(isJudgeSystemPromptKey('screening_v2')).toBe(false)
    expect(isJudgeSystemPromptKey('Screening_V1')).toBe(false)
    expect(isJudgeSystemPromptKey('toString')).toBe(false)
    expect(isJudgeSystemPromptKey('')).toBe(false)
    expect(isJudgeSystemPromptKey(null)).toBe(false)
    expect(isJudgeSystemPromptKey(undefined)).toBe(false)
    expect(isJudgeSystemPromptKey(1)).toBe(false)
  })

  test('resolves NULL, missing and unknown keys to legacy', () => {
    expect(resolveJudgeSystemPromptKey(null)).toBe('legacy')
    expect(resolveJudgeSystemPromptKey(undefined)).toBe('legacy')
    expect(resolveJudgeSystemPromptKey('screening_v2')).toBe('legacy')
    expect(resolveJudgeSystemPromptKey('screening_v1')).toBe('screening_v1')
  })
  ;[
    {key: null, name: 'NULL', provider: null, expected: SINGLE_PROMPT_SYSTEM_PROMPT},
    {key: undefined, name: 'missing', provider: 'anthropic', expected: SINGLE_PROMPT_SYSTEM_PROMPT_ANTHROPIC},
    {key: 'legacy', name: 'legacy', provider: 'openai', expected: SINGLE_PROMPT_SYSTEM_PROMPT},
    {key: 'legacy', name: 'legacy', provider: 'anthropic', expected: SINGLE_PROMPT_SYSTEM_PROMPT_ANTHROPIC},
    {key: 'screening_v1', name: 'screening_v1', provider: 'openai', expected: SINGLE_PROMPT_SYSTEM_PROMPT_SCREENING_V1},
    {key: 'screening_v1', name: 'screening_v1', provider: null, expected: SINGLE_PROMPT_SYSTEM_PROMPT_SCREENING_V1},
    {
      key: 'screening_v1',
      name: 'screening_v1',
      provider: 'Anthropic',
      expected: SINGLE_PROMPT_SYSTEM_PROMPT_SCREENING_V1_ANTHROPIC,
    },
    {key: 'screening_v2', name: 'unknown', provider: 'openai', expected: SINGLE_PROMPT_SYSTEM_PROMPT},
    {key: 'screening_v2', name: 'unknown', provider: 'anthropic', expected: SINGLE_PROMPT_SYSTEM_PROMPT_ANTHROPIC},
  ].map(({key, name, provider, expected}) => {
    return test(`selects the ${name} key variant for a scientific article on ${provider ?? 'no provider'}`, () => {
      expect(getSinglePromptSystemPromptForArticle(buildArticle(), provider, key)).toBe(expected)
    })
  })

  test('keeps patient and structured import prompts ahead of the variant', () => {
    ;['screening_v1', 'legacy', null].map((key) => {
      expect(getSinglePromptSystemPromptForArticle(buildArticle({articleId: 'fhir:patient-1'}), 'anthropic', key)).toBe(
        SINGLE_PROMPT_SYSTEM_PROMPT_PATIENT,
      )
      return expect(
        getSinglePromptSystemPromptForArticle(
          buildArticle({importRoute: 'structured-file:registry-entry.xml'}),
          'openai',
          key,
        ),
      ).toBe(SINGLE_PROMPT_SYSTEM_PROMPT_STRUCTURED_IMPORT)
    })
  })
})
