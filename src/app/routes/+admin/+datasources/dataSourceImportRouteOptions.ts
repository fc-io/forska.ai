type BuiltInImportRouteOption = {label: string; value: string}

export const builtInImportRouteOptions: BuiltInImportRouteOption[] = [
  {label: 'arXiv', value: '/api/datasources/import/arxiv'},
  {label: 'bioRxiv', value: '/api/datasources/import/biorxiv'},
  {label: 'medRxiv', value: '/api/datasources/import/medrxiv'},
  {label: 'Europe PMC PPR', value: '/api/datasources/import/europe-pmc-ppr'},
  {label: 'Europe PMC SRC:MED', value: '/api/datasources/import/pubmed'},
]

const builtInImportRoutes = new Set(
  builtInImportRouteOptions.map((option) => {
    return option.value
  }),
)

export const customImportRoutePlaceholder =
  'Custom route, e.g. fhir:sample-bulk-fhir-datasets-100-patients or /api/datasources/import/my-route'

export const getBuiltInImportRouteValue = (importRoute: string | null | undefined) => {
  return importRoute && builtInImportRoutes.has(importRoute) ? importRoute : ''
}

export const getCustomImportRouteValue = (importRoute: string | null | undefined) => {
  return importRoute && !builtInImportRoutes.has(importRoute) ? importRoute : ''
}

export const getResolvedImportRoute = (params: {customImportRoute: string; selectedBuiltInImportRoute: string}) => {
  const customImportRoute = params.customImportRoute.trim()
  const selectedBuiltInImportRoute = params.selectedBuiltInImportRoute.trim()

  return customImportRoute || selectedBuiltInImportRoute || null
}
