import type {CronRuntimeClassState, CronRuntimeTickState} from '../../../cron/cronRuntimeState.ts'

export type LlmStatusRow = {
  ts: string
  instanceId: string
  modelName: string
  engineVersion: string | null
  prefillTps: number | null
  genTps: number | null
  rps: number | null
  numQueueReqs: number | null
  numRunningReqs: number | null
  numGrammarQueueReqs: number | null
  numRunningReqsOfflineBatch: number | null
  numPrefillPreallocQueueReqs: number | null
  numPrefillInflightQueueReqs: number | null
  numDecodePreallocQueueReqs: number | null
  numDecodeTransferQueueReqs: number | null
  utilization: number | null
  cacheHitRate: number | null
  inFlight: number | null
  maxInFlight: number | null
}

export type LlmStatusStaleReason =
  | 'ingestion-cron-deferred'
  | 'ingestion-cron-inactive'
  | 'latest-row-stale'
  | 'llm-status-table-missing'
  | 'no-ingested-rows'

export type LlmStatusCronMetadata = {
  duckdbMemoryLimit: string | null
  duckdbMemoryLimitMiB: number | null
  heavyMaintenanceCrons: CronRuntimeClassState
  llmStatusIngestionCron: CronRuntimeTickState
  lowMemoryOwner: boolean
  lowMemoryThresholdMiB: number
  operationalJudgmentCrons: CronRuntimeClassState
  serverRole: string
}

type LlmStatusResponseMetadata = {
  cron: LlmStatusCronMetadata
  generatedAt: string
  isStale: boolean
  latestIngestedAgeMs: number | null
  latestIngestedAt: string | null
  staleAfterMs: number
  staleMessage: string | null
  staleReason: LlmStatusStaleReason | null
  tableExists: boolean | null
}

export type LlmStatusResponseBody = {
  data: LlmStatusRow[]
  hasMetricsCompatibleJob: boolean
  hasMetricsCompatibleRuntime: boolean
  metadata: LlmStatusResponseMetadata
}
