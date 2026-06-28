export const comparisonProjectServingRouteContracts = [
  {
    handling: 'owner-source-metadata',
    method: 'GET',
    migrationTarget: 'comparison project metadata can stay owner-routed; row/detail reads must stay in serving helpers',
    routePath: '/api/comparison-projects',
  },
  {
    handling: 'owner-source-metadata',
    method: 'GET',
    migrationTarget: 'archived comparison project metadata can stay owner-routed',
    routePath: '/api/comparison-projects/archived',
  },
  {
    handling: 'owner-source-metadata',
    method: 'GET',
    migrationTarget: 'source-project selection metadata can stay owner-routed',
    routePath: '/api/comparison-projects/sources',
  },
  {
    handling: 'owner-source-metadata',
    method: 'GET',
    migrationTarget: 'conflict-resolution import source metadata can stay owner-routed',
    routePath: '/api/comparison-projects/conflict-resolution-import-sources',
  },
  {
    handling: 'owner-source-validation',
    method: 'POST',
    migrationTarget:
      'preview source validation stays owner-routed; target article matching remains the next source-read cleanup',
    routePath: '/api/comparison-projects/conflict-resolution-import-preview',
  },
  {
    handling: 'owner-write-plus-serving-rebuild',
    method: 'POST',
    migrationTarget: 'comparison creation writes source config and queues comparison serving rebuild',
    routePath: '/api/comparison-projects/from-project',
  },
  {
    handling: 'owner-source-metadata',
    method: 'GET',
    migrationTarget: 'edit metadata can stay owner-routed; no judgment row reads belong here',
    routePath: '/api/comparison-projects/:id/edit',
  },
  {
    handling: 'serving-read',
    method: 'GET',
    migrationTarget: 'stats must keep failing closed without active comparison serving generation',
    routePath: '/api/comparison-projects/:id/stats',
    servingContract: 'comparison.stats.activeGeneration',
  },
  {
    handling: 'owner-source-metadata-plus-serving-status',
    method: 'GET',
    migrationTarget: 'detail metadata can stay owner-routed; rows/counts/export stay serving-backed',
    routePath: '/api/comparison-projects/:id',
  },
  {
    handling: 'serving-read',
    method: 'POST',
    migrationTarget: 'judgment rows must read active comparison serving article/cell/member rows only',
    routePath: '/api/comparison-projects/:id/judgments',
    servingContract: 'comparison.judgmentRows.activeGeneration',
  },
  {
    handling: 'serving-read',
    method: 'POST',
    migrationTarget: 'judgment count must read active comparison serving state only',
    routePath: '/api/comparison-projects/:id/judgments/count',
    servingContract: 'comparison.judgmentCount.activeGeneration',
  },
  {
    handling: 'owner-write-plus-serving-rebuild',
    method: 'POST',
    migrationTarget: 'resolution writes stay owner-routed and invalidate comparison serving',
    routePath: '/api/comparison-projects/:id/conflict-resolution',
  },
  {
    handling: 'owner-write-plus-serving-rebuild',
    method: 'POST',
    migrationTarget: 'resolution reset stays owner-routed and invalidates comparison serving',
    routePath: '/api/comparison-projects/:id/conflict-resolution/reset',
  },
  {
    handling: 'serving-read',
    method: 'POST',
    migrationTarget: 'resolution export must read article identity/identifiers from active comparison serving state',
    routePath: '/api/comparison-projects/:id/conflict-resolutions/export',
    servingContract: 'comparison.conflictResolutionExport.activeGeneration',
  },
  {
    handling: 'owner-source-validation',
    method: 'POST',
    migrationTarget:
      'import analysis still needs target article matching source reads until comparison serving owns match keys',
    routePath: '/api/comparison-projects/:id/conflict-resolutions/import/analyze',
  },
  {
    handling: 'owner-write-plus-serving-rebuild',
    method: 'POST',
    migrationTarget: 'import commit writes resolutions and queues comparison serving rebuild',
    routePath: '/api/comparison-projects/:id/conflict-resolutions/import/commit',
  },
  {
    handling: 'serving-read',
    method: 'POST',
    migrationTarget: 'normal export must iterate active comparison serving rows only',
    routePath: '/api/comparison-projects/:id/export',
    servingContract: 'comparison.export.activeGeneration',
  },
  {
    handling: 'owner-write-plus-serving-rebuild',
    method: 'POST',
    migrationTarget: 'comparison creation writes source config and queues comparison serving rebuild',
    routePath: '/api/comparison-projects',
  },
  {
    handling: 'owner-write-plus-serving-rebuild',
    method: 'PATCH',
    migrationTarget: 'comparison updates stay owner-routed and queue comparison serving rebuild',
    routePath: '/api/comparison-projects/:id',
  },
  {
    handling: 'owner-write-plus-serving-cleanup',
    method: 'DELETE',
    migrationTarget: 'comparison delete stays owner-routed and cleans comparison serving state',
    routePath: '/api/comparison-projects/:id',
  },
  {
    handling: 'owner-write-plus-serving-rebuild',
    method: 'POST',
    migrationTarget: 'comparison unarchive stays owner-routed and queues comparison serving rebuild',
    routePath: '/api/comparison-projects/:id/unarchive',
  },
] as const satisfies readonly {
  handling:
    | 'owner-source-metadata'
    | 'owner-source-metadata-plus-serving-status'
    | 'owner-source-validation'
    | 'owner-write-plus-serving-cleanup'
    | 'owner-write-plus-serving-rebuild'
    | 'serving-read'
  method: 'DELETE' | 'GET' | 'PATCH' | 'POST'
  migrationTarget: string
  routePath: string
  servingContract?: string
}[]

export type ComparisonProjectServingRouteContract = (typeof comparisonProjectServingRouteContracts)[number]

export const getComparisonProjectServingRouteContractKey = (entry: ComparisonProjectServingRouteContract) => {
  return `${entry.method} ${entry.routePath}`
}
