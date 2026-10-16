const claudeCodeDefaultMaxInflight = 4

export const getClaudeCodeMaxInflight = (envValues: Record<string, string | undefined> = process.env): number => {
  const configured = Number(String(envValues.FORSKA_CLAUDE_CODE_MAX_INFLIGHT ?? '').trim() || Number.NaN)

  return Number.isFinite(configured) && configured >= 1 ? Math.trunc(configured) : claudeCodeDefaultMaxInflight
}
