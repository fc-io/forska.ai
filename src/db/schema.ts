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

export const publicationStatusEnum = pgEnum('publication_status_enum', [
  'preprint',
  'submitted',
  'accepted',
  'published',
  'retracted',
])

export const agentJobStatusEnum = pgEnum('agent_job_status_enum', [
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
  modelId: uuid('model_id').references(
    () => {
      return models.id
    },
    {onDelete: 'set null'},
  ),
  createdAt: timestamp('created_at', {withTimezone: true})
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', {withTimezone: true})
    .defaultNow()
    .notNull(),
})

export const agentJobs = pgTable('agent_jobs', {
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
  status: agentJobStatusEnum('status').default('not_started').notNull(),
  error: text('error').array(),
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
  type: text('type'),
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
  reviewId: uuid('review_id').references(
    () => {
      return reviews.id
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
  agentJobId: uuid('agent_job_id').references(
    () => {
      return agentJobs.id
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
})

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
  createdAt: timestamp('created_at', {withTimezone: true})
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', {withTimezone: true})
    .defaultNow()
    .notNull(),
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
  createdAt: timestamp('created_at', {withTimezone: true})
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', {withTimezone: true})
    .defaultNow()
    .notNull(),
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
