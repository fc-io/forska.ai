import {sql} from 'drizzle-orm'
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
import {primaryKey} from 'drizzle-orm/pg-core'
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

export const judgmentsJobsPromptsStatusEnum = pgEnum('judgments_jobs_prompts_status_enum', [
  'ready',
  'sent',
  'judged',
  'judged_and_ready_to_remove_from_queue',
  'skipped',
])

export const judgmentsJobsPromptsSkipReasonEnum = pgEnum('judgments_jobs_prompts_skip_reason_enum', [
  'no_fulltext',
  'conversion_failed',
  'fulltext_too_large',
])

export const judgmentChunkingStrategyEnum = pgEnum('judgment_chunking_strategy_enum', [
  'patient_h3_greedy',
  'article_heading_greedy',
  'article_paragraph_greedy',
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
    openalexId: text('openalex_id'),
    biorxivId: text('biorxiv_id'),
    medrxivId: text('medrxiv_id'),
    doi: text('doi'),
    pubmedId: text('pubmed_id'),
    url: text('url'),
    fullTextFetchedAt: timestamp('full_text_fetched_at', {withTimezone: true}),
    fullText: text('full_text'),
    fullTextHtml: text('full_text_html'),
    fullTextSource: text('full_text_source'),
    fullTextOriginalFormat: text('full_text_original_format'),
    fullTextPDF: text('full_text_pdf'),
    fullTextAssets: jsonb('full_text_assets'),
    // Conversion tracking columns
    fullTextConversionStatus: text('full_text_conversion_status'), // 'pending' | 'success' | 'failed'
    fullTextConversionError: text('full_text_conversion_error'),
    fullTextConversionAttempts: integer('full_text_conversion_attempts').default(0),
    fullTextCharCount: integer('full_text_char_count'),
    contentHash: text('content_hash'),
    importRoute: text('import_route'),
    originalData: jsonb('original_data'),
    importedBy: text('imported_by').references(
      () => {
        return user.id
      },
      {onDelete: 'set null'},
    ),
    // Who uploaded the PDF manually (null if fetched automatically)
    fullTextPdfUploadedBy: text('full_text_pdf_uploaded_by').references(
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
      index('articles_updated_idx').on(table.updatedAt),
      index('articles_updated_id_idx').on(table.updatedAt, table.id),
      uniqueIndex('articles_openalex_id_unique').on(table.openalexId),
      index('articles_full_text_conversion_status_idx').on(table.fullTextConversionStatus),
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
    workerUrls: text('worker_urls').array(),
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
    cursor: text('cursor'),
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
    archived: boolean('archived').default(false).notNull(),
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
      index('article_route_link_updated_idx').on(table.updatedAt),
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
  useTitle: boolean('use_title').default(true).notNull(),
  useAbstract: boolean('use_abstract').default(true).notNull(),
  useFulltext: boolean('use_fulltext').default(false).notNull(),
  useFulltextNoImages: boolean('use_fulltext_no_images').default(false).notNull(),
  dateFrom: timestamp('date_from', {withTimezone: true}),
  dateTo: timestamp('date_to', {withTimezone: true}),
  archived: boolean('archived').default(false).notNull(),
  createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
})

export const comparisonProject = pgTable(
  'comparison_project',
  {
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
    modelIds: uuid('model_ids').array(),
    compareWithHumans: boolean('compare_with_humans').default(false).notNull(),
    useTitle: boolean('use_title').default(true).notNull(),
    useAbstract: boolean('use_abstract').default(true).notNull(),
    useFulltext: boolean('use_fulltext').default(false).notNull(),
    useFulltextNoImages: boolean('use_fulltext_no_images').default(false).notNull(),
    dateFrom: timestamp('date_from', {withTimezone: true}),
    dateTo: timestamp('date_to', {withTimezone: true}),
    archived: boolean('archived').default(false).notNull(),
    createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
  },
  (table) => {
    return [
      index('comparison_project_owner_idx').on(table.ownerId),
      index('comparison_project_archived_idx').on(table.archived),
      index('comparison_project_created_idx').on(table.createdAt),
    ]
  },
)

export const comparisonProjectRouteLink = pgTable(
  'comparison_project_route_link',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
    comparisonProjectId: uuid('comparison_project_id')
      .notNull()
      .references(
        () => {
          return comparisonProject.id
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
      uniqueIndex('comparison_project_route_link_unique').on(table.comparisonProjectId, table.importRouteId),
      index('comparison_project_route_link_project_idx').on(table.comparisonProjectId),
      index('comparison_project_route_link_route_idx').on(table.importRouteId),
    ]
  },
)

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
    chCursorLastDate: timestamp('ch_cursor_last_date', {withTimezone: true}),
    chCursorLastArticleId: uuid('ch_cursor_last_article_id'),
  },
  (table) => {
    return [index('judgments_jobs_project_idx').on(table.projectId)]
  },
)

export const judgmentsJobsPrompts = pgTable(
  'judgments_jobs_prompts',
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
    promptId: uuid('prompt_id')
      .notNull()
      .references(
        () => {
          return prompts.id
        },
        {onDelete: 'cascade'},
      ),
    serverId: text('server_id'),
    sentAt: timestamp('sent_at', {withTimezone: true}),
    judgedAt: timestamp('judged_at', {withTimezone: true}),
    status: judgmentsJobsPromptsStatusEnum('status').default('ready').notNull(),
    skipReason: judgmentsJobsPromptsSkipReasonEnum('skip_reason'),
  },
  (table) => {
    return [
      index('judgments_jobs_prompts_job_idx').on(table.jobId),
      index('judgments_jobs_prompts_job_status_idx').on(table.jobId, table.status),
      uniqueIndex('judgments_jobs_prompts_article_prompt_job_unique').on(table.articleId, table.promptId, table.jobId),
    ]
  },
)

export const prompts = pgTable(
  'prompts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
    originalText: text('original_text').notNull(),
    transformedText: text('transformed_text'),
    ownerId: text('owner_id')
      .default('uv2Idd2BF6VNSNjwY5IKmIeoYMKq6zXw')
      .notNull()
      .references(
        () => {
          return user.id
        },
        {onDelete: 'cascade'},
      ),
    archived: boolean('archived').default(false).notNull(),
    // Global, immutable metadata
    promptHeading: text('prompt_heading'),
    type: text('type'),
    contentHash: text('content_hash'),
  },
  (table) => {
    return [
      uniqueIndex('prompts_content_hash_unique').on(table.contentHash),
      index('prompts_owner_idx').on(table.ownerId),
      index('prompts_archived_idx').on(table.archived),
    ]
  },
)

export const projectPrompts = pgTable(
  'project_prompts',
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
    promptId: uuid('prompt_id')
      .notNull()
      .references(
        () => {
          return prompts.id
        },
        {onDelete: 'cascade'},
      ),
    order: integer('order'),
    archived: boolean('archived').default(false).notNull(),
    // Provenance of this association: which project originally created this prompt link.
    // null indicates auto-linked from external judgments (no single source project).
    originProjectId: uuid('origin_project_id').references(
      () => {
        return projects.id
      },
      {onDelete: 'set null'},
    ),
    // Whether this prompt association is enabled for LLM judging.
    enabled: boolean('enabled').default(true).notNull(),
  },
  (table) => {
    return [
      uniqueIndex('project_prompts_unique').on(table.projectId, table.promptId),
      index('project_prompts_project_idx').on(table.projectId),
      index('project_prompts_prompt_idx').on(table.promptId),
      index('project_prompts_project_order_idx').on(table.projectId, table.order),
    ]
  },
)

export const comparisonProjectPrompt = pgTable(
  'comparison_project_prompt',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull(),
    comparisonProjectId: uuid('comparison_project_id')
      .notNull()
      .references(
        () => {
          return comparisonProject.id
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
    order: integer('order'),
  },
  (table) => {
    return [
      uniqueIndex('comparison_project_prompt_unique').on(table.comparisonProjectId, table.promptId),
      index('comparison_project_prompt_project_idx').on(table.comparisonProjectId),
      index('comparison_project_prompt_prompt_idx').on(table.promptId),
      index('comparison_project_prompt_project_order_idx').on(table.comparisonProjectId, table.order),
    ]
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
    // Soft delete support (for Parquet/ClickHouse compatibility)
    deletedAt: timestamp('deleted_at', {withTimezone: true}),
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
        {onDelete: 'restrict'},
      ),
    // Project that *created* this judgment (denormalized for Parquet/ClickHouse).
    // NOTE: This is the originating project only. Judgments can be shared/reused across
    // multiple projects via import routes (articleImportRoute) and curated articles
    // (project_articles). Do NOT use projectId for scoping queries to a project's articles.
    projectId: uuid('project_id').references(
      () => {
        return projects.id
      },
      {onDelete: 'set null'},
    ),

    // Content flags: which article content was used for this judgment.
    // Legacy/backfilled rows default to title+abstract (useTitle=true, useAbstract=true).
    useTitle: boolean('use_title').default(true).notNull(),
    useAbstract: boolean('use_abstract').default(true).notNull(),
    useFulltext: boolean('use_fulltext').default(false).notNull(),
    useFulltextNoImages: boolean('use_fulltext_no_images').default(false).notNull(),

    chunkingStrategy: judgmentChunkingStrategyEnum('chunking_strategy'),

    // Whether this LLM judgment has been answered (may have null answer fields in some cases)
    isAnswered: boolean('is_answered').default(false),
    answeredOriginal: text('answered_original'),
    answeredOriginalAsArray: text('answered_original_as_array').array(),

    confidenceOriginal: integer('confidence_original').default(50),
    explanation: text('explanation'),
    quotes: jsonb('quotes').default([]),
    // Snapshots
    snapshotProjectId: uuid('snapshot_project_id'),
    snapshotProjectModelName: text('snapshot_project_model_name'),
  },
  (table) => {
    return [
      index('judgments_article_prompt_idx').on(table.articleId, table.promptId),
      // Note: judgments_article_prompt_answered_idx is managed via raw SQL migration
      // (0041_fix_judgments_answered_index_size.sql) as an expression index using
      // LEFT(answered_original, 100) to avoid B-tree size limit issues
      index('judgments_prompt_article_idx').on(table.promptId, table.articleId),
      // Cover common NOT EXISTS lookups by (article_id, prompt_id, model_id)
      index('judgments_article_prompt_model_idx').on(table.articleId, table.promptId, table.modelId),
      // Cover content-aware NOT EXISTS lookups (model + content settings)
      index('judgments_article_prompt_model_content_idx').on(
        table.articleId,
        table.promptId,
        table.modelId,
        table.useTitle,
        table.useAbstract,
        table.useFulltext,
        table.useFulltextNoImages,
      ),
      // Note: judgments_prompt_article_answered_idx is also managed via raw SQL migration
      index('judgments_updated_idx').on(table.updatedAt),
      index('judgments_updated_id_deleted_idx').on(table.updatedAt, table.id, table.deletedAt),
      // For sync status checks (ORDER BY created_at DESC LIMIT 1)
      index('judgments_created_idx').on(table.createdAt),
      // Denormalized project lookups (for Parquet/ClickHouse compatibility)
      index('judgments_project_idx').on(table.projectId),
      // Soft delete queries (for Parquet/ClickHouse compatibility)
      index('judgments_deleted_at_idx').on(table.deletedAt),
      index('judgments_deleted_updated_idx')
        .on(table.deletedAt, table.updatedAt)
        .where(sql`${table.deletedAt} IS NOT NULL`),
      // Unique constraint for content-aware judgment deduplication (excludes soft-deleted rows).
      // This enables rejudge: deleted rows don't block new inserts for the same combo.
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
        {onDelete: 'restrict'},
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
      // Speed DISTINCT answer lists per prompt under article constraints
      index('judgments_human_prompt_article_answer_idx').on(table.promptId, table.articleId, table.answer),
      index('judgments_human_updated_idx').on(table.updatedAt),
    ]
  },
)

export const projectArticles = pgTable(
  'project_articles',
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
    importedFromProjectId: uuid('imported_from_project_id').references(
      () => {
        return projects.id
      },
      {onDelete: 'set null'},
    ),
    articleId: uuid('article_id')
      .notNull()
      .references(
        () => {
          return articles.id
        },
        {onDelete: 'cascade'},
      ),
  },
  (table) => {
    return [
      uniqueIndex('project_articles_unique').on(table.projectId, table.articleId),
      index('project_articles_project_idx').on(table.projectId),
      index('project_articles_article_idx').on(table.articleId),
      index('project_articles_imported_from_project_idx').on(table.importedFromProjectId),
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
    // GPU / parallelism metadata captured at insert time
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
    hasFailedRequests: boolean('has_failed_requests').default(false).notNull(),
    failedRequestsDetails: jsonb('failed_requests_details'),
    totalSuccessPromptTokens: integer('total_success_prompt_tokens'),
    totalSuccessCompletionTokens: integer('total_success_completion_tokens'),
    totalSuccessTokens: integer('total_success_tokens'),
    totalFailedPromptTokens: integer('total_failed_prompt_tokens'),
    totalFailedCompletionTokens: integer('total_failed_completion_tokens'),
    totalFailedTokens: integer('total_failed_tokens'),
  },
  (table) => {
    return [
      index('token_use_job_created_idx').on(table.judgmentsJobId, table.createdAt),
      index('token_use_updated_idx').on(table.updatedAt),
    ]
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
// Removed vLLM-specific status table in favor of unified llm_status

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
    pollMs: bigint('poll_ms', {mode: 'number'}).notNull().default(2000),

    // SGLang-aligned counters
    promptTokensTotal: bigint('prompt_tokens_total', {mode: 'number'}).notNull().default(0),
    generationTokensTotal: bigint('generation_tokens_total', {mode: 'number'}).notNull().default(0),
    numRequestsTotal: bigint('num_requests_total', {mode: 'number'}),
    cachedTokensTotal: bigint('cached_tokens_total', {mode: 'number'}),
    numRetractionsCount: bigint('num_retractions_count', {mode: 'number'}),

    // SGLang-aligned gauges
    numQueueReqs: integer('num_queue_reqs').notNull().default(0),
    numRunningReqs: integer('num_running_reqs').notNull().default(0),
    numGrammarQueueReqs: integer('num_grammar_queue_reqs'),
    numRunningReqsOfflineBatch: integer('num_running_reqs_offline_batch'),
    numPrefillPreallocQueueReqs: integer('num_prefill_prealloc_queue_reqs'),
    numPrefillInflightQueueReqs: integer('num_prefill_inflight_queue_reqs'),
    numDecodePreallocQueueReqs: integer('num_decode_prealloc_queue_reqs'),
    numDecodeTransferQueueReqs: integer('num_decode_transfer_queue_reqs'),

    // Throughput and utilization
    genThroughput: doublePrecision('gen_throughput'),
    tokenUsage: doublePrecision('token_usage'),
    utilization: doublePrecision('utilization'),
    cacheHitRate: doublePrecision('cache_hit_rate'),
    specAcceptRate: doublePrecision('spec_accept_rate'),
    specAcceptLength: doublePrecision('spec_accept_length'),
    isCudaGraph: boolean('is_cuda_graph'),
    swaTokenUsage: doublePrecision('swa_token_usage'),
    mambaUsage: doublePrecision('mamba_usage'),
    pendingPreallocTokenUsage: doublePrecision('pending_prealloc_token_usage'),

    // KV transfer
    kvTransferSpeedGbS: doublePrecision('kv_transfer_speed_gb_s'),
    kvTransferLatencyMs: doublePrecision('kv_transfer_latency_ms'),
    kvTransferBootstrapMs: doublePrecision('kv_transfer_bootstrap_ms'),
    kvTransferAllocMs: doublePrecision('kv_transfer_alloc_ms'),

    // Derived rates (kept for controller logic)
    prefillTps: doublePrecision('prefill_tps'),
    genTps: doublePrecision('gen_tps'),
    rps: doublePrecision('rps'),

    // Controller state
    targetGenTps: doublePrecision('target_gen_tps'),
    targetPrefillTps: doublePrecision('target_prefill_tps'),
    inFlight: integer('in_flight'),
    maxInFlight: integer('max_in_flight'),
    lastAction: text('last_action'),

    // Histograms (store raw buckets)
    timeToFirstTokenSeconds: jsonb('time_to_first_token_seconds'),
    e2eRequestLatencySeconds: jsonb('e2e_request_latency_seconds'),
    interTokenLatencySeconds: jsonb('inter_token_latency_seconds'),
    perStageReqLatencySeconds: jsonb('per_stage_req_latency_seconds'),
    queueTimeSeconds: jsonb('queue_time_seconds'),
  },
  (table) => {
    return [
      index('llm_status_ts_idx').on(table.ts),
      uniqueIndex('llm_status_engine_instance_ts_idx').on(table.engine, table.instanceId, table.ts),
      index('llm_status_model_ts_idx').on(table.modelName, table.ts),
    ]
  },
)

export const nvidiaSmi = pgTable(
  'nvidia_smi',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    ts: timestamp('ts', {withTimezone: true}).defaultNow().notNull(),

    instanceId: text('instance_id').notNull(),
    gpuIndex: integer('gpu_index').notNull(),

    gpuUuid: text('gpu_uuid'),
    gpuName: text('gpu_name'),

    temperatureGpu: integer('temperature_gpu'),
    utilizationGpu: integer('utilization_gpu'),
    utilizationMemory: integer('utilization_memory'),

    memoryTotalMiB: integer('memory_total_mib'),
    memoryUsedMiB: integer('memory_used_mib'),

    powerDrawWatts: doublePrecision('power_draw_watts'),
    powerLimitWatts: doublePrecision('power_limit_watts'),

    fanSpeed: integer('fan_speed'),
    pstate: text('pstate'),
  },
  (table) => {
    return [
      index('nvidia_smi_ts_idx').on(table.ts),
      index('nvidia_smi_instance_ts_idx').on(table.instanceId, table.ts),
      index('nvidia_smi_gpu_uuid_ts_idx').on(table.gpuUuid, table.ts),
    ]
  },
)

export const syncState = pgTable(
  'sync_state',
  {
    remoteId: text('remote_id').notNull(),
    tableName: text('table_name').notNull(),
    lastSyncedAt: timestamp('last_synced_at', {withTimezone: true})
      .notNull()
      .default(sql`to_timestamp(0)`),
  },
  (table) => {
    return {pk: primaryKey({columns: [table.remoteId, table.tableName]})}
  },
)
