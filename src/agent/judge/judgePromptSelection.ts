import type {ArticleRecord} from '../../db/schemaTypes.ts'
import {isImportedFileRoute} from '../../utils/importRouteUtils.ts'
import {
  SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT,
  SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT_ANTHROPIC,
} from './judgeSinglePromptEvidenceSystemPrompt.ts'
import {SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT_PATIENT} from './judgeSinglePromptEvidenceSystemPromptPatient.ts'
import {SINGLE_PROMPT_EVIDENCE_SYSTEM_PROMPT_STRUCTURED_IMPORT} from './judgeSinglePromptEvidenceSystemPromptStructuredImport.ts'
import {SINGLE_PROMPT_SYSTEM_PROMPT_PATIENT} from './judgeSinglePromptSystemPromptPatient.ts'
import {SINGLE_PROMPT_SYSTEM_PROMPT_STRUCTURED_IMPORT} from './judgeSinglePromptSystemPromptStructuredImport.ts'
import {JUDGE_SYSTEM_PROMPT_VARIANTS, resolveJudgeSystemPromptKey} from './judgeSystemPromptVariants.ts'

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

const getSinglePromptVariantSystemPrompt = (
  provider: string | null | undefined,
  systemPromptKey: string | null | undefined,
): string => {
  const variant = JUDGE_SYSTEM_PROMPT_VARIANTS[resolveJudgeSystemPromptKey(systemPromptKey)]

  return variant.singlePrompt[isAnthropicProvider(provider) ? 'anthropic' : 'default']
}

export const getSinglePromptSystemPromptForArticle = (
  article: ArticleRecord,
  provider?: string | null,
  systemPromptKey?: string | null,
): string => {
  return isFhirEhrPatientArticle(article)
    ? SINGLE_PROMPT_SYSTEM_PROMPT_PATIENT
    : isStructuredImportArticle(article)
      ? SINGLE_PROMPT_SYSTEM_PROMPT_STRUCTURED_IMPORT
      : getSinglePromptVariantSystemPrompt(provider, systemPromptKey)
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
