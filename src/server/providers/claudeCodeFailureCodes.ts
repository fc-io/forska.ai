export const claudeCodeFailureCodes = {
  cliUnavailable: 'claude_code_cli_unavailable',
  emptyResponse: 'claude_code_empty_response',
  invalidOutput: 'claude_code_invalid_output',
  notLoggedIn: 'claude_code_not_logged_in',
  rateLimited: 'claude_code_rate_limited',
  requestFailed: 'claude_code_request_failed',
  transient: 'claude_code_transient_failure',
  usageLimit: 'claude_code_usage_limit',
} as const

export const claudeCodeRecoverableFailureCodes: string[] = [
  claudeCodeFailureCodes.rateLimited,
  claudeCodeFailureCodes.transient,
  claudeCodeFailureCodes.usageLimit,
]

export const isClaudeCodeFailureCode = (code: string | null | undefined): boolean => {
  return Object.values(claudeCodeFailureCodes).some((failureCode) => {
    return failureCode === code
  })
}
