type ResidualReadWorkloadClass = 'foreground-detail' | 'foreground-diagnostic' | 'foreground-metadata'

type ResidualReadClassification = {
  cap: string
  marker: string
  migrationTarget: string
  purpose: string
  workloadClass: ResidualReadWorkloadClass
}

const sourceRead = (classification: ResidualReadClassification) => {
  return classification
}

export const appQueryServiceResidualReadClassifications = [
  {
    method: 'getReviewHydrationRows',
    serviceFile: 'src/server/services/appQueryServiceCore.ts',
    sourceReads: [
      sourceRead({
        cap: 'explicit articleIds only; zero rows for empty input; project scope joins limited to requested articleIds',
        marker: 'const getReviewHydrationRows = (database: AppQueryDatabaseService)',
        migrationTarget: 'review detail article hydration should move to keyed V4 display/detail payload contracts',
        purpose: 'hydrate a requested review-detail article with canonical and selected-import metadata',
        workloadClass: 'foreground-detail',
      }),
    ],
  },
  {
    method: 'getFullArticlesByIds',
    serviceFile: 'src/server/services/appQueryServiceCore.ts',
    sourceReads: [
      sourceRead({
        cap: 'explicit articleIds only; zero rows for empty input; optional full text controlled by caller',
        marker: 'const getFullArticlesByIds = (database: AppQueryDatabaseService)',
        migrationTarget: 'detail hydration should consume keyed V4 article display/fulltext payloads',
        purpose: 'hydrate explicitly requested article records for detail and article detail routes',
        workloadClass: 'foreground-detail',
      }),
    ],
  },
  {
    method: 'getProjectReviewConfig',
    serviceFile: 'src/server/services/appQueryServiceCore.ts',
    sourceReads: [
      sourceRead({
        cap: 'single project row plus project import-route rows for one projectId',
        marker: 'const getProjectReviewConfig = (database: AppQueryDatabaseService)',
        migrationTarget: 'project review configuration should be read from V4 review config identity/detail contracts',
        purpose: 'read project review settings needed to interpret serving rows and create bounded jobs',
        workloadClass: 'foreground-metadata',
      }),
    ],
  },
  {
    method: 'getProjectPromptRows',
    serviceFile: 'src/server/services/appQueryServiceCore.ts',
    sourceReads: [
      sourceRead({
        cap: 'enabled prompt rows for one projectId ordered by prompt order',
        marker: 'const getProjectPromptRows = (database: AppQueryDatabaseService)',
        migrationTarget: 'project prompts should be carried in V4 prompt/config payload contracts',
        purpose: 'read enabled prompt metadata for review filters and detail placeholders',
        workloadClass: 'foreground-metadata',
      }),
    ],
  },
] as const

export const reviewServingResidualReadAllowlist = [
  {
    classification: 'boundedProjectPromptMetadata',
    sourceReads: [
      sourceRead({
        cap: 'enabled prompt rows for one projectId via appQueryServiceCore.getProjectPromptRows',
        marker: 'getProjectPromptRows(query.projectId)',
        migrationTarget: 'V4 filter option contracts should include prompt display metadata needed by the filter UI',
        purpose: 'attach enabled project prompt labels to V4 filter results',
        workloadClass: 'foreground-metadata',
      }),
    ],
    routeFile: 'src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsFilters.ts',
  },
  {
    classification: 'boundedProjectPromptAndConfigMetadata',
    sourceReads: [
      sourceRead({
        cap: 'single project config row plus route IDs for one projectId via appQueryServiceCore.getProjectReviewConfig',
        marker: 'getProjectReviewConfig(query.projectId)',
        migrationTarget: 'V4 human filter contracts should expose the review config identity they require',
        purpose: 'read project review settings needed to interpret human-review filter results',
        workloadClass: 'foreground-metadata',
      }),
      sourceRead({
        cap: 'enabled prompt rows for one projectId via appQueryServiceCore.getProjectPromptRows',
        marker: 'getProjectPromptRows(query.projectId)',
        migrationTarget: 'V4 human filter contracts should include prompt display metadata needed by the filter UI',
        purpose: 'attach enabled project prompt labels to V4 human filter results',
        workloadClass: 'foreground-metadata',
      }),
    ],
    routeFile: 'src/server/routes/projectsRoutes/projectsRoutesGetArticlesReviewsHumanFilters.ts',
  },
  {
    classification: 'boundedReviewHealthDiagnostics',
    sourceReads: [
      sourceRead({
        cap: 'COUNT enabled prompts for one projectId',
        marker: 'FROM app.project_prompt',
        migrationTarget: 'V4 readiness diagnostics should expose enabled prompt count for the active config hash',
        purpose: 'diagnose whether review indexing is needed for a project',
        workloadClass: 'foreground-diagnostic',
      }),
      sourceRead({
        cap: 'existence probe with LIMIT 1 for one projectId',
        marker: 'FROM app.project_article',
        migrationTarget: 'V4 readiness diagnostics should expose project-scope article presence',
        purpose: 'diagnose whether curated articles exist before checking route scope',
        workloadClass: 'foreground-diagnostic',
      }),
      sourceRead({
        cap: 'route-scope existence probe with LIMIT 1 for one projectId',
        marker: 'FROM app.project_import_route',
        migrationTarget: 'V4 readiness diagnostics should expose route-scope article presence',
        purpose: 'diagnose whether import-route scoped articles exist when curated scope is empty',
        workloadClass: 'foreground-diagnostic',
      }),
    ],
    routeFile: 'src/server/routes/projectsRoutes/projectsRoutesGetReviewsHealth.ts',
  },
  {
    classification: 'boundedReviewWarningDiagnostics',
    sourceReads: [
      sourceRead({
        cap: 'COUNT enabled non-archived prompts for one projectId',
        marker: 'FROM app.project_prompt project_prompt',
        migrationTarget: 'V4 warning diagnostics should expose enabled prompt count for the active config hash',
        purpose: 'diagnose whether review indexing is needed for warning status',
        workloadClass: 'foreground-diagnostic',
      }),
      sourceRead({
        cap: 'existence probe with LIMIT 1 over one project scope',
        marker: 'FROM app.project_article pa',
        migrationTarget: 'V4 warning diagnostics should expose article-scope presence without source-table probing',
        purpose: 'diagnose whether a project has any articles in review scope',
        workloadClass: 'foreground-diagnostic',
      }),
      sourceRead({
        cap: 'route-scope half of a LIMIT 1 article-scope existence probe for one projectId',
        marker: 'FROM app.project_import_route pir',
        migrationTarget: 'V4 warning diagnostics should expose route-scope article presence',
        purpose: 'diagnose whether import-route scoped articles exist for warning status',
        workloadClass: 'foreground-diagnostic',
      }),
      sourceRead({
        cap: 'project-scoped V4 diagnostic summary repository call',
        marker: 'getReviewServingDiagnostics({projectId',
        migrationTarget: 'keep as V4 diagnostics source and stop mixing with legacy mart state in route code',
        purpose: 'read V4 serving diagnostics and manifest readiness for the warning payload',
        workloadClass: 'foreground-diagnostic',
      }),
    ],
    routeFile: 'src/server/routes/projectsRoutes/projectsRoutesGetReviewsWarnings.ts',
  },
  {
    classification: 'boundedReviewDetailMetadata',
    sourceReads: [
      sourceRead({
        cap: 'project prompt rows for one projectId',
        marker: 'FROM app.project_prompt pp',
        migrationTarget: 'review detail should read prompt ordering and placeholder metadata from V4 prompt payloads',
        purpose: 'hydrate prompt order, enablement, and placeholder metadata for the requested detail page',
        workloadClass: 'foreground-detail',
      }),
      sourceRead({
        cap: 'single project config row plus route IDs via appQueryServiceCore.getProjectReviewConfig',
        marker: 'getAppQueryService().getProjectReviewConfig(projectId)',
        migrationTarget: 'review detail should read project review config from V4 config/detail payloads',
        purpose: 'interpret detail judgment and summary state for the requested project',
        workloadClass: 'foreground-metadata',
      }),
      sourceRead({
        cap: 'snapshot project IDs referenced by the single-article detail payload',
        marker: 'FROM app.project',
        migrationTarget: 'snapshot project names should move to keyed detail payloads',
        purpose: 'hydrate project display names for snapshot judgments in review detail',
        workloadClass: 'foreground-metadata',
      }),
    ],
    routeFile: 'src/server/routes/projectsRoutes/projectsRoutesPostArticleReviewDetails.ts',
  },
  {
    classification: 'boundedPromptPreviewMetadata',
    sourceReads: [
      sourceRead({
        cap: 'single project row for one projectId',
        marker: 'FROM app.project',
        migrationTarget: 'prompt preview should read project content settings from V4 review config payloads',
        purpose: 'read project model and content settings needed to render the preview prompt',
        workloadClass: 'foreground-metadata',
      }),
      sourceRead({
        cap: 'single enabled prompt row for one projectId and promptId',
        marker: 'FROM app.project_prompt pp',
        migrationTarget: 'prompt preview should read prompt text from V4 prompt/config payloads',
        purpose: 'read the selected enabled prompt text for preview rendering',
        workloadClass: 'foreground-metadata',
      }),
      sourceRead({
        cap: 'single model row for the project modelId',
        marker: 'FROM app.model m',
        migrationTarget: 'prompt preview should read model display/provider metadata from V4 config payloads',
        purpose: 'read model provider metadata needed for token budgeting and prompt formatting',
        workloadClass: 'foreground-metadata',
      }),
    ],
    routeFile: 'src/server/routes/projectsRoutes/projectsRoutesGetPromptPreview.ts',
  },
  {
    classification: 'boundedArticleDetailHydration',
    sourceReads: [
      sourceRead({
        cap: 'single explicit articleId via appQueryServiceCore.getFullArticlesByIds',
        marker: 'getFullArticlesByIds([id])',
        migrationTarget:
          'article detail should use keyed V4 article/detail payloads or remain outside review foreground flow',
        purpose: 'hydrate the requested article detail record',
        workloadClass: 'foreground-detail',
      }),
      sourceRead({
        cap: 'one articleId, ordered judgment history for that article only',
        marker: 'FROM app.judgment j',
        migrationTarget: 'article judgment history should move to keyed detail/history contracts',
        purpose: 'hydrate judgment history for a single article detail page',
        workloadClass: 'foreground-detail',
      }),
      sourceRead({
        cap: 'snapshot project IDs referenced by the single-article judgment payload',
        marker: 'FROM app.project',
        migrationTarget: 'snapshot project display names should move to detail/history payloads',
        purpose: 'hydrate project display names for snapshot judgments in article detail',
        workloadClass: 'foreground-metadata',
      }),
    ],
    routeFile: 'src/server/routes/ArticlesRoutes.ts',
  },
] as const

export const getReviewServingResidualReadMarkers = (entry: (typeof reviewServingResidualReadAllowlist)[number]) => {
  return entry.sourceReads.map((read) => {
    return read.marker
  })
}

export const reviewServingResidualReadAuditedRouteFiles = reviewServingResidualReadAllowlist.map((entry) => {
  return entry.routeFile
})
