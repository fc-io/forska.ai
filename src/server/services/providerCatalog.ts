export type ProviderKind =
  | 'openai'
  | 'codex'
  | 'anthropic'
  | 'google'
  | 'openrouter'
  | 'ollama'
  | 'llmstudio'
  | 'sglang'
  | 'vllm'
  | 'unknown'

export type ProviderCatalogEntry = {
  defaultBaseURL: string | null
  description: string
  kind: ProviderKind
  label: string
  requiresApiKey: boolean
  supportsDiscovery: boolean
  supportsWorkerUrls: boolean
}

const providerCatalogEntries: ProviderCatalogEntry[] = [
  {
    defaultBaseURL: 'https://api.openai.com/v1',
    description: 'OpenAI API and compatible gateways',
    kind: 'openai',
    label: 'OpenAI',
    requiresApiKey: true,
    supportsDiscovery: true,
    supportsWorkerUrls: false,
  },
  {
    defaultBaseURL: null,
    description: 'OpenAI Codex CLI and app-server',
    kind: 'codex',
    label: 'Codex',
    requiresApiKey: false,
    supportsDiscovery: true,
    supportsWorkerUrls: false,
  },
  {
    defaultBaseURL: 'https://api.anthropic.com/v1',
    description: 'Anthropic Claude API',
    kind: 'anthropic',
    label: 'Anthropic',
    requiresApiKey: true,
    supportsDiscovery: true,
    supportsWorkerUrls: false,
  },
  {
    defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta',
    description: 'Google Gemini API',
    kind: 'google',
    label: 'Google',
    requiresApiKey: true,
    supportsDiscovery: true,
    supportsWorkerUrls: false,
  },
  {
    defaultBaseURL: 'https://openrouter.ai/api/v1',
    description: 'OpenRouter model routing API',
    kind: 'openrouter',
    label: 'OpenRouter',
    requiresApiKey: true,
    supportsDiscovery: true,
    supportsWorkerUrls: false,
  },
  {
    defaultBaseURL: 'http://127.0.0.1:11434/v1',
    description: 'Local Ollama OpenAI-compatible endpoint',
    kind: 'ollama',
    label: 'Ollama',
    requiresApiKey: false,
    supportsDiscovery: true,
    supportsWorkerUrls: true,
  },
  {
    defaultBaseURL: 'http://127.0.0.1:1234/v1',
    description: 'Local LM Studio OpenAI-compatible endpoint',
    kind: 'llmstudio',
    label: 'LM Studio',
    requiresApiKey: false,
    supportsDiscovery: true,
    supportsWorkerUrls: true,
  },
  {
    defaultBaseURL: 'http://127.0.0.1:30000/v1',
    description: 'SGLang OpenAI-compatible endpoint',
    kind: 'sglang',
    label: 'SGLang',
    requiresApiKey: false,
    supportsDiscovery: true,
    supportsWorkerUrls: true,
  },
  {
    defaultBaseURL: 'http://127.0.0.1:8000/v1',
    description: 'vLLM OpenAI-compatible endpoint',
    kind: 'vllm',
    label: 'vLLM',
    requiresApiKey: false,
    supportsDiscovery: true,
    supportsWorkerUrls: true,
  },
]

export const normalizeProviderKind = (value: string | null | undefined): ProviderKind => {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()

  return providerCatalogEntries.some((entry) => {
    return entry.kind === normalized
  })
    ? (normalized as ProviderKind)
    : 'unknown'
}

export const getProviderCatalog = (): ProviderCatalogEntry[] => {
  return providerCatalogEntries
}

export const getProviderCatalogEntry = (providerKind: string | null | undefined): ProviderCatalogEntry | null => {
  const normalized = normalizeProviderKind(providerKind)

  return (
    providerCatalogEntries.find((entry) => {
      return entry.kind === normalized
    }) ?? null
  )
}

export const getProviderDefaultBaseURL = (providerKind: string | null | undefined): string | null => {
  return getProviderCatalogEntry(providerKind)?.defaultBaseURL ?? null
}

export const isCodexProvider = (providerKind: string | null | undefined): boolean => {
  return normalizeProviderKind(providerKind) === 'codex'
}

export const isAnthropicProvider = (providerKind: string | null | undefined): boolean => {
  return normalizeProviderKind(providerKind) === 'anthropic'
}

export const isGoogleProvider = (providerKind: string | null | undefined): boolean => {
  return normalizeProviderKind(providerKind) === 'google'
}

export const isOpenAICompatibleProvider = (providerKind: string | null | undefined): boolean => {
  const normalized = normalizeProviderKind(providerKind)

  return ['openai', 'openrouter', 'ollama', 'llmstudio', 'sglang', 'vllm'].includes(normalized)
}
