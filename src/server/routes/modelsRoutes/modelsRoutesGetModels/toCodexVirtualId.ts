export const toCodexVirtualId = (modelName: string, effort?: string | null): string => {
  const trimmedEffort = String(effort ?? '').trim()

  return trimmedEffort.length > 0 ? `codex:${modelName}:${trimmedEffort}` : `codex:${modelName}`
}
