export const judgmentJobAutoDrainStatuses = [
  'not_started',
  'running',
  'waiting_on_db_connection',
  'waiting_on_llm_connection',
] as const

export type JudgmentJobRepairMode = 'none' | 'offline_repair_required' | 'safe_live_repair'
export type JudgmentJobStartupHandling = 'auto_drain' | 'idle' | 'skip_offline_repair'

type JudgmentJobStoragePolicyInput = {status: string; storageState: string}

type JudgmentJobStoragePolicySqliteState = {
  claimedOutboxCount: number
  outboxRowCount: number
  retainedRowCount: number
  sqliteFileBytes: number | null
}

export const hasJudgmentJobLocalSqliteState = (sqliteState: JudgmentJobStoragePolicySqliteState) => {
  return (
    sqliteState.sqliteFileBytes !== null
    || sqliteState.outboxRowCount > 0
    || sqliteState.claimedOutboxCount > 0
    || sqliteState.retainedRowCount > 0
  )
}

export const isJudgmentJobAutoDrainCandidate = (job: JudgmentJobStoragePolicyInput) => {
  return (
    job.storageState === 'draining'
    || (job.storageState === 'active'
      && judgmentJobAutoDrainStatuses.includes(job.status as (typeof judgmentJobAutoDrainStatuses)[number]))
  )
}

export const getJudgmentJobRepairMode = ({
  hasLocalSqliteState,
  job,
}: {
  hasLocalSqliteState: boolean
  job: JudgmentJobStoragePolicyInput
}): JudgmentJobRepairMode => {
  if (job.storageState === 'quarantined' && hasLocalSqliteState) {
    return 'offline_repair_required'
  }

  return job.storageState === 'active' || job.storageState === 'draining' || job.storageState === 'missing'
    ? 'safe_live_repair'
    : 'none'
}

export const getJudgmentJobStartupHandling = ({
  hasLocalSqliteState,
  job,
}: {
  hasLocalSqliteState: boolean
  job: JudgmentJobStoragePolicyInput
}): JudgmentJobStartupHandling => {
  if (isJudgmentJobAutoDrainCandidate(job)) {
    return 'auto_drain'
  }

  return getJudgmentJobRepairMode({hasLocalSqliteState, job}) === 'offline_repair_required'
    ? 'skip_offline_repair'
    : 'idle'
}
