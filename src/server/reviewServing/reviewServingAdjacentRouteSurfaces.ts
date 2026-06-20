import type {ReviewServingReadContractKey} from './reviewServingContracts.ts'

export const reviewServingAdjacentRouteClassifications = [
  {
    classification: 'out-of-scope-non-review',
    contractKeys: [],
    excludedFromNormalReviewFlow: true,
    guard: 'owner-dependent local product API classification; not linked from review tables or desktop review flows',
    method: 'GET',
    reason:
      'Global article catalog recency surface; it does not select project-scoped review rows or make review decisions.',
    routeFile: 'src/server/routes/ArticlesRoutes.ts',
    routePath: '/api/articles/latest',
  },
  {
    classification: 'out-of-scope-non-review',
    contractKeys: [],
    excludedFromNormalReviewFlow: true,
    guard: 'owner-dependent local product API classification; not linked from review tables or desktop review flows',
    method: 'GET',
    reason:
      'Global article catalog lookup for manual selection; it is not project scoped and has no review decision path.',
    routeFile: 'src/server/routes/ArticlesRoutes.ts',
    routePath: '/api/articles/search',
  },
  {
    classification: 'out-of-scope-non-review',
    contractKeys: [],
    excludedFromNormalReviewFlow: true,
    guard: 'project-scoped local product API; read-only membership list outside review-serving row selection',
    method: 'GET',
    reason: 'Project article membership management list; review pages use serving row/filter/detail routes instead.',
    routeFile: 'src/server/routes/ProjectArticlesRoutes.ts',
    routePath: '/api/projects/:id/articles',
  },
  {
    classification: 'migrated-admission',
    contractKeys: [],
    excludedFromNormalReviewFlow: true,
    guard: 'project-scope mutation delegates to insertArticlesIntoProject and review-serving project-scope deltas',
    method: 'POST',
    reason:
      'Project membership mutation is admitted through the project-scope delta path instead of a foreground review read.',
    routeFile: 'src/server/routes/ProjectArticlesRoutes.ts',
    routePath: '/api/projects/:id/articles',
  },
  {
    classification: 'migrated-admission',
    contractKeys: [],
    excludedFromNormalReviewFlow: true,
    guard: 'project-scope mutation appends projectScope.article.removed deltas and marks mart state dirty',
    method: 'DELETE',
    reason: 'Project membership removal is a serving-admission mutation hook, not a raw review selection fallback.',
    routeFile: 'src/server/routes/ProjectArticlesRoutes.ts',
    routePath: '/api/projects/:id/articles/:articleId',
  },
  {
    classification: 'out-of-scope-admin-debug',
    contractKeys: [],
    excludedFromNormalReviewFlow: true,
    guard:
      'owner-dependent local product API for browser and desktop admin job pages; not linked from normal review row flows',
    method: 'GET',
    reason:
      'Judgment-job unassessed count is an operational queue diagnostic for a job, not a production review route.',
    routeFile: 'src/server/routes/JudgmentsJobsRoutes.ts',
    routePath: '/api/judgmentsjobs-unassessed-count',
  },
  {
    classification: 'out-of-scope-admin-debug',
    contractKeys: [],
    excludedFromNormalReviewFlow: true,
    guard:
      'owner-dependent local product API for browser and desktop admin job pages; bounded preview route outside normal review row flows',
    method: 'GET',
    reason:
      'Judgment-job unassessed article preview is an operational diagnostic for a job, not a production review route.',
    routeFile: 'src/server/routes/JudgmentsJobsRoutes.ts',
    routePath: '/api/judgmentsjobs-unassessed-articles',
  },
  {
    classification: 'out-of-scope-admin-debug',
    contractKeys: [],
    excludedFromNormalReviewFlow: true,
    guard: 'owner-dependent local product API for the browser and desktop admin assessments page only',
    method: 'GET',
    reason:
      'Aggregate human-assessment overview for admin reporting; it is not used by browser or desktop review row flows.',
    routeFile: 'src/server/routes/HumanAssessmentRoutes.ts',
    routePath: '/api/humanassessment/overview',
  },
  {
    classification: 'out-of-scope-admin-debug',
    contractKeys: [],
    excludedFromNormalReviewFlow: true,
    guard: 'owner-dependent local product API for the browser and desktop admin assessments page only',
    method: 'GET',
    reason:
      'Aggregate both-projects human-assessment overview for admin reporting; it is not a normal review row surface.',
    routeFile: 'src/server/routes/HumanAssessmentRoutes.ts',
    routePath: '/api/humanassessment/overview-both-projects',
  },
  {
    classification: 'migrated-serving',
    contractKeys: ['review.queue.unassessed'],
    excludedFromNormalReviewFlow: false,
    guard: 'project access guard plus reviewServingReader queue admission with queueKind=human-unreviewed',
    method: 'POST',
    reason:
      'Normal browser human-assessment init selects its next article through the serving queue and has no raw scope fallback.',
    routeFile: 'src/server/routes/HumanAssessmentRoutes.ts',
    routePath: '/api/humanassessment/init',
  },
  {
    classification: 'migrated-admission',
    contractKeys: [],
    excludedFromNormalReviewFlow: false,
    guard: 'project access guard plus human judgment delta and dirty-refresh admission hooks',
    method: 'POST',
    reason:
      'Normal browser human-assessment submit writes human judgments and appends review-serving deltas instead of reading raw fallback rows.',
    routeFile: 'src/server/routes/HumanAssessmentRoutes.ts',
    routePath: '/api/humanassessment/submit',
  },
] as const satisfies readonly {
  classification:
    | 'migrated-admission'
    | 'migrated-job'
    | 'migrated-serving'
    | 'out-of-scope-admin-debug'
    | 'out-of-scope-non-review'
  contractKeys: readonly ReviewServingReadContractKey[]
  excludedFromNormalReviewFlow: boolean
  guard: string
  method: 'DELETE' | 'GET' | 'POST'
  reason: string
  routeFile: string
  routePath: string
}[]

export type ReviewServingAdjacentRouteClassification = (typeof reviewServingAdjacentRouteClassifications)[number]

export const getReviewServingAdjacentRouteClassificationKey = (entry: ReviewServingAdjacentRouteClassification) => {
  return `${entry.method} ${entry.routePath}`
}
