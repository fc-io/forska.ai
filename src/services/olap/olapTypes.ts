import type {PromptFilterInfo} from '../../server/routes/projectsRoutes/articlesReviewsFiltersUtils.ts'

export type ArticlesReviewsParams = {
  projectId: string
  page: number
  limit: number
  cursor?: string | null
  from?: string | null
  to?: string | null
  search?: string | null
  prompts?: Record<string, string[]>
}

export type OlapJudgmentRow = {
  id: string
  createdAt: string
  articleId: string
  articleTitle: string
  articleCreatedAt: string | null
  articleUpdatedAt: string | null
  articleCreatedYear: number | null
  articleUpdatedYear: number | null
  articleImportRoute: string | null
  articleImportedBy: string | null
  promptId: string
  modelId: string
  answeredOriginal: string | null
  answeredOriginalAsArray: string[]
  explanation: string | null
  quotes: unknown
}

export type ArticleReviewResult = {
  id: string
  articleTitle: string | null
  articleCreatedAt: Date | null
  articleUpdatedAt: Date | null
  articleId?: string | null
  url?: string | null
  fullTextPDF?: string | null
  fullTextFetchedAt?: Date | null
  fullTextConversionStatus?: string | null
  sourceMetadata?: unknown
  judgments: OlapJudgmentRow[]
  judgedPromptIds: string[]
  isFullyJudged: boolean
  journalTitle: string | null
}

export type ArticlesReviewsResponse = {
  data: ArticleReviewResult[]
  totalCount: number | null
  page: number
  limit: number
  totalPages: number | null
  nextCursor?: string | null
}

export type ArticlesReviewsCountParams = {
  projectId: string
  limit: number
  from?: string | null
  to?: string | null
  search?: string | null
  prompts?: Record<string, string[]>
}

export type ArticlesReviewsCountResponse = {totalCount: number; totalPages: number; error?: string}

export type ArticlesReviewsBothParams = {
  projectId: string
  page: number
  limit: number
  from?: string | null
  to?: string | null
  search?: string | null
  prompts?: Record<string, string[]>
}

export type HumanAnswersByPrompt = Record<string, string[]>

export type ArticlesReviewsBothJudgmentRow = {
  id: string
  createdAt: string
  articleId: string
  promptId: string
  modelId: string
  answeredOriginal: string | null
  answeredOriginalAsArray: string[]
  explanation: string | null
  quotes: unknown
}

export type ArticleReviewsBothResult = {
  id: string
  articleTitle: string | null
  articleCreatedAt: Date | null
  articleUpdatedAt: Date | null
  articleId?: string | null
  url?: string | null
  fullTextPDF?: string | null
  fullTextFetchedAt?: Date | null
  fullTextConversionStatus?: string | null
  sourceMetadata?: unknown
  judgments: ArticlesReviewsBothJudgmentRow[]
  humanAnswersByPrompt?: HumanAnswersByPrompt
  journalTitle: string | null
}

export type ArticlesReviewsBothResponse = {
  data: ArticleReviewsBothResult[]
  totalCount: number
  page: number
  limit: number
  totalPages: number
}

export type DatabaseFilterResult = {promptId: string; promptName: string; answeredOriginalValues: string[]}

export type DatabaseFilterParams = {
  projectId: string
  prompts: PromptFilterInfo[]
  fromDate: Date | null
  toDate: Date | null
  searchTitle: string
}

export type PaginationCursor = {lastDate: Date; lastArticleId: string}

export type UnassessedCountParams = {
  projectId: string
  projectModelId: string
  projectDateFrom: Date | null | undefined
  projectDateTo: Date | null | undefined
  importRouteIds: string[]
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}

export type UnassessedArticlesParams = UnassessedCountParams & {limit: number; offset: number; search?: string}

export type PromptQueueEntry = {articleId: string; promptId: string}

export type UnassessedPairsParams = {
  projectId: string
  jobId: string
  numberOfPromptsToGet: number
  cursor: PaginationCursor | null
  preferRawFallback?: boolean
}

export type UnassessedPairsResult = {promptEntries: PromptQueueEntry[]; nextCursor: PaginationCursor | null}

export type UnassessedArticleRow = {
  id: string
  articleId: string | null
  articleTitle: string
  articleCreatedAt: Date | null
  articleUpdatedAt: Date | null
}

export type SelectArticleIdsListType = 'llm' | 'human' | 'both' | 'unassessed'

export type SelectArticleIdsArgs = [
  sourceProjectId: string,
  listType: SelectArticleIdsListType,
  promptsFilter?: Record<string, string[]>,
  from?: string,
  to?: string,
  search?: string,
]
