import {HttpError} from '../utils/httpError.ts'
import {getAppDatabaseService} from './appDatabaseService.ts'
import {getSqlLiteral} from './appQueryHelpers.ts'

type CovidenceBaseImportRouteQueryRunner = {queryJson: <TRow>(statement: string) => Promise<TRow[]>}

export const covidenceImportRouteValuePrefix = 'covidence:'

export const isCovidenceBaseImportRouteValue = (value: unknown): value is string => {
  return (
    typeof value === 'string'
    && value.startsWith(covidenceImportRouteValuePrefix)
    && value.length > covidenceImportRouteValuePrefix.length
  )
}

const getCovidenceImportRouteId = async (params: {importRoute: string; tx?: CovidenceBaseImportRouteQueryRunner}) => {
  const [row] = await (params.tx ?? getAppDatabaseService()).queryJson<{id: string}>(`
    SELECT id
    FROM app.import_route
    WHERE route = ${getSqlLiteral(params.importRoute)}
    LIMIT 1
  `)

  return row?.id ?? null
}

export const getRequiredCovidenceBaseImportRouteId = async (params: {
  baseImportRoute: string
  importRoute?: string | null
  tx?: CovidenceBaseImportRouteQueryRunner
}) => {
  const baseImportRoute: unknown = params.baseImportRoute

  if (!isCovidenceBaseImportRouteValue(baseImportRoute)) {
    throw new HttpError(
      400,
      `Base import route must be an existing covidence:<id> route, got ${JSON.stringify(baseImportRoute)}`,
    )
  }

  if (params.baseImportRoute === params.importRoute) {
    throw new HttpError(400, 'Base import route must differ from the imported route')
  }

  const baseImportRouteId = await getCovidenceImportRouteId({importRoute: params.baseImportRoute, tx: params.tx})

  if (!baseImportRouteId) {
    throw new HttpError(400, `Base import route '${params.baseImportRoute}' does not exist`)
  }

  return baseImportRouteId
}
