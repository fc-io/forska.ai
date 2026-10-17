import type {ArticleRecord} from '../../../db/schemaTypes.ts'

type LegacyEvidenceArticle = Pick<ArticleRecord, 'articleId' | 'fullTextSource' | 'importRoute'>

type LegacyEvidenceSystemPromptDigestRule = {
  digest: string
  matches: (article: LegacyEvidenceArticle, provider: string | null | undefined) => boolean
}

export const projectTransferLegacyEvidenceSystemPromptDigests = {
  anthropic: '3e95a2b9b34cbf5baa3e8351d541cdfcb045b2179a6947df49a267c5db62482c',
  default: '6cdd5f8c60627808e58b7045a8bd2d79361bcb5ce9bc9b29afdb26983d446a75',
  patient: 'ecb69ab9b2d0d57ed2c301ba8ec1c3f228460bf05acda4ebc7896d3921a1ca3a',
  structuredImport: 'ae5c8a82a7e5867f0cb17865c83840bb6dc0ec282b89eda96a3e4202080849da',
} as const

const isLegacyFhirEhrPatientArticle = (article: LegacyEvidenceArticle) => {
  const articleId = article.articleId ?? ''
  const importRoute = article.importRoute ?? ''

  return articleId.startsWith('fhir:') || importRoute.startsWith('fhir:')
}

const isLegacyImportedFileRoute = (route: string | null | undefined) => {
  const routeValue = route ?? ''

  return routeValue.startsWith('imported-file:') || routeValue.startsWith('structured-file:')
}

const isLegacyStructuredImportArticle = (article: LegacyEvidenceArticle) => {
  return article.fullTextSource === 'structured_file_import' || isLegacyImportedFileRoute(article.importRoute)
}

const isLegacyAnthropicProvider = (provider: string | null | undefined) => {
  return provider?.toLowerCase() === 'anthropic'
}

const legacyEvidenceSystemPromptDigestRules: LegacyEvidenceSystemPromptDigestRule[] = [
  {digest: projectTransferLegacyEvidenceSystemPromptDigests.patient, matches: isLegacyFhirEhrPatientArticle},
  {digest: projectTransferLegacyEvidenceSystemPromptDigests.structuredImport, matches: isLegacyStructuredImportArticle},
  {
    digest: projectTransferLegacyEvidenceSystemPromptDigests.anthropic,
    matches: (_article, provider) => {
      return isLegacyAnthropicProvider(provider)
    },
  },
]

export const getProjectTransferLegacyEvidenceSystemPromptDigest = (
  article: LegacyEvidenceArticle,
  provider?: string | null,
): string => {
  return (
    legacyEvidenceSystemPromptDigestRules.find((rule) => {
      return rule.matches(article, provider)
    })?.digest ?? projectTransferLegacyEvidenceSystemPromptDigests.default
  )
}
