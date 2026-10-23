const supportedTrackingImportRoutes = new Set([
  '/api/datasources/import/pubmed',
  '/api/datasources/import/europe-pmc-ppr',
])

export const isTrackingSupportedRoute = (importRoute: string | null | undefined) => {
  return Boolean(importRoute && supportedTrackingImportRoutes.has(importRoute))
}

export const assertTrackingCanBeEnabled = (params: {
  dateFrom: Date | null
  importRoute: string | null
  trackingEnabled: boolean
}) => {
  if (!params.trackingEnabled) {
    return
  }

  if (!isTrackingSupportedRoute(params.importRoute)) {
    throw new Error('Continuous tracking is only supported for PubMed and Europe PMC PPR data sources')
  }

  if (!params.dateFrom) {
    throw new Error('Continuous tracking requires a start date')
  }
}
