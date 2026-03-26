import {describe, expect, test} from 'bun:test'

import type {ArticleRecord} from '../../db/schemaTypes.ts'
import {
  getSinglePromptEvidenceSystemPromptForArticle,
  getSinglePromptSystemPromptForArticle,
} from './judgePromptSelection.ts'
import {SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT} from './judgeSinglePromptEvidenceSystemPrompt.ts'
import {SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT_PATIENT} from './judgeSinglePromptEvidenceSystemPromptPatient.ts'
import {SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT_STRUCTURED_IMPORT} from './judgeSinglePromptEvidenceSystemPromptStructuredImport.ts'
import {SINGLE_PROMPT_SYSTEM_PROMPT} from './judgeSinglePromptSystemPrompt.ts'
import {SINGLE_PROMPT_SYSTEM_PROMPT_PATIENT} from './judgeSinglePromptSystemPromptPatient.ts'
import {SINGLE_PROMPT_SYSTEM_PROMPT_STRUCTURED_IMPORT} from './judgeSinglePromptSystemPromptStructuredImport.ts'

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

describe('judge prompt selection', () => {
  test('uses article prompts for scientific articles', () => {
    const article = buildArticle()

    expect(getSinglePromptSystemPromptForArticle(article)).toBe(SINGLE_PROMPT_SYSTEM_PROMPT)
    expect(getSinglePromptEvidenceSystemPromptForArticle(article)).toBe(SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT)
  })

  test('uses patient prompts for FHIR records', () => {
    const article = buildArticle({articleId: 'fhir:patient-1'})

    expect(getSinglePromptSystemPromptForArticle(article)).toBe(SINGLE_PROMPT_SYSTEM_PROMPT_PATIENT)
    expect(getSinglePromptEvidenceSystemPromptForArticle(article)).toBe(SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT_PATIENT)
  })

  test('uses structured import prompts for structured file imports', () => {
    const article = buildArticle({fullTextSource: 'structured_file_import'})

    expect(getSinglePromptSystemPromptForArticle(article)).toBe(SINGLE_PROMPT_SYSTEM_PROMPT_STRUCTURED_IMPORT)
    expect(getSinglePromptEvidenceSystemPromptForArticle(article)).toBe(
      SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT_STRUCTURED_IMPORT,
    )
  })

  test('uses structured import prompts for imported-file routes', () => {
    const article = buildArticle({importRoute: 'imported-file:upload.json'})

    expect(getSinglePromptSystemPromptForArticle(article)).toBe(SINGLE_PROMPT_SYSTEM_PROMPT_STRUCTURED_IMPORT)
    expect(getSinglePromptEvidenceSystemPromptForArticle(article)).toBe(
      SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT_STRUCTURED_IMPORT,
    )
  })

  test('prefers patient prompts over structured import fallback when route is FHIR', () => {
    const article = buildArticle({articleId: 'fhir:patient-1', fullTextSource: 'structured_file_import'})

    expect(getSinglePromptSystemPromptForArticle(article)).toBe(SINGLE_PROMPT_SYSTEM_PROMPT_PATIENT)
    expect(getSinglePromptEvidenceSystemPromptForArticle(article)).toBe(SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT_PATIENT)
  })
})
