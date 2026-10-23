import type {SystemPromptVariant} from '../../../../agent/judge/systemPromptVariant.ts'
import type {JudgmentAssessmentRecord, JudgmentRecord, PromptRecord} from '../../../../db/schemaTypes.ts'

type JudgmentWithPromptAndAssessments = JudgmentRecord & {
  prompt: Pick<PromptRecord, 'originalText' | 'promptHeading'>
  assessments: Array<JudgmentAssessmentRecord>
  modelName?: string | null
  modelProvider?: string | null
  modelThinking?: string | null
  modelVersion?: string | null
}

export type PlaceholderJudgment = {
  id: string
  promptId: string
  answeredOriginal: 'not answered'
  confidenceOriginal: null
  explanation: null
  quotes: JudgmentRecord['quotes']
  prompt: Pick<PromptRecord, 'originalText' | 'promptHeading'>
  assessments: Array<JudgmentAssessmentRecord>
  createdAt: null
  modelName?: string | null
  modelProvider?: string | null
  modelThinking?: string | null
  modelVersion?: string | null
}

export type ReviewJudgment = JudgmentWithPromptAndAssessments | PlaceholderJudgment

export type ArticleJudgmentRow = ProjectReviewDetailJudgmentRow & {judgmentDeletedAt: unknown}

export type ProjectReviewConfig = {
  humanJudgmentMode?: 'prompt' | 'summary'
  modelId: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useMetadata?: boolean
  systemPromptVariant?: SystemPromptVariant
  fullTextStrategyId?: string
}

export type ProjectReviewDetailJudgmentRow = {
  judgmentAssessments: unknown
  judgmentId: string
  judgmentCreatedAt: unknown
  judgmentUpdatedAt: unknown
  judgmentArticleId: string
  judgmentModelId: string
  judgmentPromptId: string
  judgmentProjectId: string | null
  judgmentUseTitle: boolean | null
  judgmentUseAbstract: boolean | null
  judgmentUseFulltext: boolean | null
  judgmentUseFulltextNoImages: boolean | null
  judgmentUseMetadata: boolean | null
  judgmentSystemPromptVariant: string | null
  judgmentFullTextStrategyId: string | null
  judgmentChunkingStrategy: string | null
  judgmentFullTextMode: string | null
  judgmentChunkCount: number | null
  judgmentChunkPlanHash: string | null
  judgmentIsAnswered: boolean | null
  judgmentAnsweredOriginal: string | null
  judgmentAnsweredOriginalAsArray: unknown
  judgmentConfidenceOriginal: number | null
  judgmentExplanation: string | null
  judgmentQuotes: unknown
  judgmentSnapshotProjectId: string | null
  judgmentSnapshotProjectModelName: string | null
  promptOriginalText: string
  promptHeading: string | null
  modelMetadataJson: unknown
  modelName: string | null
  modelProvider: string | null
  modelThinking: string | null
  modelVersion: string | null
}

export type ServingHumanJudgmentDetailRow = {
  answered_original?: string | null
  article_id?: string
  detail_updated_at?: unknown
  human_comment?: string | null
  judgment_created_at?: unknown
  judgment_id?: string | null
  payload_kind?: string
  prompt_criteria_disposition?: 'include' | 'exclude' | 'combined' | null
  prompt_heading?: string | null
  prompt_id?: string
  prompt_original_text?: string | null
  prompt_order?: number | null
  prompt_type?: string | null
}

export type ServingArticleDetailRow = {
  article_created_at?: unknown
  article_external_id?: string | null
  article_id?: string
  article_title?: string | null
  article_updated_at?: unknown
  arxiv_id?: string | null
  biorxiv_id?: string | null
  doi?: string | null
  full_text_conversion_status?: string | null
  full_text_fetched_at?: unknown
  full_text_pdf?: string | null
  journal_title?: string | null
  medrxiv_id?: string | null
  pmid?: string | null
  publication_year?: number | null
  source_metadata?: unknown
  url?: string | null
}

export type ArticleFullTextRow = {
  articleAuthors: unknown
  articleSummary: string | null
  fullText: string | null
  fullTextCharCount: number | null
  fullTextHtml: string | null
  fullTextOriginalFormat: string | null
  fullTextSource: string | null
  importRoute: string | null
}

export type ProjectPromptRow = {
  id: string
  originalText: string
  promptHeading: string | null
  order: number | null
  type: string | null
  enabled: boolean | null
  criteriaDisposition: 'include' | 'exclude' | 'combined' | null
  originProjectId: string | null
}

export type ReviewJudgmentDetail = {
  judgment: JudgmentRecord
  prompt: Pick<PromptRecord, 'originalText' | 'promptHeading'>
  modelName: string | null
  modelProvider: string | null
  modelThinking: string | null
  modelVersion: string | null
}
