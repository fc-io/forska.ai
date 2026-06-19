export const reviewServingResidualReadAllowlist = [
  {
    classification: 'boundedProjectPromptMetadata',
    allowedMarkers: ['getProjectPromptRows(query.projectId)'],
    routeFile: 'src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsFilters.ts',
  },
  {
    classification: 'boundedProjectPromptAndConfigMetadata',
    allowedMarkers: ['getProjectReviewConfig(query.projectId)', 'getProjectPromptRows(query.projectId)'],
    routeFile: 'src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHumanFilters.ts',
  },
  {
    classification: 'boundedReviewHealthDiagnostics',
    allowedMarkers: ['FROM app.project_prompt', 'FROM app.project_article', 'FROM app.project_import_route'],
    routeFile: 'src/server/routes/projectsRoutes/projectsRoutesGetReviewsHealth.ts',
  },
  {
    classification: 'boundedReviewWarningDiagnostics',
    allowedMarkers: [
      'FROM app.project_prompt',
      'FROM app.project_article',
      'FROM app.project_mart_refresh_state',
      'FROM app.project_mart_large_rebuild_state',
      'INNER JOIN app.judgment judgment',
    ],
    routeFile: 'src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts',
  },
  {
    classification: 'boundedReviewDetailMetadata',
    allowedMarkers: [
      'FROM app.prompt',
      'FROM app.model',
      'getFullArticlesByIds([articleId]',
      'FROM app.judgment j',
      'FROM app.judgment_assessment',
    ],
    routeFile: 'src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts',
  },
  {
    classification: 'boundedPromptPreviewMetadataAndSampleArticle',
    allowedMarkers: [
      'FROM app.project_article project_article',
      'FROM app.project',
      'FROM app.project_prompt pp',
      'FROM app.model m',
      'getFullArticlesByIds([firstArticleId]',
    ],
    routeFile: 'src/server/routes/projectsRoutes/projectsRoutesGetPromptPreview.ts',
  },
] as const

export const reviewServingResidualReadAuditedRouteFiles = reviewServingResidualReadAllowlist.map((entry) => {
  return entry.routeFile
})
