export type TokenUseCostFields = {
  modelId?: string | null
  providerConnectionId?: string | null
  providerKind?: string | null
  totalCacheCreationInputTokens?: number | null
  totalCacheReadInputTokens?: number | null
  totalThinkingTokens?: number | null
}

export const getTokenUseCostColumnValues = (summary: TokenUseCostFields & {modelName: string | null}) => {
  return {
    cache_creation_input_tokens: summary.totalCacheCreationInputTokens ?? null,
    cache_read_input_tokens: summary.totalCacheReadInputTokens ?? null,
    model_id: summary.modelId ?? null,
    model_name: summary.modelName ?? null,
    provider_connection_id: summary.providerConnectionId ?? null,
    provider_kind: summary.providerKind ?? null,
    thinking_tokens: summary.totalThinkingTokens ?? null,
  }
}
