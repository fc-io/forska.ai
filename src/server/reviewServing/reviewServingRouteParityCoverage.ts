export const reviewServingRouteParityGates = [
  'semanticFixture',
  'sampledParity',
  'cursor',
  'freshnessState',
  'namedCountState',
  'sqlShape',
  'forbiddenForegroundDuckdbWork',
  'latency',
  'responseSize',
] as const

export type ReviewServingRouteParityGate = (typeof reviewServingRouteParityGates)[number]

export const reviewServingJobParityGates = [
  'durableJobPersistence',
  'keysetBatching',
  'articleIdCaps',
  'filterSignature',
  'snapshotSemantics',
  'foregroundPayloadCap',
] as const

export type ReviewServingJobParityGate = (typeof reviewServingJobParityGates)[number]

export const reviewServingRouteParityCoverage = [
  {method: 'POST', productRoute: '/api/articlesreviews', requiredGates: reviewServingRouteParityGates},
  {method: 'POST', productRoute: '/api/articlesreviewscount', requiredGates: reviewServingRouteParityGates},
  {method: 'POST', productRoute: '/api/articlesreviewshuman', requiredGates: reviewServingRouteParityGates},
  {method: 'POST', productRoute: '/api/articlesreviewsboth', requiredGates: reviewServingRouteParityGates},
  {method: 'POST', productRoute: '/api/articlesreviewsunassessed', requiredGates: reviewServingRouteParityGates},
  {method: 'GET', productRoute: '/api/articlesreviewsfilters', requiredGates: reviewServingRouteParityGates},
  {method: 'GET', productRoute: '/api/articlesreviewshumanfilters', requiredGates: reviewServingRouteParityGates},
  {method: 'POST', productRoute: '/api/projectsreview', requiredGates: reviewServingRouteParityGates},
  {method: 'POST', productRoute: '/api/projectsreviewswarnings', requiredGates: reviewServingRouteParityGates},
  {method: 'POST', productRoute: '/api/projectsreviewshealth', requiredGates: reviewServingRouteParityGates},
  {
    method: 'GET',
    productRoute: '/api/projects/:id/prompts/:promptId/preview',
    requiredGates: reviewServingRouteParityGates,
  },
] as const

export const reviewServingJobParityCoverage = [
  {method: 'POST', productRoute: '/api/articles/pdf-fetch-by-filter', requiredGates: reviewServingJobParityGates},
  {method: 'POST', productRoute: '/api/projects/add_articles_by_filter', requiredGates: reviewServingJobParityGates},
  {method: 'POST', productRoute: '/api/projects/add_articles_by_ids', requiredGates: reviewServingJobParityGates},
  {method: 'POST', productRoute: '/api/articles/pdf-fetch-by-project', requiredGates: reviewServingJobParityGates},
  {method: 'POST', productRoute: '/api/articles/pdf-fetch-bulk', requiredGates: reviewServingJobParityGates},
  {method: 'POST', productRoute: '/api/projects/:id/export', requiredGates: reviewServingJobParityGates},
] as const
