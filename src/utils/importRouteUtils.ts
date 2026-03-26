export const getImportedFileImportRoute = (title: string) => {
  return `imported-file:${title.trim()}`
}

export const isImportedFileRoute = (route: string | null | undefined) => {
  const routeValue = route ?? ''
  return routeValue.startsWith('imported-file:') || routeValue.startsWith('structured-file:')
}
