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

export type JudgmentsJobsPromptsStatus =
  | 'ready'
  | 'sent'
  | 'judged'
  | 'judged_and_ready_to_remove_from_queue'
  | 'skipped'
export type JudgmentsJobsPromptsSkipReason = 'no_fulltext' | 'conversion_failed' | 'fulltext_too_large'
export type JudgmentChunkingStrategy = 'patient_h3_greedy' | 'article_heading_greedy' | 'article_paragraph_greedy'
export type Engine = 'sglang' | 'vllm'

export type UserRecord = {
  id: string
  name: string
  email: string
  role: string | null
  openalexMailto: string | null
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
  openalexId: string | null
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
  fullTextCharCount: number | null
  contentHash: string | null
  importRoute: string | null
  originalData: unknown
  publicationStatus: PublicationStatus | null
}

export type ModelRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  name: string
  provider: string | null
  baseURL: string | null
  modelName: string | null
  version: string | null
  apiKeyVariable: string | null
  workerUrls: string[] | null
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
  engine: Engine | null
  modelId: string
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

export type ComparisonProjectRouteLinkRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  comparisonProjectId: string
  importRouteId: string
}

export type JudgmentsJobRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  projectId: string
  status: JudgmentsJobStatus
  error: string[] | null
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
}

export type ComparisonProjectPromptRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  comparisonProjectId: string
  promptId: string
  order: number | null
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

export type ProjectArticleRecord = {
  id: string
  createdAt: Date
  updatedAt: Date
  projectId: string
  importedFromProjectId: string | null
  articleId: string
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
