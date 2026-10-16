import {
  type ClaudeCodeStatus,
  type ProviderAuthLifecycleResult,
  type ProviderConnection,
} from './providerConnectionsClient.ts'

export const getCodexOnboardingUiState = ({
  existingCodexConnection,
  providerAuth,
  providerKind,
}: {
  existingCodexConnection: ProviderConnection | null
  providerAuth: ProviderAuthLifecycleResult | null
  providerKind: string
}) => {
  const providerState =
    typeof providerAuth?.payload?.providerState === 'object' && providerAuth.payload.providerState !== null
      ? (providerAuth.payload.providerState as {appServerReady?: boolean; cli?: {loggedIn?: boolean}})
      : null
  const isCodex = providerKind === 'codex'
  const isConnected = Boolean(existingCodexConnection || providerState?.cli?.loggedIn || providerState?.appServerReady)

  return {
    canCreateProvider:
      isCodex
      && !existingCodexConnection
      && providerAuth?.status === 'complete'
      && Boolean(providerState?.cli?.loggedIn && providerState?.appServerReady),
    shouldHideConnectCard: isCodex && isConnected,
  }
}

export const getClaudeCodeProviderState = (
  providerAuth: ProviderAuthLifecycleResult | null,
): ClaudeCodeStatus | null => {
  const providerState = providerAuth?.payload?.providerState

  return typeof providerState === 'object' && providerState !== null && 'cliAvailable' in providerState
    ? (providerState as ClaudeCodeStatus)
    : null
}

export const getClaudeCodeOnboardingUiState = ({
  existingClaudeCodeConnection,
  providerAuth,
  providerKind,
}: {
  existingClaudeCodeConnection: ProviderConnection | null
  providerAuth: ProviderAuthLifecycleResult | null
  providerKind: string
}) => {
  const providerState = getClaudeCodeProviderState(providerAuth)
  const isClaudeCode = providerKind === 'claude-code'

  return {
    canCreateProvider:
      isClaudeCode
      && !existingClaudeCodeConnection
      && providerAuth?.status === 'complete'
      && Boolean(providerState?.cliAvailable && providerState.loggedIn),
    shouldHideConnectCard: isClaudeCode,
  }
}

export const getConnectionApiKeyUiState = ({
  hasSecret,
  providerKind,
}: {
  hasSecret: boolean
  providerKind: string | null | undefined
}) => {
  const normalizedProviderKind = String(providerKind ?? '')
    .trim()
    .toLowerCase()
  const optionalProviders = ['sglang', 'vllm']
  const requiredApiKeyProviders = ['openai', 'anthropic', 'google', 'openrouter']

  return {
    isOptional: optionalProviders.includes(normalizedProviderKind),
    shouldShowField:
      hasSecret
      || requiredApiKeyProviders.includes(normalizedProviderKind)
      || optionalProviders.includes(normalizedProviderKind),
  }
}
