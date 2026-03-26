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

type PromptSelectionCase = {
  name: string
  article: ArticleRecord
  expectedSystemPrompt: string
  expectedEvidenceSystemPrompt: string
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
}: Omit<PromptSelectionCase, 'name'>) => {
  expect(getSinglePromptSystemPromptForArticle(article)).toBe(expectedSystemPrompt)
  expect(getSinglePromptEvidenceSystemPromptForArticle(article)).toBe(expectedEvidenceSystemPrompt)
}

const registerPromptSelectionCase = ({
  name,
  article,
  expectedSystemPrompt,
  expectedEvidenceSystemPrompt,
}: PromptSelectionCase) => {
  test(name, () => {
    expectPromptSelection({article, expectedSystemPrompt, expectedEvidenceSystemPrompt})
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
