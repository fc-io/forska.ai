import type {SystemPromptVariant} from '../../../../agent/judge/systemPromptVariant.ts'
import type {JudgmentsJobsPromptsSkipReason} from '../../../../db/schemaTypes.ts'
import type {JudgmentCompletionTokenUseSummary} from '../../../cron/judgmentsJobs/judgmentCompletionTokenUseOutbox.ts'
import type {JudgmentRequestAttemptJsonEntry} from '../../../cron/judgmentsJobs/judgmentRequestAttemptManifest.ts'

export type JudgmentCompletionIdentity = {
  articleId: string
  claimId: string
  executionSnapshotHash: string
  executionSnapshotId: string
  fullTextStrategyId: string
  jobId: string
  modelId: string
  projectId: string
  promptId: string
  queueRecordId: string
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useMetadata: boolean
  useTitle: boolean
}
export type JudgmentCompletionBody = Omit<JudgmentCompletionIdentity, 'fullTextStrategyId' | 'useMetadata'> & {
  answeredOriginal?: unknown
  answeredOriginalAsArray?: unknown
  chunkCount?: number | null
  chunkPlanHash?: string | null
  chunkingStrategy?: string | null
  confidenceOriginal?: number
  explanation?: string | null
  fullTextMode?: string | null
  fullTextStrategyId?: string | null
  isAnswered?: boolean
  judgment?: unknown
  judgmentId?: string
  quotes?: unknown
  rawResponseJson?: unknown
  requestAttempts?: JudgmentRequestAttemptJsonEntry[] | null
  retryAfterMs?: number | null
  skipReason?: JudgmentsJobsPromptsSkipReason
  status?: 'completed' | 'failed' | 'judged' | 'retry' | 'skipped' | 'succeeded'
  systemPromptVariant?: SystemPromptVariant | null
  tokenUse?: JudgmentCompletionTokenUseSummary | null
  useMetadata?: boolean
}
