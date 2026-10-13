export const getImportedFileImportRoute = (title: string) => {
  return `imported-file:${title.trim()}`
}

export const isImportedFileRoute = (route: string | null | undefined) => {
  const routeValue = route ?? ''
  return routeValue.startsWith('imported-file:') || routeValue.startsWith('structured-file:')
}

export type ImportRouteGroupKey = 'dataSource' | 'covidence' | 'file' | 'other'

export type ImportRouteGroup<Route extends {route: string}> = {key: ImportRouteGroupKey; label: string; routes: Route[]}

const importRouteGroupMatchers: Array<{key: ImportRouteGroupKey; matches: (route: string) => boolean}> = [
  {
    key: 'dataSource',
    matches: (route) => {
      return route.startsWith('/api/datasources/import/')
    },
  },
  {
    key: 'covidence',
    matches: (route) => {
      return route.startsWith('covidence:')
    },
  },
  {key: 'file', matches: isImportedFileRoute},
]

export const importRouteGroupLabels: Record<ImportRouteGroupKey, string> = {
  covidence: 'Covidence imports',
  dataSource: 'Data source imports',
  file: 'File imports',
  other: 'Other imports',
}

const importRouteGroupOrder: ImportRouteGroupKey[] = ['dataSource', 'covidence', 'file', 'other']

export const getImportRouteGroupKey = (route: string | null | undefined): ImportRouteGroupKey => {
  const routeValue = route ?? ''
  return (
    importRouteGroupMatchers.find((matcher) => {
      return matcher.matches(routeValue)
    })?.key ?? 'other'
  )
}

export const groupImportRoutes = <Route extends {route: string}>(routes: Route[]): ImportRouteGroup<Route>[] => {
  return importRouteGroupOrder
    .map((key) => {
      return {
        key,
        label: importRouteGroupLabels[key],
        routes: routes.filter((route) => {
          return getImportRouteGroupKey(route.route) === key
        }),
      }
    })
    .filter((group) => {
      return group.routes.length > 0
    })
}
