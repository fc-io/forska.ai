export const getComparisonProjectColumnId = (
  kind: 'llm' | 'human',
  promptId: string,
  modelId?: string | null,
  contentKey?: string | null,
  sourceProjectId?: string | null,
) => {
  return kind === 'human'
    ? `human:${promptId}`
    : sourceProjectId
      ? `llm:${sourceProjectId}:${modelId}:${contentKey ?? 'default'}:${promptId}`
      : `llm:${modelId}:${contentKey ?? 'default'}:${promptId}`
}
