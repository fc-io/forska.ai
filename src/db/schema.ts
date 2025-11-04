import {
  bigint,
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  pgView,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import {index, uniqueIndex} from 'drizzle-orm/pg-core/indexes'

import {session, user} from '../../auth-schema.ts'

export const publicationStatusEnum = pgEnum('publication_status_enum', [
  'preprint',
  'submitted',
  'accepted',
  'published',
  'retracted',
])

export const judgmentsJobStatusEnum = pgEnum('judgments_job_status_enum', [
  'not_started',
  'waiting_on_llm_connection',
  'waiting_on_db_connection',
  'running',
  'paused_by_user',
  'paused_by_admin',
  'failed',
  'completed', // only for projects with a fixed end date
  'project_removed',
])

export const judgmentsJobsArticlesStatusEnum = pgEnum('judgments_jobs_articles_status_enum', [
  'ready',
  'sent',
  'judged',
  'judged_and_ready_to_remove_from_queue',
])

export const engineEnum = pgEnum('engine_enum', ['sglang', 'vllm'])

export const articles = pgTable(
  'articles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
    articleTitle: text('article_title').notNull(),
    articleAuthors: text('article_authors').array(),
    articleCreatedAt: timestamp('article_created_at', {withTimezone: true}),
    articleUpdatedAt: timestamp('article_updated_at', {withTimezone: true}),
    articleId: text('article_id').unique(),
    articleSummary: text('article_summary'),
    articleVersion: integer('article_version'),
    arxivId: text('arxiv_id'),
    doi: text('doi'),
    pubmedId: text('pubmed_id'),
    url: text('url'),
    contentHash: text('content_hash'),
    importRoute: text('import_route'),
    originalData: jsonb('original_data'),
    importedBy: text('imported_by').references(
      () => {
        return user.id
      },
      {onDelete: 'set null'},
    ),
    publicationStatus: publicationStatusEnum('publication_status'),
  },
  (table) => {
    return [
      index('articles_article_created_created_id_idx').on(table.articleCreatedAt, table.createdAt, table.id),
      index('articles_created_idx').on(table.createdAt),
      index('articles_article_updated_idx').on(table.articleUpdatedAt),
      index('articles_import_route_article_created_idx').on(table.importRoute, table.articleCreatedAt),
    ]
  },
)

export const models = pgTable(
  'models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
    name: text('name').notNull(),
    provider: text('provider'),
    baseURL: text('base_url'),
    modelName: text('model_name'),
    version: text('version'),
    apiKeyVariable: text('api_key_variable'),
    ownerId: text('owner_id')
      .default('uv2Idd2BF6VNSNjwY5IKmIeoYMKq6zXw')
      .notNull()
      .references(
        () => {
          return user.id
        },
        {onDelete: 'cascade'},
      ),
  },
  (table) => {
    return [index('models_owner_idx').on(table.ownerId)]
  },
)

export const dataSource = pgTable(
  'datasource',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
    title: text('title').notNull(),
    description: text('description'),
    lastImportAt: timestamp('last_import_at', {withTimezone: true}),
    itemsAfterLastImport: integer('items_after_last_import').default(0),
    importRoute: text('import_route'),
    dateFrom: timestamp('date_from', {withTimezone: true}),
    dateTo: timestamp('date_to', {withTimezone: true}),
    ownerId: text('owner_id')
      .default('uv2Idd2BF6VNSNjwY5IKmIeoYMKq6zXw')
      .notNull()
      .references(
        () => {
          return user.id
        },
        {onDelete: 'cascade'},
      ),
  },
  (table) => {
    return [index('datasource_owner_idx').on(table.ownerId)]
  },
)

export const importRoute = pgTable(
  'import_route',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
    route: text('route').notNull(),
    name: text('name'),
    description: text('description'),
    active: boolean('active').default(true).notNull(),
  },
  (table) => {
    return [uniqueIndex('import_route_route_unique').on(table.route), index('import_route_active_idx').on(table.active)]
  },
)

export const dataSourceRouteLink = pgTable(
  'datasource_route_link',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
    dataSourceId: uuid('datasource_id')
      .notNull()
      .references(
        () => {
          return dataSource.id
        },
        {onDelete: 'cascade'},
      ),
    importRouteId: uuid('import_route_id')
      .notNull()
      .references(
        () => {
          return importRoute.id
        },
        {onDelete: 'cascade'},
      ),
  },
  (table) => {
    return [
      uniqueIndex('datasource_route_link_unique').on(table.dataSourceId, table.importRouteId),
      index('datasource_route_link_datasource_idx').on(table.dataSourceId),
      index('datasource_route_link_route_idx').on(table.importRouteId),
    ]
  },
)

export const projectRouteLink = pgTable(
  'project_route_link',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(
        () => {
          return projects.id
        },
        {onDelete: 'cascade'},
      ),
    importRouteId: uuid('import_route_id')
      .notNull()
      .references(
        () => {
          return importRoute.id
        },
        {onDelete: 'cascade'},
      ),
  },
  (table) => {
    return [
      uniqueIndex('project_route_link_unique').on(table.projectId, table.importRouteId),
      index('project_route_link_project_idx').on(table.projectId),
      index('project_route_link_route_idx').on(table.importRouteId),
    ]
  },
)

export const articleRouteLink = pgTable(
  'article_route_link',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
    articleId: uuid('article_id')
      .notNull()
      .references(
        () => {
          return articles.id
        },
        {onDelete: 'cascade'},
      ),
    importRouteId: uuid('import_route_id')
      .notNull()
      .references(
        () => {
          return importRoute.id
        },
        {onDelete: 'cascade'},
      ),
  },
  (table) => {
    return [
      uniqueIndex('article_route_link_unique').on(table.articleId, table.importRouteId),
      index('article_route_link_article_idx').on(table.articleId),
      index('article_route_link_route_idx').on(table.importRouteId),
    ]
  },
)

export const dataSourceAccess = pgTable(
  'datasource_access',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
    dataSourceId: uuid('datasource_id')
      .notNull()
      .references(
        () => {
          return dataSource.id
        },
        {onDelete: 'cascade'},
      ),
    userId: text('user_id')
      .notNull()
      .references(
        () => {
          return user.id
        },
        {onDelete: 'cascade'},
      ),
  },
  (table) => {
    return [
      index('datasource_access_datasource_idx').on(table.dataSourceId),
      index('datasource_access_user_idx').on(table.userId),
    ]
  },
)

// project_datasource_link removed — no longer linking datasources to projects

export const modelAccess = pgTable(
  'model_access',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
    modelId: uuid('model_id')
      .notNull()
      .references(
        () => {
          return models.id
        },
        {onDelete: 'cascade'},
      ),
    userId: text('user_id')
      .notNull()
      .references(
        () => {
          return user.id
        },
        {onDelete: 'cascade'},
      ),
  },
  (table) => {
    return [index('model_access_model_idx').on(table.modelId), index('model_access_user_idx').on(table.userId)]
  },
)

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  ownerId: text('owner_id')
    .notNull()
    .references(
      () => {
        return user.id
      },
      {onDelete: 'cascade'},
    ),
  // Engine used for this project (e.g., 'sglang' | 'vllm')
  engine: engineEnum('engine'),
  modelId: uuid('model_id')
    .notNull()
    .references(
      () => {
        return models.id
      },
      {onDelete: 'restrict'},
    ),
  dateFrom: timestamp('date_from', {withTimezone: true}),
  dateTo: timestamp('date_to', {withTimezone: true}),
  createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
})

export const judgmentsJobs = pgTable(
  'judgments_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(
        () => {
          return projects.id
        },
        {onDelete: 'cascade'},
      ),
    status: judgmentsJobStatusEnum('status').default('not_started').notNull(),
    error: text('error').array(),
    sendToLLMBatchSize: integer('send_to_llm_batch_size').default(5).notNull(),
    sendToLLMInterval: integer('send_to_llm_interval').default(15).notNull(),
  },
  (table) => {
    return [index('judgments_jobs_project_idx').on(table.projectId)]
  },
)

export const judgmentsJobsArticles = pgTable(
  'judgments_jobs_articles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
    jobId: uuid('job_id')
      .notNull()
      .references(
        () => {
          return judgmentsJobs.id
        },
        {onDelete: 'cascade'},
      ),
    articleId: uuid('article_id')
      .notNull()
      .references(
        () => {
          return articles.id
        },
        {onDelete: 'cascade'},
      ),
    serverId: text('server_id'),
    sentAt: timestamp('sent_at', {withTimezone: true}),
    judgedAt: timestamp('judged_at', {withTimezone: true}),
    status: judgmentsJobsArticlesStatusEnum('status').default('ready').notNull(),
  },
  (table) => {
    return [
      index('judgments_jobs_articles_job_idx').on(table.jobId),
      index('judgments_jobs_articles_job_status_idx').on(table.jobId, table.status),
    ]
  },
)

export const prompts = pgTable(
  'prompts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(
        () => {
          return projects.id
        },
        {onDelete: 'cascade'},
      ),
    originalText: text('original_text').notNull(),
    transformedText: text('transformed_text'),
    promptHeading: text('prompt_heading'),
    order: integer('order'),
    archived: boolean('archived').default(false).notNull(),
    type: text('type'),
  },
  (table) => {
    return [index('prompts_project_idx').on(table.projectId)]
  },
)

// export const projectMembers = pgTable(
//   'project_members',
//   {
//     projectId: uuid('project_id')
//       .notNull()
//       .references(
//         () => {
//           return projects.id
//         },
//         {onDelete: 'cascade'},
//       ),
//     userId: uuid('user_id')
//       .notNull()
//       .references(
//         () => {
//           return user.id
//         },
//         {onDelete: 'cascade'},
//       ),
//     role: text('role'),
//   },
//   (table) => {
//     return {pk: primaryKey({columns: [table.projectId, table.userId]})}
//   },
// )

export const judgments = pgTable(
  'judgments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
    articleId: uuid('article_id')
      .notNull()
      .references(
        () => {
          return articles.id
        },
        {onDelete: 'restrict'},
      ),
    modelId: uuid('model_id')
      .notNull()
      .references(
        () => {
          return models.id
        },
        {onDelete: 'cascade'},
      ),
    promptId: uuid('prompt_id')
      .notNull()
      .references(
        () => {
          return prompts.id
        },
        {onDelete: 'cascade'},
      ),
    reviewId: uuid('review_id').references(
      () => {
        return reviews.id
      },
      {onDelete: 'cascade'},
    ),
    // Whether this LLM judgment has been answered (may have null answer fields in some cases)
    isAnswered: boolean('is_answered').default(false),
    answeredOriginal: text('answered_original'),
    answeredTransformed: text('answered_transformed'),
    confidenceOriginal: integer('confidence_original'),
    explanation: text('explanation'),
    quotes: jsonb('quotes'),
  },
  (table) => {
    return [
      index('judgments_article_prompt_idx').on(table.articleId, table.promptId),
      index('judgments_article_prompt_answered_idx').on(table.articleId, table.promptId, table.answeredOriginal),
      index('judgments_prompt_article_idx').on(table.promptId, table.articleId),
    ]
  },
)

export const judgmentsHuman = pgTable(
  'judgments_human',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
    articleId: uuid('article_id')
      .notNull()
      .references(
        () => {
          return articles.id
        },
        {onDelete: 'restrict'},
      ),
    user: text('user')
      .notNull()
      .references(
        () => {
          return user.id
        },
        {onDelete: 'cascade'},
      ),
    promptId: uuid('prompt_id')
      .notNull()
      .references(
        () => {
          return prompts.id
        },
        {onDelete: 'cascade'},
      ),
    // Whether this human judgment has been answered (allows null answer for optional prompts)
    isAnswered: boolean('is_answered').default(false).notNull(),
    answer: text('answer'),
    comment: text('comment'),
    projectId: uuid('project_id')
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
      index('judgments_human_article_prompt_idx').on(table.articleId, table.promptId),
      index('judgments_human_prompt_article_idx').on(table.promptId, table.articleId),
      index('judgments_human_project_idx').on(table.projectId),
    ]
  },
)

// Time-series token usage
export const tokenUse = pgTable(
  'token_use',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
    userId: text('user_id').references(
      () => {
        return user.id
      },
      {onDelete: 'set null'},
    ),
    sessionId: text('session_id').references(
      () => {
        return session.id
      },
      {onDelete: 'set null'},
    ),
    judgmentsJobId: uuid('judgments_job_id').references(
      () => {
        return judgmentsJobs.id
      },
      {onDelete: 'set null'},
    ),
    requests: integer('requests').notNull(),
    totalPromptTokens: integer('total_prompt_tokens').notNull(),
    totalCompletionTokens: integer('total_completion_tokens').notNull(),
    totalTokens: integer('total_tokens').notNull(),
    startedAt: timestamp('started_at', {withTimezone: true}),
    finishedAt: timestamp('finished_at', {withTimezone: true}),
    duration: integer('duration'),
  },
  (table) => {
    return [index('token_use_job_created_idx').on(table.judgmentsJobId, table.createdAt)]
  },
)

// Reviews table
export const reviews = pgTable('reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  articleId: uuid('article_id')
    .notNull()
    .references(
      () => {
        return articles.id
      },
      {onDelete: 'cascade'},
    ),
  projectId: uuid('project_id')
    .notNull()
    .references(
      () => {
        return projects.id
      },
      {onDelete: 'cascade'},
    ),
  reviewerId: text('reviewer_id')
    .notNull()
    .references(
      () => {
        return user.id
      },
      {onDelete: 'cascade'},
    ),
  opened: boolean('opened').default(false).notNull(),
  reviewedTitle: boolean('reviewed_title').default(false).notNull(),
  reviewedTitleComment: text('reviewed_title_comment'),
  reviewedAbstract: boolean('reviewed_abstract').default(false).notNull(),
  reviewedAbstractComment: text('reviewed_abstract_comment'),
  reviewedIntro: boolean('reviewed_intro').default(false).notNull(),
  reviewedIntroComment: text('reviewed_intro_comment'),
  reviewedMethod: boolean('reviewed_method').default(false).notNull(),
  reviewedMethodComment: text('reviewed_method_comment'),
  reviewedResults: boolean('reviewed_results').default(false).notNull(),
  reviewedResultsComment: text('reviewed_results_comment'),
  reviewedDiscussion: boolean('reviewed_discussion').default(false).notNull(),
  reviewedDiscussionComment: text('reviewed_discussion_comment'),
  reviewedConclusion: boolean('reviewed_conclusion').default(false).notNull(),
  reviewedConclusionComment: text('reviewed_conclusion_comment'),
  reviewedAppendix: boolean('reviewed_appendix').default(false).notNull(),
  reviewedAppendixComment: text('reviewed_appendix_comment'),
  reviewedOther: boolean('reviewed_other').default(false).notNull(),
  reviewedOtherComment: text('reviewed_other_comment'),
  createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
})

// Judgment assessments table
export const judgmentAssessments = pgTable('judgment_assessments', {
  id: uuid('id').primaryKey().defaultRandom(),
  judgmentId: uuid('judgment_id')
    .notNull()
    .references(
      () => {
        return judgments.id
      },
      {onDelete: 'cascade'},
    ),
  assessedBy: text('assessed_by')
    .notNull()
    .references(
      () => {
        return user.id
      },
      {onDelete: 'cascade'},
    ),
  assessmentIsCorrect: boolean('assessment_is_correct').notNull(),
  assessmentComment: text('assessment_comment'),
  createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
})

// Views
export const projectStats = pgView('project_stats', {
  projectId: uuid('project_id'),
  lastJudgmentAt: timestamp('last_judgment_at', {withTimezone: true}),
  totalJudgments: integer('total_judgments'),
  originalYes: integer('original_yes'),
  originalNo: integer('original_no'),
  originalUnsure: integer('original_unsure'),
}).existing()

// vLLM status snapshots
export const vllmStatus = pgTable(
  'vllm_status',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // when this poll was recorded
    ts: timestamp('ts', {withTimezone: true}).defaultNow().notNull(),

    // identity / dimensions
    instanceId: text('instance_id').notNull(),
    modelName: text('model_name').notNull(),
    vllmVersion: text('vllm_version'),
    gpuType: text('gpu_type'),
    gpuCount: integer('gpu_count'),
    pollMs: integer('poll_ms').notNull().default(2000),

    // RAW counters (monotonic) — use BIGINT
    promptTokensTotal: bigint('prompt_tokens_total', {mode: 'number'}).notNull().default(0),
    generationTokensTotal: bigint('generation_tokens_total', {mode: 'number'}).notNull().default(0),
    requestSuccessTotal: bigint('request_success_total', {mode: 'number'}),
    requestErrorTotal: bigint('request_error_total', {mode: 'number'}),
    numPreemptionsTotal: bigint('num_preemptions_total', {mode: 'number'}),

    // RAW gauges
    numRequestsWaiting: integer('num_requests_waiting').notNull().default(0),
    numRequestsRunning: integer('num_requests_running').notNull().default(0),
    gpuCacheUsagePerc: doublePrecision('gpu_cache_usage_perc'),
    numRequestsSwapped: integer('num_requests_swapped'),

    // DERIVED rates (tokens/s)
    prefillTps: doublePrecision('prefill_tps'),
    genTps: doublePrecision('gen_tps'),
    impliedRps: doublePrecision('implied_rps'),

    // Controller state (client-side)
    targetGenTps: doublePrecision('target_gen_tps'),
    targetPrefillTps: doublePrecision('target_prefill_tps'),
    inFlight: integer('in_flight'),
    maxInFlight: integer('max_in_flight'),
    lastAction: text('last_action'),

    // Latency histograms — store raw buckets OR derived quantiles (raw buckets here)
    e2eLatency: jsonb('e2e_latency_buckets'),
    ttftLatency: jsonb('ttft_latency_buckets'),
    itlLatency: jsonb('itl_latency_buckets'),
  },
  (table) => {
    return [
      index('vllm_status_ts_idx').on(table.ts),
      uniqueIndex('vllm_status_instance_ts_idx').on(table.instanceId, table.ts),
      index('vllm_status_model_ts_idx').on(table.modelName, table.ts),
    ]
  },
)

export const llmStatus = pgTable(
  'llm_status',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    ts: timestamp('ts', {withTimezone: true}).defaultNow().notNull(),

    engine: engineEnum('engine').notNull(),
    instanceId: text('instance_id').notNull(),
    modelName: text('model_name').notNull(),
    engineVersion: text('engine_version'),
    gpuType: text('gpu_type'),
    gpuCount: integer('gpu_count'),
    pollMs: integer('poll_ms').notNull().default(2000),

    prefillTokensTotal: bigint('prefill_tokens_total', {mode: 'number'}).notNull().default(0),
    genTokensTotal: bigint('gen_tokens_total', {mode: 'number'}).notNull().default(0),
    requestSuccessTotal: bigint('request_success_total', {mode: 'number'}),
    requestErrorTotal: bigint('request_error_total', {mode: 'number'}),
    preemptionsTotal: bigint('preemptions_total', {mode: 'number'}),

    numRequestsWaiting: integer('num_requests_waiting').notNull().default(0),
    numRequestsRunning: integer('num_requests_running').notNull().default(0),
    gpuCacheUsagePerc: doublePrecision('gpu_cache_usage_perc'),
    numRequestsSwapped: integer('num_requests_swapped'),

    prefillTps: doublePrecision('prefill_tps'),
    genTps: doublePrecision('gen_tps'),
    rps: doublePrecision('rps'),

    targetGenTps: doublePrecision('target_gen_tps'),
    targetPrefillTps: doublePrecision('target_prefill_tps'),
    inFlight: integer('in_flight'),
    maxInFlight: integer('max_in_flight'),
    lastAction: text('last_action'),

    e2eLatency: jsonb('e2e_latency_buckets'),
    ttftLatency: jsonb('ttft_latency_buckets'),
    itlLatency: jsonb('itl_latency_buckets'),
  },
  (table) => {
    return [
      index('llm_status_ts_idx').on(table.ts),
      uniqueIndex('llm_status_engine_instance_ts_idx').on(table.engine, table.instanceId, table.ts),
      index('llm_status_model_ts_idx').on(table.modelName, table.ts),
    ]
  },
)
