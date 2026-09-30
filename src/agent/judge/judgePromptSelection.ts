import type {ArticleRecord} from '../../db/schemaTypes.ts'
import {isImportedFileRoute} from '../../utils/importRouteUtils.ts'
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
import {getSystemPromptVariant, type SystemPromptVariant} from './systemPromptVariant.ts'

const singlePromptSystemPromptByVariant = {
  legacy: {anthropic: SINGLE_PROMPT_SYSTEM_PROMPT_ANTHROPIC, default: SINGLE_PROMPT_SYSTEM_PROMPT},
  screening_v1: {
    anthropic: SINGLE_PROMPT_SYSTEM_PROMPT_SCREENING_V1_ANTHROPIC,
    default: SINGLE_PROMPT_SYSTEM_PROMPT_SCREENING_V1,
  },
} as const satisfies Record<SystemPromptVariant, {anthropic: string; default: string}>

export const isFhirEhrPatientArticle = (article: ArticleRecord): boolean => {
  const articleId = article.articleId ?? ''
  const importRoute = article.importRoute ?? ''
  return articleId.startsWith('fhir:') || importRoute.startsWith('fhir:')
}

const isStructuredImportArticle = (article: ArticleRecord): boolean => {
  return article.fullTextSource === 'structured_file_import' || isImportedFileRoute(article.importRoute)
}

const isAnthropicProvider = (provider: string | null | undefined): boolean => {
  return provider?.toLowerCase() === 'anthropic'
}

const getScientificArticleSystemPrompt = (
  provider: string | null | undefined,
  systemPromptVariant: SystemPromptVariant | null | undefined,
): string => {
  const prompts = singlePromptSystemPromptByVariant[getSystemPromptVariant(systemPromptVariant)]
  return isAnthropicProvider(provider) ? prompts.anthropic : prompts.default
}

export const getSinglePromptSystemPromptForArticle = (
  article: ArticleRecord,
  provider?: string | null,
  systemPromptVariant?: SystemPromptVariant | null,
): string => {
  return isFhirEhrPatientArticle(article)
    ? SINGLE_PROMPT_SYSTEM_PROMPT_PATIENT
    : isStructuredImportArticle(article)
      ? SINGLE_PROMPT_SYSTEM_PROMPT_STRUCTURED_IMPORT
      : getScientificArticleSystemPrompt(provider, systemPromptVariant)
}

export const getSinglePromptEvidenceSystemPromptForArticle = (
  article: ArticleRecord,
  provider?: string | null,
): string => {
  return isFhirEhrPatientArticle(article)
    ? SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT_PATIENT
    : isStructuredImportArticle(article)
      ? SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT_STRUCTURED_IMPORT
      : isAnthropicProvider(provider)
        ? SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT_ANTHROPIC
        : SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT
}
