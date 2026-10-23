export const hasMutableDataSourceChanges = (body: {
  title?: string
  description?: string | null
  importRoute?: string | null
  dateFrom?: string | null
  dateTo?: string | null
  archived?: boolean
}) => {
  return [body.title, body.description, body.importRoute, body.dateFrom, body.dateTo].some((value) => {
    return value !== undefined
  })
}
