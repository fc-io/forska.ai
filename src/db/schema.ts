import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  pgView,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

import {session, user} from '../../auth-schema.ts'

export const agentJudgmentEnum = pgEnum('agent_judgment', [
  'yes',
  'no',
  'undecided',
  'unsure',
])

export const publicationStatusEnum = pgEnum('publication_status_enum', [
  'preprint',
  'submitted',
  'accepted',
  'published',
  'retracted',
])

export const articles = pgTable('articles', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', {withTimezone: true})
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', {withTimezone: true})
    .defaultNow()
    .notNull(),
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
  publicationStatus: publicationStatusEnum('publication_status'),
})

export const models = pgTable('models', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', {withTimezone: true})
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', {withTimezone: true})
    .defaultNow()
    .notNull(),
  name: text('name').notNull(),
  provider: text('provider'),
  baseURL: text('base_url'),
  modelName: text('model_name'),
  version: text('version'),
  apiKeyVariable: text('api_key_variable'),
})

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
  createdAt: timestamp('created_at', {withTimezone: true})
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', {withTimezone: true})
    .defaultNow()
    .notNull(),
})

export const prompts = pgTable('prompts', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', {withTimezone: true})
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', {withTimezone: true})
    .defaultNow()
    .notNull(),
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
})

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

export const judgments = pgTable('judgments', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', {withTimezone: true})
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', {withTimezone: true})
    .defaultNow()
    .notNull(),
  articleId: uuid('article_id')
    .notNull()
    .references(
      () => {
        return articles.id
      },
      {onDelete: 'cascade'},
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
  answeredOriginal: text('answered_original').notNull(),
  answeredTransformed: text('answered_transformed'),
  confidenceOriginal: integer('confidence_original'),
  explanation: text('explanation'),
  quotes: jsonb('quotes'),
})

// Time-series token usage
export const tokenUse = pgTable('token_use', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', {withTimezone: true})
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', {withTimezone: true})
    .defaultNow()
    .notNull(),
  userId: text('user_id').references(
    () => {
      return user.id
    },
    {onDelete: 'set null'},
  ),
  sessionId: text('session_id')
    .notNull()
    .references(
      () => {
        return session.id
      },
      {onDelete: 'cascade'},
    ),
  requests: integer('requests').notNull(),
  totalPromptTokens: integer('total_prompt_tokens').notNull(),
  totalCompletionTokens: integer('total_completion_tokens').notNull(),
  totalTokens: integer('total_tokens').notNull(),
  startedAt: timestamp('started_at', {withTimezone: true}),
  finishedAt: timestamp('finished_at', {withTimezone: true}),
  duration: integer('duration'),
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
