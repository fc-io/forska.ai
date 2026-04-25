export type PublicationStatus = 'preprint' | 'submitted' | 'accepted' | 'published' | 'retracted'

export type JudgmentsJobStatus =
  | 'not_started'
  | 'waiting_on_llm_connection'
  | 'waiting_on_db_connection'
  | 'running'
  | 'paused'
  | 'failed'
  | 'completed'
  | 'project_removed'

export type JudgmentsJobStorageState = 'missing' | 'active' | 'draining' | 'drained' | 'quarantined'

export type JudgmentsJobsPromptsStatus =
  | 'ready'
  | 'sent'
  | 'judged'
  | 'judged_and_ready_to_remove_from_queue'
  | 'skipped'
export type JudgmentsJobsPromptsSkipReason = 'no_fulltext' | 'conversion_failed' | 'fulltext_too_large'
export type JudgmentChunkingStrategy = 'patient_h3_greedy' | 'article_heading_greedy' | 'article_paragraph_greedy'
export type Engine = 'sglang' | 'vllm'
export type ModelSource = 'discovered' | 'manual'
export type ProjectMartRefreshStatus = 'idle' | 'running' | 'failed' | 'paused'
export type HumanJudgmentMode = 'prompt' | 'summary'
export type ProjectPromptCriteriaDisposition = 'include' | 'exclude' | 'combined'
export type JudgmentHumanSummaryAnswer = 'yes' | 'no' | 'maybe'
export type JudgmentHumanSummaryOrigin = 'covidence_import' | 'manual_override'
export type ProjectMartLargeRebuildPhase =
  | 'judgment_fact'
  | 'prompt_answer_fact'
  | 'review_answer_dictionary'
  | 'review_article_filter_member'
  | 'review_article_rollup'
  | 'review_article_serving'

export type UserRecord = {
  id: string
  name: string
  email: string
  role: string | null
  maintenanceWorkerDuckdbMemoryLimit: string | null
  projectMartLargeRebuildBatchSize: number | null
  projectMartLargeRebuildMaxCyclesPerWake: number | null
  projectMartLargeRebuildPollIntervalMs: number | null
  projectMartLargeRebuildTuningMode: 'automatic' | 'manual'
  unpaywallEmail: string | null
  fullTextConversionModelId: string | null
  createdAt: Date
  updatedAt: Date
}

export type ArticleRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  articleTitle: string
  articleAuthors: string[] | null
  articleCreatedAt: Date | null
  articleUpdatedAt: Date | null
  articleId: string | null
  articleSummary: string | null
  articleVersion: number | null
  arxivId: string | null
  biorxivId: string | null
  medrxivId: string | null
  doi: string | null
  pubmedId: string | null
  url: string | null
  fullTextFetchedAt: Date | null
  fullText: string | null
  fullTextHtml: string | null
  fullTextSource: string | null
  fullTextOriginalFormat: string | null
  fullTextPDF: string | null
  fullTextAssets: unknown
  fullTextConversionStatus: string | null
  fullTextConversionError: string | null
  fullTextConversionAttempts: number | null
  fullTextConversionModelId: string | null
  fullTextConversionMetadata: unknown
  fullTextCharCount: number | null
  contentHash: string | null
  importRoute: string | null
  originalData: unknown
  sourceMetadata: unknown
  publicationStatus: PublicationStatus | null
}

export type ModelRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  providerConnectionId: string
  name: string
  remoteModelId: string | null
  displayName: string | null
  variant: string | null
  source: ModelSource | null
  enabled: boolean
  metadataJson: unknown
}

export type ProviderConnectionRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  providerKind: string
  label: string
  enabled: boolean
  authMode: string | null
  baseURL: string | null
  maxInflightRequests: number | null
  configJson: unknown
  secretRef: string | null
  lastCheckedAt: Date | null
  lastError: string | null
}

export type DataSourceRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  title: string
  description: string | null
  lastImportAt: Date | null
  itemsAfterLastImport: number
  importRoute: string | null
  cursor: string | null
  dateFrom: Date | null
  dateTo: Date | null
  archived: boolean
}

export type ImportRouteRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  route: string
  name: string | null
  description: string | null
  active: boolean
}

export type DataSourceRouteLinkRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  dataSourceId: string
  importRouteId: string
}

export type ProjectRecord = {
  id: string
  name: string
  description: string | null
  modelId: string
  humanJudgmentMode: HumanJudgmentMode | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  dateFrom: Date | null
  dateTo: Date | null
  archived: boolean
  createdAt: Date
  updatedAt: Date
}

export type ProjectRouteLinkRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  projectId: string
  importRouteId: string
}

export type ArticleRouteLinkRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  articleId: string
  importRouteId: string
}

export type ComparisonProjectRecord = {
  id: string
  name: string
  description: string | null
  modelIds: string[] | null
  compareWithHumans: boolean
  humanJudgmentMode: HumanJudgmentMode | null
  summarySourceProjectId: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  archived: boolean
  createdAt: Date
  updatedAt: Date
}

export type ComparisonProjectRouteLinkRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  comparisonProjectId: string
  importRouteId: string
}

export type ComparisonProjectSourceProjectLinkRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  comparisonProjectId: string
  sourceProjectId: string
}

export type JudgmentsJobRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  projectId: string
  status: JudgmentsJobStatus
  error: string[] | null
  storageState: JudgmentsJobStorageState
  quarantinedAt: Date | null
  quarantineReason: string | null
  lastImportStartedAt: Date | null
  lastImportCompletedAt: Date | null
  lastImportErrorAt: Date | null
  lastImportError: string | null
  lastImportExitCode: number | null
  importFailureCount: number
  pauseRequestedAt: Date | null
  sendToLLMBatchSize: number
  sendToLLMInterval: number
  cursorLastCreatedAt: Date | null
  cursorLastArticleId: string | null
}

export type PromptRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  originalText: string
  transformedText: string | null
  archived: boolean
  promptHeading: string | null
  type: string | null
  contentHash: string | null
}

export type JudgmentsJobsPromptRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  jobId: string
  articleId: string
  promptId: string
  serverId: string | null
  sentAt: Date | null
  judgedAt: Date | null
  status: JudgmentsJobsPromptsStatus
  skipReason: JudgmentsJobsPromptsSkipReason | null
}

export type ProjectPromptRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  projectId: string
  promptId: string
  order: number | null
  archived: boolean
  originProjectId: string | null
  enabled: boolean
  criteriaDisposition: ProjectPromptCriteriaDisposition | null
  criteriaSectionKey: string | null
  criteriaSectionLabel: string | null
}

export type ComparisonProjectPromptRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  comparisonProjectId: string
  promptId: string
  order: number | null
  criteriaDisposition: ProjectPromptCriteriaDisposition | null
  criteriaSectionKey: string | null
  criteriaSectionLabel: string | null
}

export type JudgmentRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
  articleId: string
  modelId: string
  promptId: string
  projectId: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  chunkingStrategy: JudgmentChunkingStrategy | null
  isAnswered: boolean
  answeredOriginal: string | null
  answeredOriginalAsArray: string[] | null
  confidenceOriginal: number | null
  explanation: string | null
  quotes: unknown[]
  snapshotProjectId: string | null
  snapshotProjectModelName: string | null
}

export type JudgmentHumanRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  articleId: string
  promptId: string
  isAnswered: boolean
  answer: string | null
  comment: string | null
  projectId: string
}

export type JudgmentHumanSummaryRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  articleId: string
  projectId: string
  answer: JudgmentHumanSummaryAnswer | null
  origin: JudgmentHumanSummaryOrigin
}

export type ProjectArticleRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  projectId: string
  importedFromProjectId: string | null
  articleId: string
}

export type ProjectMartRefreshStateRecord = {
  projectId: string
  dirtyToken: number
  activeRefreshToken: number
  lastCompletedRefreshToken: number
  lastRequestedAt: Date
  lastRequestReason: string | null
  requestedBy: string | null
  refreshStatus: ProjectMartRefreshStatus
  lastStartedAt: Date | null
  lastCompletedAt: Date | null
  lastFailedAt: Date | null
  lastError: string | null
  workerId: string | null
  leaseExpiresAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type ProjectMartRefreshArticleStateRecord = {
  projectId: string
  articleId: string
  firstDirtyToken: number
  lastDirtyToken: number
  createdAt: Date
  updatedAt: Date
}

export type ProjectMartRefreshArticleQuarantineRecord = {
  articleId: string
  error: string
  detectedBy: string | null
  createdAt: Date
  updatedAt: Date
}

export type ProjectMartLargeRebuildStateRecord = {
  projectId: string
  refreshToken: number
  rebuildPhase: ProjectMartLargeRebuildPhase
  cursorArticleCreatedAt: Date | null
  cursorArticleId: string | null
  targetGeneration: number | null
  refreshStatus: ProjectMartRefreshStatus
  lastStartedAt: Date | null
  lastCompletedAt: Date | null
  lastFailedAt: Date | null
  lastError: string | null
  operatorNote: string | null
  workerId: string | null
  leaseExpiresAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type TokenUseRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  judgmentsJobId: string | null
  requests: number
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokens: number
  startedAt: Date | null
  finishedAt: Date | null
  duration: number | null
  gpuNnodes: number | null
  gpuGpusPerNode: number | null
  gpuTotalGpus: number | null
  tpSize: number | null
  dpSize: number | null
  gpuShape: string | null
  sglangMaxRunningRequests: number | null
  sglangModel: string | null
  successfulRequests: number | null
  failedRequests: number | null
  hasFailedRequests: boolean
  failedRequestsDetails: unknown[] | null
  totalSuccessPromptTokens: number | null
  totalSuccessCompletionTokens: number | null
  totalSuccessTokens: number | null
  totalFailedPromptTokens: number | null
  totalFailedCompletionTokens: number | null
  totalFailedTokens: number | null
}

export type JudgmentAssessmentRecord = {
  id: string
  judgmentId: string
  assessmentIsCorrect: boolean
  assessmentComment: string | null
  createdAt: Date
  updatedAt: Date
}

export type LlmStatusRecord = {
  id: string
  ts: Date
  engine: Engine
  instanceId: string
  modelName: string
  engineVersion: string | null
  gpuType: string | null
  gpuCount: number | null
  pollMs: number
  promptTokensTotal: number
  generationTokensTotal: number
  numRequestsTotal: number | null
  cachedTokensTotal: number | null
  numRetractionsCount: number | null
  numQueueReqs: number
  numRunningReqs: number
  numGrammarQueueReqs: number | null
  numRunningReqsOfflineBatch: number | null
  numPrefillPreallocQueueReqs: number | null
  numPrefillInflightQueueReqs: number | null
  numDecodePreallocQueueReqs: number | null
  numDecodeTransferQueueReqs: number | null
  genThroughput: number | null
  tokenUsage: number | null
  utilization: number | null
  cacheHitRate: number | null
  specAcceptRate: number | null
  specAcceptLength: number | null
  isCudaGraph: boolean | null
  swaTokenUsage: number | null
  mambaUsage: number | null
  pendingPreallocTokenUsage: number | null
  kvTransferSpeedGbS: number | null
  kvTransferLatencyMs: number | null
  kvTransferBootstrapMs: number | null
  kvTransferAllocMs: number | null
  prefillTps: number | null
  genTps: number | null
  rps: number | null
  targetGenTps: number | null
  targetPrefillTps: number | null
  inFlight: number | null
  maxInFlight: number | null
  lastAction: string | null
  timeToFirstTokenSeconds: unknown
  e2eRequestLatencySeconds: unknown
  interTokenLatencySeconds: unknown
  perStageReqLatencySeconds: unknown
  queueTimeSeconds: unknown
}

export type NvidiaSmiRecord = {
  id: string
  ts: Date
  instanceId: string
  gpuIndex: number
  gpuUuid: string | null
  gpuName: string | null
  temperatureGpu: number | null
  utilizationGpu: number | null
  utilizationMemory: number | null
  memoryTotalMiB: number | null
  memoryUsedMiB: number | null
  powerDrawWatts: number | null
  powerLimitWatts: number | null
  fanSpeed: number | null
  pstate: string | null
}
