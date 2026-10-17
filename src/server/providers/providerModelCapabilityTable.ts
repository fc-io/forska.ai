import {type ProviderKind} from '../services/providerCatalog.ts'

export type ProviderModelCapabilityTableContextWindow = {
  basis: 'anthropic-max-input-equals-context' | 'context-minus-max-output' | 'stated-max-input'
  inputTokens: number
  sourceUrl: string
  totalTokens: number
}

export type ProviderModelCapabilityTableBoolean = {sourceUrl: string; value: boolean}

export type ProviderModelCapabilityTableRow = {
  contextWindow: ProviderModelCapabilityTableContextWindow | null
  providerKind: ProviderKind
  remoteModelId: string
  supportsImageInput: ProviderModelCapabilityTableBoolean | null
  supportsPdfInput: ProviderModelCapabilityTableBoolean | null
  verifiedAt: string
}

const verifiedAt = '2026-10-17'
const openaiModelPage = (modelId: string) => {
  return `https://developers.openai.com/api/docs/models/${modelId}`
}
const claudeModelPage = (slug: string) => {
  return `https://platform.claude.com/docs/en/models/${slug}/overview`
}
const codexAppServerPage = 'https://developers.openai.com/codex/app-server'
const claudePdfSupportPage = 'https://platform.claude.com/docs/en/build-with-claude/pdf-support'

const getCodexRow = ({
  basis,
  inputTokens,
  remoteModelId,
  totalTokens,
}: {
  basis: ProviderModelCapabilityTableContextWindow['basis']
  inputTokens: number
  remoteModelId: string
  totalTokens: number
}): ProviderModelCapabilityTableRow => {
  return {
    contextWindow: {basis, inputTokens, sourceUrl: openaiModelPage(remoteModelId), totalTokens},
    providerKind: 'codex',
    remoteModelId,
    supportsImageInput: {sourceUrl: openaiModelPage(remoteModelId), value: true},
    supportsPdfInput: {sourceUrl: codexAppServerPage, value: false},
    verifiedAt,
  }
}

const getClaudeRow = ({
  pdfSupported,
  providerKind,
  remoteModelId,
  slug,
  totalTokens,
}: {
  pdfSupported: boolean | null
  providerKind: ProviderKind
  remoteModelId: string
  slug: string
  totalTokens: number
}): ProviderModelCapabilityTableRow => {
  return {
    contextWindow: {
      basis: 'anthropic-max-input-equals-context',
      inputTokens: totalTokens,
      sourceUrl: claudeModelPage(slug),
      totalTokens,
    },
    providerKind,
    remoteModelId,
    supportsImageInput: {sourceUrl: claudeModelPage(slug), value: true},
    supportsPdfInput: pdfSupported === null ? null : {sourceUrl: claudePdfSupportPage, value: pdfSupported},
    verifiedAt,
  }
}

const codexStatedMaxInputRows = [
  {inputTokens: 272_000, remoteModelId: 'gpt-5.3-codex', totalTokens: 400_000},
  {inputTokens: 272_000, remoteModelId: 'gpt-5.4-mini', totalTokens: 400_000},
  {inputTokens: 922_000, remoteModelId: 'gpt-5.6-sol', totalTokens: 1_050_000},
  {inputTokens: 922_000, remoteModelId: 'gpt-5.6-terra', totalTokens: 1_050_000},
  {inputTokens: 922_000, remoteModelId: 'gpt-5.6-luna', totalTokens: 1_050_000},
  {inputTokens: 922_000, remoteModelId: 'gpt-6-sol', totalTokens: 1_050_000},
  {inputTokens: 922_000, remoteModelId: 'gpt-6-astra', totalTokens: 1_050_000},
  {inputTokens: 922_000, remoteModelId: 'gpt-6-luna', totalTokens: 1_050_000},
  {inputTokens: 922_000, remoteModelId: 'gpt-6.1-sol', totalTokens: 1_050_000},
].map((row) => {
  return getCodexRow({...row, basis: 'stated-max-input'})
})

const codexDerivedMaxInputRows = [
  {inputTokens: 272_000, remoteModelId: 'gpt-5.2', totalTokens: 400_000},
  {inputTokens: 922_000, remoteModelId: 'gpt-5.4', totalTokens: 1_050_000},
  {inputTokens: 922_000, remoteModelId: 'gpt-5.5', totalTokens: 1_050_000},
].map((row) => {
  return getCodexRow({...row, basis: 'context-minus-max-output'})
})

const codexSparkRow: ProviderModelCapabilityTableRow = {
  contextWindow: null,
  providerKind: 'codex',
  remoteModelId: 'gpt-5.3-codex-spark',
  supportsImageInput: {sourceUrl: 'https://openai.com/index/introducing-gpt-5-3-codex-spark/', value: false},
  supportsPdfInput: {sourceUrl: codexAppServerPage, value: false},
  verifiedAt,
}

const claudeCodeRows = [
  {remoteModelId: 'claude-opus-5-5', slug: 'opus-5-5'},
  {remoteModelId: 'claude-sonnet-5-5', slug: 'sonnet-5-5'},
  {remoteModelId: 'claude-haiku-5-5', slug: 'haiku-5-5'},
].map((row) => {
  return getClaudeRow({...row, pdfSupported: true, providerKind: 'claude-code', totalTokens: 1_000_000})
})

const anthropicRows = [
  {pdfSupported: true, remoteModelId: 'claude-haiku-4-5-20251001', slug: 'haiku-4-5', totalTokens: 200_000},
  {pdfSupported: true, remoteModelId: 'claude-opus-4-5-20251101', slug: 'opus-4-5', totalTokens: 200_000},
  {pdfSupported: null, remoteModelId: 'claude-sonnet-4-5-20250929', slug: 'sonnet-4-5', totalTokens: 200_000},
  {pdfSupported: true, remoteModelId: 'claude-opus-4-6', slug: 'opus-4-6', totalTokens: 1_000_000},
  {pdfSupported: true, remoteModelId: 'claude-opus-4-7', slug: 'opus-4-7', totalTokens: 1_000_000},
  {pdfSupported: true, remoteModelId: 'claude-sonnet-4-6', slug: 'sonnet-4-6', totalTokens: 1_000_000},
  {pdfSupported: true, remoteModelId: 'claude-opus-5-5', slug: 'opus-5-5', totalTokens: 1_000_000},
  {pdfSupported: true, remoteModelId: 'claude-sonnet-5-5', slug: 'sonnet-5-5', totalTokens: 1_000_000},
  {pdfSupported: true, remoteModelId: 'claude-haiku-5-5', slug: 'haiku-5-5', totalTokens: 1_000_000},
  {pdfSupported: true, remoteModelId: 'claude-fable-5-1', slug: 'fable-5-1', totalTokens: 1_000_000},
].map((row) => {
  return getClaudeRow({...row, providerKind: 'anthropic'})
})

export const providerModelCapabilityTable: ProviderModelCapabilityTableRow[] = [
  ...codexStatedMaxInputRows,
  ...codexDerivedMaxInputRows,
  codexSparkRow,
  ...claudeCodeRows,
  ...anthropicRows,
]

const getProviderModelCapabilityTableKey = ({
  providerKind,
  remoteModelId,
}: {
  providerKind: string
  remoteModelId: string
}): string => {
  return `${providerKind}\u0000${remoteModelId}`
}

const providerModelCapabilityTableByKey = new Map(
  providerModelCapabilityTable.map((row) => {
    return [getProviderModelCapabilityTableKey(row), row] as const
  }),
)

export const getProviderModelCapabilityTableRow = ({
  providerKind,
  remoteModelId,
}: {
  providerKind: string | null
  remoteModelId: string | null
}): ProviderModelCapabilityTableRow | null => {
  return providerKind && remoteModelId
    ? (providerModelCapabilityTableByKey.get(getProviderModelCapabilityTableKey({providerKind, remoteModelId})) ?? null)
    : null
}
