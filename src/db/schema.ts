import {sql} from 'drizzle-orm'
import {integer, real, sqliteTable, text, uniqueIndex} from 'drizzle-orm/sqlite-core'

const createId = () => {
  return crypto.randomUUID()
}

const idColumn = () => {
  return text('id').primaryKey().$defaultFn(createId)
}

const createdAtColumn = () => {
  return integer('created_at', {mode: 'timestamp_ms'}).defaultNow().notNull()
}

const updatedAtColumn = () => {
  return integer('updated_at', {mode: 'timestamp_ms'})
    .defaultNow()
    .$onUpdate(() => {
      return new Date()
    })
    .notNull()
}

const booleanColumn = (name: string, defaultValue = false) => {
  return integer(name, {mode: 'boolean'}).default(defaultValue).notNull()
}

const jsonColumn = <T>(name: string) => {
  return text(name, {mode: 'json'}).$type<T>()
}

const publicationStatusValues = ['preprint', 'submitted', 'accepted', 'published', 'retracted'] as const
const judgmentsJobStatusValues = [
  'not_started',
  'waiting_on_llm_connection',
  'waiting_on_db_connection',
  'running',
  'paused',
  'failed',
  'completed',
  'project_removed',
] as const
const judgmentsJobsPromptsStatusValues = [
  'ready',
  'sent',
  'judged',
  'judged_and_ready_to_remove_from_queue',
  'skipped',
] as const
const judgmentsJobsPromptsSkipReasonValues = ['no_fulltext', 'conversion_failed', 'fulltext_too_large'] as const
const judgmentChunkingStrategyValues = [
  'patient_h3_greedy',
  'article_heading_greedy',
  'article_paragraph_greedy',
] as const
const engineValues = ['sglang', 'vllm'] as const

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  role: text('role'),
  openalexMailto: text('openalex_mailto'),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
})

export const articles = sqliteTable('articles', {
  id: idColumn(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
  articleTitle: text('article_title').notNull(),
  articleAuthors: jsonColumn<string[] | null>('article_authors'),
  articleCreatedAt: integer('article_created_at', {mode: 'timestamp_ms'}),
  articleUpdatedAt: integer('article_updated_at', {mode: 'timestamp_ms'}),
  articleId: text('article_id').unique(),
  articleSummary: text('article_summary'),
  articleVersion: integer('article_version'),
  arxivId: text('arxiv_id'),
  openalexId: text('openalex_id'),
  biorxivId: text('biorxiv_id'),
  medrxivId: text('medrxiv_id'),
  doi: text('doi'),
  pubmedId: text('pubmed_id'),
  url: text('url'),
  fullTextFetchedAt: integer('full_text_fetched_at', {mode: 'timestamp_ms'}),
  fullText: text('full_text'),
  fullTextHtml: text('full_text_html'),
  fullTextSource: text('full_text_source'),
  fullTextOriginalFormat: text('full_text_original_format'),
  fullTextPDF: text('full_text_pdf'),
  fullTextAssets: jsonColumn<unknown>('full_text_assets'),
  fullTextConversionStatus: text('full_text_conversion_status'),
  fullTextConversionError: text('full_text_conversion_error'),
  fullTextConversionAttempts: integer('full_text_conversion_attempts').default(0),
  fullTextCharCount: integer('full_text_char_count'),
  contentHash: text('content_hash'),
  importRoute: text('import_route'),
  originalData: jsonColumn<unknown>('original_data'),
  publicationStatus: text('publication_status', {enum: publicationStatusValues}),
})

export const models = sqliteTable('models', {
  id: idColumn(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
  name: text('name').notNull(),
  provider: text('provider'),
  baseURL: text('base_url'),
  modelName: text('model_name'),
  version: text('version'),
  apiKeyVariable: text('api_key_variable'),
  workerUrls: jsonColumn<string[] | null>('worker_urls'),
})

export const dataSource = sqliteTable('datasource', {
  id: idColumn(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
  title: text('title').notNull(),
  description: text('description'),
  lastImportAt: integer('last_import_at', {mode: 'timestamp_ms'}),
  itemsAfterLastImport: integer('items_after_last_import').default(0),
  importRoute: text('import_route'),
  cursor: text('cursor'),
  dateFrom: integer('date_from', {mode: 'timestamp_ms'}),
  dateTo: integer('date_to', {mode: 'timestamp_ms'}),
  archived: booleanColumn('archived'),
})

export const importRoute = sqliteTable(
  'import_route',
  {
    id: idColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    route: text('route').notNull(),
    name: text('name'),
    description: text('description'),
    active: booleanColumn('active', true),
  },
  (table) => {
    return [uniqueIndex('import_route_route_unique').on(table.route)]
  },
)

export const dataSourceRouteLink = sqliteTable(
  'datasource_route_link',
  {
    id: idColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    dataSourceId: text('datasource_id')
      .notNull()
      .references(
        () => {
          return dataSource.id
        },
        {onDelete: 'cascade'},
      ),
    importRouteId: text('import_route_id')
      .notNull()
      .references(
        () => {
          return importRoute.id
        },
        {onDelete: 'cascade'},
      ),
  },
  (table) => {
    return [uniqueIndex('datasource_route_link_unique').on(table.dataSourceId, table.importRouteId)]
  },
)

export const projects = sqliteTable('projects', {
  id: idColumn(),
  name: text('name').notNull(),
  description: text('description'),
  engine: text('engine', {enum: engineValues}),
  modelId: text('model_id')
    .notNull()
    .references(
      () => {
        return models.id
      },
      {onDelete: 'restrict'},
    ),
  useTitle: booleanColumn('use_title', true),
  useAbstract: booleanColumn('use_abstract', true),
  useFulltext: booleanColumn('use_fulltext'),
  useFulltextNoImages: booleanColumn('use_fulltext_no_images'),
  dateFrom: integer('date_from', {mode: 'timestamp_ms'}),
  dateTo: integer('date_to', {mode: 'timestamp_ms'}),
  archived: booleanColumn('archived'),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
})

export const projectRouteLink = sqliteTable(
  'project_route_link',
  {
    id: idColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    projectId: text('project_id')
      .notNull()
      .references(
        () => {
          return projects.id
        },
        {onDelete: 'cascade'},
      ),
    importRouteId: text('import_route_id')
      .notNull()
      .references(
        () => {
          return importRoute.id
        },
        {onDelete: 'cascade'},
      ),
  },
  (table) => {
    return [uniqueIndex('project_route_link_unique').on(table.projectId, table.importRouteId)]
  },
)

export const articleRouteLink = sqliteTable(
  'article_route_link',
  {
    id: idColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    articleId: text('article_id')
      .notNull()
      .references(
        () => {
          return articles.id
        },
        {onDelete: 'cascade'},
      ),
    importRouteId: text('import_route_id')
      .notNull()
      .references(
        () => {
          return importRoute.id
        },
        {onDelete: 'cascade'},
      ),
  },
  (table) => {
    return [uniqueIndex('article_route_link_unique').on(table.articleId, table.importRouteId)]
  },
)

export const comparisonProject = sqliteTable('comparison_project', {
  id: idColumn(),
  name: text('name').notNull(),
  description: text('description'),
  modelIds: jsonColumn<string[] | null>('model_ids'),
  compareWithHumans: booleanColumn('compare_with_humans'),
  useTitle: booleanColumn('use_title', true),
  useAbstract: booleanColumn('use_abstract', true),
  useFulltext: booleanColumn('use_fulltext'),
  useFulltextNoImages: booleanColumn('use_fulltext_no_images'),
  dateFrom: integer('date_from', {mode: 'timestamp_ms'}),
  dateTo: integer('date_to', {mode: 'timestamp_ms'}),
  archived: booleanColumn('archived'),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
})

export const comparisonProjectRouteLink = sqliteTable(
  'comparison_project_route_link',
  {
    id: idColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    comparisonProjectId: text('comparison_project_id')
      .notNull()
      .references(
        () => {
          return comparisonProject.id
        },
        {onDelete: 'cascade'},
      ),
    importRouteId: text('import_route_id')
      .notNull()
      .references(
        () => {
          return importRoute.id
        },
        {onDelete: 'cascade'},
      ),
  },
  (table) => {
    return [uniqueIndex('comparison_project_route_link_unique').on(table.comparisonProjectId, table.importRouteId)]
  },
)

export const judgmentsJobs = sqliteTable('judgments_jobs', {
  id: idColumn(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
  projectId: text('project_id')
    .notNull()
    .references(
      () => {
        return projects.id
      },
      {onDelete: 'cascade'},
    ),
  status: text('status', {enum: judgmentsJobStatusValues}).default('not_started').notNull(),
  error: jsonColumn<string[] | null>('error'),
  sendToLLMBatchSize: integer('send_to_llm_batch_size').default(5).notNull(),
  sendToLLMInterval: integer('send_to_llm_interval').default(15).notNull(),
  cursorLastCreatedAt: integer('cursor_last_created_at', {mode: 'timestamp_ms'}),
  cursorLastArticleId: text('cursor_last_article_id'),
})

export const prompts = sqliteTable(
  'prompts',
  {
    id: idColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    originalText: text('original_text').notNull(),
    transformedText: text('transformed_text'),
    archived: booleanColumn('archived'),
    promptHeading: text('prompt_heading'),
    type: text('type'),
    contentHash: text('content_hash'),
  },
  (table) => {
    return [uniqueIndex('prompts_content_hash_unique').on(table.contentHash)]
  },
)

export const judgmentsJobsPrompts = sqliteTable(
  'judgments_jobs_prompts',
  {
    id: idColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    jobId: text('job_id')
      .notNull()
      .references(
        () => {
          return judgmentsJobs.id
        },
        {onDelete: 'cascade'},
      ),
    articleId: text('article_id')
      .notNull()
      .references(
        () => {
          return articles.id
        },
        {onDelete: 'cascade'},
      ),
    promptId: text('prompt_id')
      .notNull()
      .references(
        () => {
          return prompts.id
        },
        {onDelete: 'cascade'},
      ),
    serverId: text('server_id'),
    sentAt: integer('sent_at', {mode: 'timestamp_ms'}),
    judgedAt: integer('judged_at', {mode: 'timestamp_ms'}),
    status: text('status', {enum: judgmentsJobsPromptsStatusValues}).default('ready').notNull(),
    skipReason: text('skip_reason', {enum: judgmentsJobsPromptsSkipReasonValues}),
  },
  (table) => {
    return [
      uniqueIndex('judgments_jobs_prompts_article_prompt_job_unique').on(table.articleId, table.promptId, table.jobId),
    ]
  },
)

export const projectPrompts = sqliteTable(
  'project_prompts',
  {
    id: idColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    projectId: text('project_id')
      .notNull()
      .references(
        () => {
          return projects.id
        },
        {onDelete: 'cascade'},
      ),
    promptId: text('prompt_id')
      .notNull()
      .references(
        () => {
          return prompts.id
        },
        {onDelete: 'cascade'},
      ),
    order: integer('order'),
    archived: booleanColumn('archived'),
    originProjectId: text('origin_project_id').references(
      () => {
        return projects.id
      },
      {onDelete: 'set null'},
    ),
    enabled: booleanColumn('enabled', true),
  },
  (table) => {
    return [uniqueIndex('project_prompts_unique').on(table.projectId, table.promptId)]
  },
)

export const comparisonProjectPrompt = sqliteTable(
  'comparison_project_prompt',
  {
    id: idColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    comparisonProjectId: text('comparison_project_id')
      .notNull()
      .references(
        () => {
          return comparisonProject.id
        },
        {onDelete: 'cascade'},
      ),
    promptId: text('prompt_id')
      .notNull()
      .references(
        () => {
          return prompts.id
        },
        {onDelete: 'cascade'},
      ),
    order: integer('order'),
  },
  (table) => {
    return [uniqueIndex('comparison_project_prompt_unique').on(table.comparisonProjectId, table.promptId)]
  },
)

export const judgments = sqliteTable(
  'judgments',
  {
    id: idColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: integer('deleted_at', {mode: 'timestamp_ms'}),
    articleId: text('article_id')
      .notNull()
      .references(
        () => {
          return articles.id
        },
        {onDelete: 'restrict'},
      ),
    modelId: text('model_id')
      .notNull()
      .references(
        () => {
          return models.id
        },
        {onDelete: 'cascade'},
      ),
    promptId: text('prompt_id')
      .notNull()
      .references(
        () => {
          return prompts.id
        },
        {onDelete: 'restrict'},
      ),
    projectId: text('project_id').references(
      () => {
        return projects.id
      },
      {onDelete: 'set null'},
    ),
    useTitle: booleanColumn('use_title', true),
    useAbstract: booleanColumn('use_abstract', true),
    useFulltext: booleanColumn('use_fulltext'),
    useFulltextNoImages: booleanColumn('use_fulltext_no_images'),
    chunkingStrategy: text('chunking_strategy', {enum: judgmentChunkingStrategyValues}),
    isAnswered: integer('is_answered', {mode: 'boolean'}).default(false),
    answeredOriginal: text('answered_original'),
    answeredOriginalAsArray: jsonColumn<string[] | null>('answered_original_as_array'),
    confidenceOriginal: integer('confidence_original').default(50),
    explanation: text('explanation'),
    quotes: jsonColumn<unknown[]>('quotes').default([]).notNull(),
    snapshotProjectId: text('snapshot_project_id'),
    snapshotProjectModelName: text('snapshot_project_model_name'),
  },
  (table) => {
    return [
      uniqueIndex('judgments_article_prompt_model_content_unique')
        .on(
          table.articleId,
          table.promptId,
          table.modelId,
          table.useTitle,
          table.useAbstract,
          table.useFulltext,
          table.useFulltextNoImages,
        )
        .where(sql`${table.deletedAt} IS NULL`),
    ]
  },
)

export const judgmentsHuman = sqliteTable(
  'judgments_human',
  {
    id: idColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    articleId: text('article_id')
      .notNull()
      .references(
        () => {
          return articles.id
        },
        {onDelete: 'restrict'},
      ),
    promptId: text('prompt_id')
      .notNull()
      .references(
        () => {
          return prompts.id
        },
        {onDelete: 'restrict'},
      ),
    isAnswered: booleanColumn('is_answered'),
    answer: text('answer'),
    comment: text('comment'),
    projectId: text('project_id')
      .notNull()
      .references(
        () => {
          return projects.id
        },
        {onDelete: 'cascade'},
      ),
  },
  (table) => {
    return [
      uniqueIndex('judgments_human_project_article_prompt_unique').on(table.projectId, table.articleId, table.promptId),
    ]
  },
)

export const projectArticles = sqliteTable(
  'project_articles',
  {
    id: idColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    projectId: text('project_id')
      .notNull()
      .references(
        () => {
          return projects.id
        },
        {onDelete: 'cascade'},
      ),
    importedFromProjectId: text('imported_from_project_id').references(
      () => {
        return projects.id
      },
      {onDelete: 'set null'},
    ),
    articleId: text('article_id')
      .notNull()
      .references(
        () => {
          return articles.id
        },
        {onDelete: 'cascade'},
      ),
  },
  (table) => {
    return [uniqueIndex('project_articles_unique').on(table.projectId, table.articleId)]
  },
)

export const tokenUse = sqliteTable('token_use', {
  id: idColumn(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
  judgmentsJobId: text('judgments_job_id').references(
    () => {
      return judgmentsJobs.id
    },
    {onDelete: 'set null'},
  ),
  requests: integer('requests').notNull(),
  totalPromptTokens: integer('total_prompt_tokens').notNull(),
  totalCompletionTokens: integer('total_completion_tokens').notNull(),
  totalTokens: integer('total_tokens').notNull(),
  startedAt: integer('started_at', {mode: 'timestamp_ms'}),
  finishedAt: integer('finished_at', {mode: 'timestamp_ms'}),
  duration: integer('duration'),
  gpuNnodes: integer('gpu_nnodes'),
  gpuGpusPerNode: integer('gpu_gpus_per_node'),
  gpuTotalGpus: integer('gpu_total_gpus'),
  tpSize: integer('tp_size'),
  dpSize: integer('dp_size'),
  gpuShape: text('gpu_shape'),
  sglangMaxRunningRequests: integer('sglang_max_running_requests'),
  sglangModel: text('sglang_model'),
  successfulRequests: integer('successful_requests'),
  failedRequests: integer('failed_requests'),
  hasFailedRequests: booleanColumn('has_failed_requests'),
  failedRequestsDetails: jsonColumn<unknown[] | null>('failed_requests_details'),
  totalSuccessPromptTokens: integer('total_success_prompt_tokens'),
  totalSuccessCompletionTokens: integer('total_success_completion_tokens'),
  totalSuccessTokens: integer('total_success_tokens'),
  totalFailedPromptTokens: integer('total_failed_prompt_tokens'),
  totalFailedCompletionTokens: integer('total_failed_completion_tokens'),
  totalFailedTokens: integer('total_failed_tokens'),
})

export const judgmentAssessments = sqliteTable(
  'judgment_assessments',
  {
    id: idColumn(),
    judgmentId: text('judgment_id')
      .notNull()
      .references(
        () => {
          return judgments.id
        },
        {onDelete: 'cascade'},
      ),
    assessmentIsCorrect: integer('assessment_is_correct', {mode: 'boolean'}).notNull(),
    assessmentComment: text('assessment_comment'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => {
    return [uniqueIndex('judgment_assessments_judgment_unique').on(table.judgmentId)]
  },
)

export const llmStatus = sqliteTable('llm_status', {
  id: idColumn(),
  ts: integer('ts', {mode: 'timestamp_ms'}).defaultNow().notNull(),
  engine: text('engine', {enum: engineValues}).notNull(),
  instanceId: text('instance_id').notNull(),
  modelName: text('model_name').notNull(),
  engineVersion: text('engine_version'),
  gpuType: text('gpu_type'),
  gpuCount: integer('gpu_count'),
  pollMs: integer('poll_ms').notNull().default(2000),
  promptTokensTotal: integer('prompt_tokens_total').notNull().default(0),
  generationTokensTotal: integer('generation_tokens_total').notNull().default(0),
  numRequestsTotal: integer('num_requests_total'),
  cachedTokensTotal: integer('cached_tokens_total'),
  numRetractionsCount: integer('num_retractions_count'),
  numQueueReqs: integer('num_queue_reqs').notNull().default(0),
  numRunningReqs: integer('num_running_reqs').notNull().default(0),
  numGrammarQueueReqs: integer('num_grammar_queue_reqs'),
  numRunningReqsOfflineBatch: integer('num_running_reqs_offline_batch'),
  numPrefillPreallocQueueReqs: integer('num_prefill_prealloc_queue_reqs'),
  numPrefillInflightQueueReqs: integer('num_prefill_inflight_queue_reqs'),
  numDecodePreallocQueueReqs: integer('num_decode_prealloc_queue_reqs'),
  numDecodeTransferQueueReqs: integer('num_decode_transfer_queue_reqs'),
  genThroughput: real('gen_throughput'),
  tokenUsage: real('token_usage'),
  utilization: real('utilization'),
  cacheHitRate: real('cache_hit_rate'),
  specAcceptRate: real('spec_accept_rate'),
  specAcceptLength: real('spec_accept_length'),
  isCudaGraph: integer('is_cuda_graph', {mode: 'boolean'}),
  swaTokenUsage: real('swa_token_usage'),
  mambaUsage: real('mamba_usage'),
  pendingPreallocTokenUsage: real('pending_prealloc_token_usage'),
  kvTransferSpeedGbS: real('kv_transfer_speed_gb_s'),
  kvTransferLatencyMs: real('kv_transfer_latency_ms'),
  kvTransferBootstrapMs: real('kv_transfer_bootstrap_ms'),
  kvTransferAllocMs: real('kv_transfer_alloc_ms'),
  prefillTps: real('prefill_tps'),
  genTps: real('gen_tps'),
  rps: real('rps'),
  targetGenTps: real('target_gen_tps'),
  targetPrefillTps: real('target_prefill_tps'),
  inFlight: integer('in_flight'),
  maxInFlight: integer('max_in_flight'),
  lastAction: text('last_action'),
  timeToFirstTokenSeconds: jsonColumn<unknown>('time_to_first_token_seconds'),
  e2eRequestLatencySeconds: jsonColumn<unknown>('e2e_request_latency_seconds'),
  interTokenLatencySeconds: jsonColumn<unknown>('inter_token_latency_seconds'),
  perStageReqLatencySeconds: jsonColumn<unknown>('per_stage_req_latency_seconds'),
  queueTimeSeconds: jsonColumn<unknown>('queue_time_seconds'),
})

export const nvidiaSmi = sqliteTable('nvidia_smi', {
  id: idColumn(),
  ts: integer('ts', {mode: 'timestamp_ms'}).defaultNow().notNull(),
  instanceId: text('instance_id').notNull(),
  gpuIndex: integer('gpu_index').notNull(),
  gpuUuid: text('gpu_uuid'),
  gpuName: text('gpu_name'),
  temperatureGpu: integer('temperature_gpu'),
  utilizationGpu: integer('utilization_gpu'),
  utilizationMemory: integer('utilization_memory'),
  memoryTotalMiB: integer('memory_total_mib'),
  memoryUsedMiB: integer('memory_used_mib'),
  powerDrawWatts: real('power_draw_watts'),
  powerLimitWatts: real('power_limit_watts'),
  fanSpeed: integer('fan_speed'),
  pstate: text('pstate'),
})
