const getTerminalRequestAttemptCloseoutProofLimitSql = (normalizedMaxRows: number | null): string => {
  return normalizedMaxRows === null ? '' : `LIMIT ${normalizedMaxRows}`
}

export const getDurableTerminalQueuePromptProofSql = (normalizedMaxRows: number | null): string => {
  return `
    SELECT request_attempt_manifest_json AS requestAttemptsJson
    FROM queue_prompt
    WHERE request_attempt_manifest_json IS NOT NULL
    ORDER BY ready_insert_seq ASC, id ASC
    ${getTerminalRequestAttemptCloseoutProofLimitSql(normalizedMaxRows)}
  `
}

export const getDurableTerminalOutboxProofSql = (normalizedMaxRows: number | null): string => {
  return `
    SELECT request_attempts_json AS requestAttemptsJson
    FROM judgment_outbox
    WHERE request_attempts_json IS NOT NULL
    ORDER BY outbox_seq ASC
    ${getTerminalRequestAttemptCloseoutProofLimitSql(normalizedMaxRows)}
  `
}

export const getDurableTerminalCompletionAckProofSql = (normalizedMaxRows: number | null): string => {
  return `
    SELECT request_attempts_json AS requestAttemptsJson
    FROM completion_ack
    WHERE request_attempts_json IS NOT NULL
    ORDER BY completed_at ASC, claim_id ASC
    ${getTerminalRequestAttemptCloseoutProofLimitSql(normalizedMaxRows)}
  `
}

export const completionAckCloseoutProofIndexSql = `
  CREATE INDEX IF NOT EXISTS idx_completion_ack_closeout_proof
    ON completion_ack(completed_at, claim_id)
    WHERE request_attempts_json IS NOT NULL;
`
