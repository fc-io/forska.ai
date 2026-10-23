import {t} from 'elysia'

import {systemPromptVariants} from '../../../agent/judge/systemPromptVariant.ts'

export const systemSqliteFallbackStepsSchema = t.Array(
  t.Union([t.Literal('checkpoint'), t.Literal('diagnostic'), t.Literal('export')]),
)
export const judgmentClaimRequestSchema = t.Optional(
  t.Object({
    claimedBy: t.Optional(t.String()),
    limit: t.Optional(t.Number()),
    protectedRecordIds: t.Optional(t.Array(t.String())),
  }),
)
export const judgmentWorkerHeartbeatBodySchema = t.Optional(
  t.Object({claimedBy: t.Optional(t.String()), jobIds: t.Optional(t.Array(t.String()))}),
)
export const judgmentCompletionBodySchema = t.Object({
  articleId: t.String(),
  claimId: t.String(),
  executionSnapshotHash: t.String(),
  executionSnapshotId: t.String(),
  jobId: t.String(),
  modelId: t.String(),
  projectId: t.String(),
  promptId: t.String(),
  queueRecordId: t.String(),
  useAbstract: t.Boolean(),
  useFulltext: t.Boolean(),
  useFulltextNoImages: t.Boolean(),
  useMetadata: t.Optional(t.Boolean()),
  useTitle: t.Boolean(),
  answeredOriginal: t.Optional(t.Any()),
  answeredOriginalAsArray: t.Optional(t.Any()),
  chunkCount: t.Optional(t.Union([t.Integer(), t.Null()])),
  chunkPlanHash: t.Optional(t.Union([t.String(), t.Null()])),
  chunkingStrategy: t.Optional(t.Union([t.String(), t.Null()])),
  confidenceOriginal: t.Optional(t.Number()),
  explanation: t.Optional(t.Union([t.String(), t.Null()])),
  fullTextMode: t.Optional(t.Union([t.Literal('single'), t.Literal('chunked'), t.Null()])),
  fullTextStrategyId: t.Optional(t.Union([t.String(), t.Null()])),
  isAnswered: t.Optional(t.Boolean()),
  judgment: t.Optional(t.Any()),
  judgmentId: t.Optional(t.String()),
  quotes: t.Optional(t.Any()),
  rawResponseJson: t.Optional(t.Any()),
  requestAttempts: t.Optional(t.Union([t.Array(t.Any()), t.Null()])),
  retryAfterMs: t.Optional(t.Union([t.Number(), t.Null()])),
  skipReason: t.Optional(
    t.Union([
      t.Literal('conversion_failed'),
      t.Literal('fulltext_figure_too_large'),
      t.Literal('fulltext_too_large'),
      t.Literal('no_fulltext'),
    ]),
  ),
  status: t.Optional(
    t.Union([
      t.Literal('completed'),
      t.Literal('failed'),
      t.Literal('judged'),
      t.Literal('retry'),
      t.Literal('skipped'),
      t.Literal('succeeded'),
    ]),
  ),
  systemPromptVariant: t.Optional(
    t.Union([
      ...systemPromptVariants.map((systemPromptVariant) => {
        return t.Literal(systemPromptVariant)
      }),
      t.Null(),
    ]),
  ),
  tokenUse: t.Optional(
    t.Union([
      t.Null(),
      t.Object({
        dpSize: t.Optional(t.Union([t.Number(), t.Null()])),
        duration: t.Optional(t.Union([t.Number(), t.Null()])),
        failedRequests: t.Number(),
        failedRequestsDetails: t.Array(t.Any()),
        finishedAt: t.Optional(t.Union([t.String(), t.Null()])),
        gpuGpusPerNode: t.Optional(t.Union([t.Number(), t.Null()])),
        gpuNnodes: t.Optional(t.Union([t.Number(), t.Null()])),
        gpuShape: t.Optional(t.Union([t.String(), t.Null()])),
        gpuTotalGpus: t.Optional(t.Union([t.Number(), t.Null()])),
        hasFailedRequests: t.Boolean(),
        modelName: t.Union([t.String(), t.Null()]),
        sglangMaxRunningRequests: t.Optional(t.Union([t.Number(), t.Null()])),
        startedAt: t.Optional(t.Union([t.String(), t.Null()])),
        successfulRequests: t.Number(),
        tpSize: t.Optional(t.Union([t.Number(), t.Null()])),
        totalCompletionTokens: t.Number(),
        totalFailedCompletionTokens: t.Number(),
        totalFailedPromptTokens: t.Number(),
        totalFailedTokens: t.Number(),
        totalPromptTokens: t.Number(),
        totalRequests: t.Number(),
        totalSuccessCompletionTokens: t.Number(),
        totalSuccessPromptTokens: t.Number(),
        totalSuccessTokens: t.Number(),
        totalTokens: t.Number(),
        requestAttempts: t.Optional(t.Union([t.Array(t.Any()), t.Null()])),
      }),
    ]),
  ),
})
export const judgmentJobStopConditionValueSchema = t.Union([t.Null(), t.Boolean(), t.Number(), t.String()])
export const judgmentSnapshotQuerySchema = t.Object({
  executionSnapshotHash: t.Optional(t.String()),
  hash: t.Optional(t.String()),
  jobId: t.Optional(t.String()),
})
export const judgmentProviderTelemetryHistoryQuerySchema = t.Object({
  jobId: t.String(),
  providerKey: t.Optional(t.String()),
  range: t.Union([t.Literal('5m'), t.Literal('15m'), t.Literal('1h'), t.Literal('24h'), t.Literal('3d')]),
})
